import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  buildSystemPrompt: vi.fn(async () => "SYS"),
  memoryStoreInstances: [] as any[],
  memoryIndexerInstances: [] as any[],
  cronSchedulerInstances: [] as any[],
  createAgentSession: vi.fn(),
  createMemoryTools: vi.fn(() => [{ name: "memory_tool" }]),
  createCronTools: vi.fn(() => [{ name: "cron_tool" }]),
  createSttTool: vi.fn(() => ({ name: "stt_tool" })),
  createTtsTool: vi.fn(() => ({ name: "tts_tool" })),
  getModel: vi.fn(() => ({ id: "model" })),
  setRuntimeApiKey: vi.fn(),
}));

vi.mock("./system-prompt.js", () => ({
  buildSystemPrompt: mockState.buildSystemPrompt,
}));

vi.mock("./memory/store.js", () => ({
  MemoryStore: class {
    public readonly init = vi.fn();
    public readonly close = vi.fn();
    constructor(..._args: unknown[]) {
      mockState.memoryStoreInstances.push(this);
    }
  },
}));

vi.mock("./memory/embeddings.js", () => ({
  OpenAIEmbeddingClient: class {
    public readonly embed = vi.fn(async () => [0.1, 0.2, 0.3]);
  },
}));

vi.mock("./memory/search.js", () => ({
  MemorySearchService: class {},
}));

vi.mock("./memory/indexer.js", () => ({
  MemoryIndexer: class {
    public readonly start = vi.fn(async () => {});
    public readonly reindexAll = vi.fn(async () => {});
    public readonly stop = vi.fn();
    constructor(..._args: unknown[]) {
      mockState.memoryIndexerInstances.push(this);
    }
  },
}));

vi.mock("./cron/store.js", () => ({
  CronStore: class {},
}));

vi.mock("./cron/scheduler.js", () => ({
  CronScheduler: class {
    public readonly init = vi.fn(async () => {});
    public readonly shutdown = vi.fn(async () => {});
    public readonly list = vi.fn(() => [{ id: "job-1" }]);
    public readonly add = vi.fn();
    public readonly remove = vi.fn();
    public readonly onFire: (job: { userId: string; task: string; name?: string }) => Promise<void>;
    constructor(_store: unknown, onFire: (job: { userId: string; task: string; name?: string }) => Promise<void>) {
      this.onFire = onFire;
      mockState.cronSchedulerInstances.push(this);
    }
  },
}));

vi.mock("./tools/memory.js", () => ({
  createMemoryTools: mockState.createMemoryTools,
}));

vi.mock("./tools/cron.js", () => ({
  createCronTools: mockState.createCronTools,
}));

vi.mock("./tools/stt.js", () => ({
  createSttTool: mockState.createSttTool,
}));

vi.mock("./tools/tts.js", () => ({
  createTtsTool: mockState.createTtsTool,
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: mockState.getModel,
}));

vi.mock("@mariozechner/pi-coding-agent", () => {
  class AuthStorage {
    static create() {
      return {
        setRuntimeApiKey: mockState.setRuntimeApiKey,
      };
    }
  }

  class ModelRegistry {
    constructor(..._args: unknown[]) {}
  }

  return {
    AuthStorage,
    ModelRegistry,
    SessionManager: {
      continueRecent: vi.fn(() => ({ kind: "manager" })),
    },
    createExtensionRuntime: vi.fn(() => ({ runtime: true })),
    createCodingTools: vi.fn(() => [{ name: "coding" }]),
    createAgentSession: mockState.createAgentSession,
  };
});

import { AgentHarness } from "./agent.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    llm: { provider: "anthropic", model: "claude", apiKey: "llm-key", thinkingLevel: "high" as const },
    embedding: { provider: "openai" as const, model: "text-embedding-3-small", apiKey: "embed-key", dimensions: 3 },
    tts: { provider: "openai" as const, apiKey: "tts-key", outputDir: "/tmp/audio" },
    stt: { provider: "openai" as const, apiKey: "stt-key" },
    server: { port: 3000 },
    workspace: "/tmp/workspace",
    sessions: "/tmp/sessions",
    memory: { dbPath: "/tmp/sessions/memory.db", watch: true, watchIntervalMs: 1000 },
    cron: { storePath: "/tmp/sessions/cron-jobs.json" },
    ...overrides,
  };
}

function makeSession() {
  const subscribers = new Set<(event: unknown) => void>();

  const session = {
    state: {
      messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
    },
    prompt: vi.fn(async (text: string) => {
      subscribers.forEach((fn) =>
        fn({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "D" },
        }),
      );

      session.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `Final:${text}` }],
      });
    }),
    subscribe: vi.fn((fn: (event: unknown) => void) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }),
  };

  return session;
}

describe("AgentHarness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.memoryStoreInstances.splice(0);
    mockState.memoryIndexerInstances.splice(0);
    mockState.cronSchedulerInstances.splice(0);

    mockState.createAgentSession.mockImplementation(async () => ({ session: makeSession() }));
  });

  it("constructs dependencies and initializes with memory indexing", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    expect(mockState.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "llm-key");
    expect(mockState.buildSystemPrompt).toHaveBeenCalledWith("/tmp/workspace");
    expect(mockState.memoryStoreInstances[0].init).toHaveBeenCalled();
    expect(mockState.memoryIndexerInstances[0].start).toHaveBeenCalled();
    expect(mockState.cronSchedulerInstances[0].init).toHaveBeenCalled();
    expect(mockState.createSttTool).toHaveBeenCalled();
    expect(mockState.createTtsTool).toHaveBeenCalled();
  });

  it("warns and skips indexing when embedding API key is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = new AgentHarness(
      makeConfig({ embedding: { provider: "openai", model: "m", dimensions: 3, apiKey: undefined } }) as never,
    );

    await harness.init();

    expect(mockState.memoryIndexerInstances[0].start).not.toHaveBeenCalled();
    expect(mockState.memoryIndexerInstances[0].reindexAll).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[memory] OPENAI_API_KEY missing, memory indexing disabled");
  });

  it("prompts users and returns extracted assistant text", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    const out = await harness.prompt("user-1", "hello");
    expect(out).toBe("Final:hello");
    expect(mockState.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("builds audio prompts and streams deltas + done text", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    const text = await harness.prompt("user-audio", "question", "/tmp/input.wav");
    expect(text).toContain("An audio file was uploaded at: /tmp/input.wav");

    const onDelta = vi.fn();
    const onDone = vi.fn();

    await harness.promptStream("user-stream", "stream me", { onDelta, onDone });

    expect(onDelta).toHaveBeenCalledWith("D");
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining("Final:stream me"));
  });

  it("lists cron jobs and executes scheduled fire callback via prompt", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    expect(harness.listCronJobs("u1")).toEqual([{ id: "job-1" }]);

    const promptSpy = vi.spyOn(harness, "prompt").mockResolvedValue("ok");
    await mockState.cronSchedulerInstances[0].onFire({ userId: "u1", task: "task", name: "daily" });

    expect(promptSpy).toHaveBeenCalledWith("u1", "[Scheduled task: daily] task");
  });

  it("shuts down all managed resources", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    await harness.shutdown();

    expect(mockState.memoryIndexerInstances[0].stop).toHaveBeenCalled();
    expect(mockState.cronSchedulerInstances[0].shutdown).toHaveBeenCalled();
    expect(mockState.memoryStoreInstances[0].close).toHaveBeenCalled();
  });

  it("throws on unknown model lookup", async () => {
    mockState.getModel.mockReturnValueOnce(undefined);

    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    await expect(harness.prompt("u", "hello")).rejects.toThrow("Unknown model anthropic/claude");
  });
});

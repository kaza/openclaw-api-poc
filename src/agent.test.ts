import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  buildSystemPrompt: vi.fn(async () => "SYS"),
  memoryStoreInstances: [] as any[],
  memoryIndexerInstances: [] as any[],
  cronStoreInstances: [] as any[],
  cronSchedulerInstances: [] as any[],
  createAgentSession: vi.fn(),
  createMemoryTools: vi.fn(() => [{ name: "memory_tool" }]),
  createCronTools: vi.fn(() => [{ name: "cron_tool" }]),
  createSttTool: vi.fn(() => ({ name: "stt_tool" })),
  createTtsTool: vi.fn((config: { tts: { outputDir?: string } }) => ({ name: `tts_${config.tts.outputDir}` })),
  getModel: vi.fn(() => ({ id: "model" })),
  setRuntimeApiKey: vi.fn(),
  continueRecent: vi.fn(() => ({ kind: "manager" })),
}));

vi.mock("./system-prompt.js", () => ({
  buildSystemPrompt: mockState.buildSystemPrompt,
}));

vi.mock("./memory/store.js", () => ({
  MemoryStore: class {
    public readonly dbPath: string;
    public readonly init = vi.fn();
    public readonly close = vi.fn();
    constructor(dbPath: string) {
      this.dbPath = dbPath;
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
  MemorySearchService: class {
    constructor(..._args: unknown[]) {}
  },
}));

vi.mock("./memory/indexer.js", () => ({
  MemoryIndexer: class {
    public readonly options: unknown;
    public readonly start = vi.fn(async () => {});
    public readonly reindexAll = vi.fn(async () => {});
    public readonly stop = vi.fn();
    constructor(_store: unknown, _embeddings: unknown, options: unknown) {
      this.options = options;
      mockState.memoryIndexerInstances.push(this);
    }
  },
}));

vi.mock("./cron/store.js", () => ({
  CronStore: class {
    public readonly filePath: string;
    constructor(filePath: string) {
      this.filePath = filePath;
      mockState.cronStoreInstances.push(this);
    }
  },
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
      continueRecent: mockState.continueRecent,
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
    memory: { watch: true, watchIntervalMs: 1000 },
    ...overrides,
  };
}

function makeSession() {
  const subscribers = new Set<(event: unknown) => void>();

  const session = {
    state: {
      messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
    },
    dispose: vi.fn(),
    prompt: vi.fn(async (text: string) => {
      subscribers.forEach((fn) =>
        fn({
          type: "message_update",
          assistantMessageEvent: { type: "text_start" },
        }),
      );

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
    mockState.cronStoreInstances.splice(0);
    mockState.cronSchedulerInstances.splice(0);

    mockState.createAgentSession.mockImplementation(async () => ({ session: makeSession() }));
  });

  it("initializes shared dependencies and defers per-user resources", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    expect(mockState.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "llm-key");
    expect(mockState.buildSystemPrompt).toHaveBeenCalledWith("/tmp/workspace");

    expect(mockState.memoryStoreInstances).toHaveLength(0);
    expect(mockState.memoryIndexerInstances).toHaveLength(0);
    expect(mockState.cronSchedulerInstances).toHaveLength(0);

    expect(mockState.createSttTool).toHaveBeenCalledTimes(1);
    expect(mockState.createTtsTool).not.toHaveBeenCalled();
  });

  it("creates isolated per-user directories/resources lazily on first prompt", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    await harness.prompt("user-1", "hello");
    await harness.prompt("user/2", "hi");

    expect(mockState.createAgentSession).toHaveBeenCalledTimes(2);

    expect(mockState.memoryStoreInstances[0].dbPath).toBe("/tmp/sessions/user-1/memory.db");
    expect(mockState.memoryStoreInstances[1].dbPath).toBe("/tmp/sessions/user_2/memory.db");

    expect(mockState.continueRecent).toHaveBeenNthCalledWith(1, "/tmp/workspace", "/tmp/sessions/user-1/session");
    expect(mockState.continueRecent).toHaveBeenNthCalledWith(2, "/tmp/workspace", "/tmp/sessions/user_2/session");

    expect(mockState.cronStoreInstances[0].filePath).toBe("/tmp/sessions/user-1/cron-jobs.json");
    expect(mockState.cronStoreInstances[1].filePath).toBe("/tmp/sessions/user_2/cron-jobs.json");

    expect(mockState.createTtsTool).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tts: expect.objectContaining({ outputDir: "/tmp/sessions/user-1/audio" }),
      }),
    );
    expect(mockState.createTtsTool).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tts: expect.objectContaining({ outputDir: "/tmp/sessions/user_2/audio" }),
      }),
    );

    expect(mockState.memoryIndexerInstances).toHaveLength(2);
    expect(mockState.memoryIndexerInstances[0].start).toHaveBeenCalled();
    expect(mockState.memoryIndexerInstances[1].start).toHaveBeenCalled();
  });

  it("warns and disables per-user memory indexing when embedding API key is missing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = new AgentHarness(
      makeConfig({ embedding: { provider: "openai", model: "m", dimensions: 3, apiKey: undefined } }) as never,
    );

    await harness.init();
    await harness.prompt("u1", "hello");

    expect(mockState.memoryIndexerInstances).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith("[memory] OPENAI_API_KEY missing, memory indexing disabled");
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

  it("lists cron jobs only for initialized users and executes scheduler callbacks", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    expect(harness.listCronJobs("u1")).toEqual([]);

    await harness.prompt("u1", "hello");
    expect(harness.listCronJobs("u1")).toEqual([{ id: "job-1" }]);

    const promptSpy = vi.spyOn(harness, "prompt").mockResolvedValue("ok");
    await mockState.cronSchedulerInstances[0].onFire({ userId: "u1", task: "task", name: "daily" });

    expect(promptSpy).toHaveBeenCalledWith("u1", "[Scheduled task: daily] task");
  });

  it("shuts down all managed per-user resources", async () => {
    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    await harness.prompt("u1", "a");
    await harness.prompt("u2", "b");

    await harness.shutdown();

    for (const indexer of mockState.memoryIndexerInstances) {
      expect(indexer.stop).toHaveBeenCalled();
    }

    for (const scheduler of mockState.cronSchedulerInstances) {
      expect(scheduler.shutdown).toHaveBeenCalled();
    }

    for (const store of mockState.memoryStoreInstances) {
      expect(store.close).toHaveBeenCalled();
    }

    for (const call of mockState.createAgentSession.mock.results) {
      const session = (await call.value).session;
      expect(session.dispose).toHaveBeenCalled();
    }
  });

  it("throws on unknown model lookup", async () => {
    mockState.getModel.mockReturnValueOnce(undefined);

    const harness = new AgentHarness(makeConfig() as never);
    await harness.init();

    await expect(harness.prompt("u", "hello")).rejects.toThrow("Unknown model anthropic/claude");
  });
});

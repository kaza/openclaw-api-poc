import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getModel, type AssistantMessage, type TextContent } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createCodingTools,
  createExtensionRuntime,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResourceLoader,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { HarnessConfig } from "./config.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { OpenAIEmbeddingClient } from "./memory/embeddings.js";
import { MemoryStore } from "./memory/store.js";
import { MemorySearchService } from "./memory/search.js";
import { MemoryIndexer } from "./memory/indexer.js";
import { createMemoryTools } from "./tools/memory.js";
import { createSttTool } from "./tools/stt.js";
import { createTtsTool } from "./tools/tts.js";
import { CronStore } from "./cron/store.js";
import { CronScheduler } from "./cron/scheduler.js";
import { createCronTools } from "./tools/cron.js";
import { buildUserPaths } from "./user-paths.js";

interface UserSessionContext {
  userId: string;
  session: AgentSession;
  queue: Promise<void>;
  memoryStore: MemoryStore;
  memoryIndexer: MemoryIndexer | null;
  cronScheduler: CronScheduler;
}

function extractAssistantText(session: AgentSession): string {
  const messages = session.state.messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;

    const assistant = message as AssistantMessage;
    const text = assistant.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("");

    if (text) return text;
  }

  return "";
}

function buildAudioPrompt(text: string | undefined, audioFilePath: string): string {
  const instruction = `An audio file was uploaded at: ${audioFilePath}. Use the transcribe tool to extract text first, then answer the user.`;
  return text?.trim() ? `${text.trim()}\n\n${instruction}` : instruction;
}

function createStaticResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    getPathMetadata: () => new Map(),
    extendResources: () => {},
    reload: async () => {},
  };
}

function getTextDelta(event: AgentSessionEvent): string | null {
  if (event.type !== "message_update") return null;
  if (event.assistantMessageEvent.type !== "text_delta") return null;
  return event.assistantMessageEvent.delta;
}

export class AgentHarness {
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly embeddingClient: OpenAIEmbeddingClient;
  private readonly userSessions = new Map<string, UserSessionContext>();
  private readonly sessionInit = new Map<string, Promise<UserSessionContext>>();
  private readonly sttTool: ToolDefinition;
  private systemPrompt = "";

  constructor(private readonly config: HarnessConfig) {
    this.authStorage = AuthStorage.create(path.join(config.sessions, "auth.json"));

    if (config.llm.apiKey) this.authStorage.setRuntimeApiKey(config.llm.provider, config.llm.apiKey);

    this.modelRegistry = new ModelRegistry(this.authStorage, path.join(config.sessions, "models.json"));

    this.embeddingClient = new OpenAIEmbeddingClient({
      apiKey: config.embedding.apiKey,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
    });

    this.sttTool = createSttTool(config) as unknown as ToolDefinition;
  }

  async init(): Promise<void> {
    this.systemPrompt = await buildSystemPrompt(this.config.workspace);

    if (!this.config.embedding.apiKey) {
      console.warn("[memory] OPENAI_API_KEY missing, memory indexing disabled");
    }
  }

  async shutdown(): Promise<void> {
    const contexts = new Map(this.userSessions);
    const pending = [...this.sessionInit.values()];
    this.sessionInit.clear();

    const settled = await Promise.allSettled(pending);
    for (const result of settled) {
      if (result.status === "fulfilled") contexts.set(result.value.userId, result.value);
    }

    for (const ctx of contexts.values()) {
      ctx.memoryIndexer?.stop();
      await ctx.cronScheduler.shutdown();
      ctx.memoryStore.close();
      ctx.session.dispose();
    }

    this.userSessions.clear();
  }

  async prompt(userId: string, text: string, audioFilePath?: string): Promise<string> {
    return this.withUserLock(userId, async ({ session }) => {
      const promptText = audioFilePath ? buildAudioPrompt(text, audioFilePath) : text;
      await session.prompt(promptText, { source: "rpc" });
      return extractAssistantText(session);
    });
  }

  async promptStream(
    userId: string,
    text: string,
    handlers: {
      onDelta: (delta: string) => void;
      onDone: (fullText: string) => void;
    },
    audioFilePath?: string,
  ): Promise<void> {
    await this.withUserLock(userId, async ({ session }) => {
      const promptText = audioFilePath ? buildAudioPrompt(text, audioFilePath) : text;

      const unsubscribe = session.subscribe((event) => {
        const delta = getTextDelta(event);
        if (delta !== null) handlers.onDelta(delta);
      });

      try {
        await session.prompt(promptText, { source: "rpc" });
      } finally {
        unsubscribe();
      }

      handlers.onDone(extractAssistantText(session));
    });
  }

  listCronJobs(userId: string) {
    const session = this.userSessions.get(userId);
    if (!session) return [];
    return session.cronScheduler.list(userId);
  }

  private async withUserLock<T>(userId: string, run: (ctx: UserSessionContext) => Promise<T>): Promise<T> {
    const ctx = await this.getOrCreateSession(userId);

    const execution = ctx.queue.then(() => run(ctx));
    ctx.queue = execution.then(
      () => undefined,
      () => undefined,
    );

    return execution;
  }

  private async getOrCreateSession(userId: string): Promise<UserSessionContext> {
    const existing = this.userSessions.get(userId);
    if (existing) return existing;

    const pending = this.sessionInit.get(userId);
    if (pending) return pending;

    const creation = this.createSession(userId)
      .then((ctx) => {
        this.userSessions.set(userId, ctx);
        this.sessionInit.delete(userId);
        return ctx;
      })
      .catch((error) => {
        this.sessionInit.delete(userId);
        throw error;
      });

    this.sessionInit.set(userId, creation);
    return creation;
  }

  private async createSession(userId: string): Promise<UserSessionContext> {
    const paths = buildUserPaths(this.config.sessions, userId);

    await mkdir(paths.rootDir, { recursive: true });
    await mkdir(paths.sessionDir, { recursive: true });
    await mkdir(paths.audioDir, { recursive: true });
    await mkdir(paths.uploadsDir, { recursive: true });

    const model = getModel(this.config.llm.provider as never, this.config.llm.model as never);
    if (!model) {
      throw new Error(`Unknown model ${this.config.llm.provider}/${this.config.llm.model}`);
    }

    const memoryStore = new MemoryStore(paths.memoryDbPath, this.config.embedding.dimensions ?? 1536);
    memoryStore.init();

    const memorySearch = new MemorySearchService(memoryStore, this.embeddingClient);
    const memoryIndexer = this.config.embedding.apiKey
      ? new MemoryIndexer(memoryStore, this.embeddingClient, {
          workspaceDir: this.config.workspace,
          watchIntervalMs: this.config.memory?.watchIntervalMs ?? 10_000,
        })
      : null;

    const cronStore = new CronStore(paths.cronStorePath);
    const cronScheduler = new CronScheduler(cronStore, async (job) => {
      const prompt = `[Scheduled task${job.name ? `: ${job.name}` : ""}] ${job.task}`;
      await this.prompt(job.userId, prompt);
    });

    try {
      if (memoryIndexer) {
        if (this.config.memory?.watch ?? true) {
          await memoryIndexer.start();
        } else {
          await memoryIndexer.reindexAll();
        }
      }

      await cronScheduler.init();

      const userTtsTool = createTtsTool({
        ...this.config,
        tts: {
          ...this.config.tts,
          outputDir: paths.audioDir,
        },
      }) as unknown as ToolDefinition;

      const customTools: ToolDefinition[] = [
        ...createMemoryTools(memorySearch, memoryStore, this.embeddingClient),
        ...createCronTools(cronScheduler, userId),
        this.sttTool,
        userTtsTool,
      ];

      const sessionManager = SessionManager.continueRecent(this.config.workspace, paths.sessionDir);
      const { session } = await createAgentSession({
        cwd: this.config.workspace,
        model,
        thinkingLevel: this.config.llm.thinkingLevel ?? "high",
        sessionManager,
        modelRegistry: this.modelRegistry,
        authStorage: this.authStorage,
        tools: createCodingTools(this.config.workspace),
        customTools,
        resourceLoader: createStaticResourceLoader(this.systemPrompt),
      });

      return {
        userId,
        session,
        queue: Promise.resolve(),
        memoryStore,
        memoryIndexer,
        cronScheduler,
      };
    } catch (error) {
      memoryIndexer?.stop();
      await cronScheduler.shutdown();
      memoryStore.close();
      throw error;
    }
  }
}

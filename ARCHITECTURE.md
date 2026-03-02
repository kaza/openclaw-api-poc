# Lightweight Agent Harness — Architecture & Plan

## Executive Summary

This document outlines the architecture for a **lightweight, self-contained AI agent harness** built on top of [pi-mono](https://github.com/badlogic/pi-mono) — the same agent SDK that powers [OpenClaw](https://github.com/openclaw/openclaw). The goal is a minimal, secure, enterprise-friendly agent runtime that provides core capabilities (memory, scheduling, voice) without the overhead of a full messaging gateway.

## Motivation

### Why not use OpenClaw directly?

OpenClaw is a powerful multi-channel AI gateway (~100K lines of TypeScript). It handles Telegram, Discord, WhatsApp, Signal, Slack, and more — with sandboxing, plugin systems, multi-user session routing, auth profile rotation, and dozens of tools.

For an enterprise application with a single integration point (one app, one user per session), most of that is unnecessary overhead and expanded attack surface:

| OpenClaw Feature | Needed? | Why / Why Not |
|---|---|---|
| Multi-channel routing | ❌ | Single integration point — our app handles I/O |
| Session management | ✅ | Core requirement — persistent conversations |
| Agent loop + tools | ✅ | Core requirement — the whole point |
| Memory (vector search) | ✅ | Long-term context across sessions |
| Cron / scheduled tasks | ✅ | Reminders, periodic checks, background work |
| Speech-to-text | ✅ | Voice input from users |
| Text-to-speech | ✅ | Audio responses |
| Browser automation | ❌ | Not in scope |
| Sandbox / Docker | ❌ | Enterprise environment handles isolation |
| Sub-agent spawning | ❌ | Single agent, single session per user |
| Plugin system | ❌ | YAGNI — direct code is simpler |
| Canvas / Nodes | ❌ | OpenClaw-specific ecosystem features |
| Auth profile rotation | ❌ | One API key per provider suffices |

### What we get from pi-mono

The [pi-mono](https://github.com/badlogic/pi-mono) SDK (by [Mario Zechner](https://mariozechner.at/)) provides the battle-tested core that OpenClaw itself runs on:

| Package | What it provides |
|---|---|
| `@mariozechner/pi-agent-core` | Agent loop, tool execution, message types, state management |
| `@mariozechner/pi-ai` | LLM abstraction (`streamSimple()`), provider APIs (Anthropic, OpenAI, Google, Bedrock, Ollama, etc.), model discovery |
| `@mariozechner/pi-coding-agent` | `createAgentSession()`, `SessionManager` (JSONL persistence, branching, compaction), built-in tools (read, write, edit, bash, grep, find, ls), resource loader |

This is not a wrapper or a toy — it's the same engine handling production workloads through OpenClaw today.

## Project Goals

1. **Provide a minimal, self-contained AI agent runtime** that can be embedded into any application — no external daemon, no multi-tenant infrastructure, no messaging platform dependencies.
2. **Persistent, context-aware conversations** — the agent remembers past interactions through session history and long-term vector memory.
3. **Extensible tool system** — ship with core tools (memory, cron, voice), but make it trivial for developers to add their own.
4. **Enterprise-friendly** — minimal attack surface, clear dependency tree, no unnecessary network exposure. One process, one config file, predictable behavior.
5. **Developer experience** — clone, configure API keys, `npm start`, working agent. No complex setup, no infrastructure prerequisites beyond Node.js.

## Design Decisions

Key architectural choices and the reasoning behind them. These are **pragmatic defaults, not sacred decisions** — override any of them if your context demands it.

### Why pi-mono instead of LangChain / Vercel AI SDK / direct API calls?

**Decision:** Use `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` as the agent runtime.

**Why:**
- **Battle-tested in production** — this is the exact engine running OpenClaw, which handles real workloads across Telegram, Discord, WhatsApp, and more. Not a tutorial project.
- **Complete agent loop** — tool execution, streaming, context window management, auto-compaction, session persistence, model switching. All built-in, all working.
- **Provider-agnostic** — Anthropic, OpenAI, Google, Bedrock, Ollama, and others through a single `getModel()` call. No vendor lock-in.
- **Session management included** — `SessionManager` handles JSONL persistence, branching, and compaction. We don't have to build this.
- **7 built-in coding tools** — read, write, edit, bash, grep, find, ls. The agent can work with files and run commands out of the box.

**Why not LangChain?** Too abstract, too many layers, too much magic. We want to understand every line between the user's message and the LLM call.

**Why not Vercel AI SDK?** Focused on frontend/Next.js integration. We need a backend-first, framework-agnostic runtime.

**Why not raw API calls?** We'd have to build the agent loop, tool execution, streaming, context management, session persistence... That's exactly what pi-mono already provides.

**Override when:** You need a fundamentally different agent architecture (e.g., multi-agent orchestration, graph-based workflows), or you're in a Python shop and TypeScript is a non-starter.

### Why SQLite + sqlite-vec instead of Pinecone / Qdrant / pgvector?

**Decision:** Use `node:sqlite` (Node 22 built-in) + `sqlite-vec` extension for vector storage and search.

**Why:**
- **Zero infrastructure** — no database server to run, no cloud service to pay for. Single file on disk.
- **Zero dependencies** — `node:sqlite` is built into Node 22+. `sqlite-vec` is a single native extension.
- **Good enough performance** — for single-user workloads with thousands of chunks, SQLite vector search is sub-millisecond. We're not building a search engine for millions of documents.
- **Hybrid search** — SQLite FTS5 gives us BM25 full-text search alongside vector similarity. Both in one database, one query layer.
- **Portable** — the entire memory database is one file. Copy it, back it up, inspect it with any SQLite client.

**Override when:** You need multi-user concurrent writes at scale, or you're already running Postgres and want pgvector, or you need >100K documents with sub-10ms latency guarantees.

### Why hybrid search (BM25 + vector) instead of vector-only?

**Decision:** Combine FTS5 full-text search with vector cosine similarity, merge scores.

**Why:**
- **Vector search misses exact matches** — if the user asks "what did I say about ProjectX?" and memory contains the exact string "ProjectX", BM25 finds it instantly. Vector search might rank a semantically similar but wrong chunk higher.
- **BM25 misses semantic similarity** — "automobile" and "car" are the same concept but different words. Vector search catches this.
- **Combined is strictly better** — OpenClaw uses the same approach. The slight added complexity (~50 lines for score merging) is worth the quality improvement.

**Override when:** Your memory is tiny (<100 chunks) and the added complexity isn't justified, or you need maximum simplicity for a prototype.

### Why JSONL session files instead of a database?

**Decision:** Use pi-mono's `SessionManager` which persists sessions as JSONL (JSON Lines) files.

**Why:**
- **It's what pi-mono provides** — this is the native session format. Fighting it would mean reimplementing session management.
- **Human-readable** — you can `cat` a session file and read the conversation. Try that with a database blob.
- **Git-friendly** — append-only format, easy to diff, easy to back up.
- **One file per session** — no shared state, no locking issues for single-user access.

**Override when:** You need to query across sessions (e.g., "find all conversations mentioning X"), or you need concurrent write access to the same session from multiple processes.

### Why Express instead of Fastify / Hono / raw node:http?

**Decision:** Use Express 5 for the HTTP API layer.

**Why:**
- **Familiar** — virtually every Node.js developer knows Express. Zero learning curve.
- **Good enough** — we're not optimizing for 100K req/s. We're handling one user's chat messages. Express overhead is irrelevant.
- **Middleware ecosystem** — if we need CORS, rate limiting, or request logging later, it's one `app.use()` call.

**This is the least important decision in the entire project.** The HTTP layer is ~150 lines. Swapping Express for Hono or Fastify is a 30-minute refactor.

**Override when:** You want zero dependencies (use `node:http`), or you need maximum performance (use Hono/Fastify), or you're already using a different framework in your app.

### Why TypeScript instead of Python?

**Decision:** TypeScript for the entire project.

**Why:**
- **pi-mono is TypeScript** — our core dependency. Same language, same toolchain, native imports.
- **Type safety** — tool schemas use TypeBox, config has types, API contracts are typed. Catches bugs at compile time.
- **Single runtime** — Node.js runs everything. No Python virtual environments, no dependency conflicts between pip and npm.

**Override when:** Your team is Python-native and TypeScript is a barrier. In that case, you'd also need a Python agent SDK (e.g., Anthropic's agent SDK, LangChain, or PydanticAI) instead of pi-mono.

### Why OpenAI text-embedding-3-small instead of other embedding models?

**Decision:** Default to OpenAI `text-embedding-3-small` (1536 dimensions) for vector embeddings.

**Why:**
- **Cheap** — $0.02 per 1M tokens. Embedding an entire workspace costs fractions of a cent.
- **Fast** — sub-second for typical batch sizes.
- **Good quality** — consistently ranks well on MTEB benchmarks for its size class.
- **Widely available** — OpenAI API is the most commonly available API key developers already have.

**Override when:** You want to avoid OpenAI entirely (use Voyage, Gemini, or Mistral embeddings — all supported by OpenClaw's reference code), or you need multilingual-optimized embeddings.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Your Application                 │
│          (Web app, API server, CLI, …)           │
└────────────────────┬────────────────────────────┘
                     │  HTTP / direct call
                     ▼
┌─────────────────────────────────────────────────┐
│              Agent Harness (this project)         │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ HTTP API │  │  Config  │  │ System Prompt │  │
│  │ (Express)│  │ (JSON)   │  │   Builder     │  │
│  └────┬─────┘  └──────────┘  └───────────────┘  │
│       │                                           │
│       ▼                                           │
│  ┌────────────────────────────────────────────┐  │
│  │     pi-mono: createAgentSession()          │  │
│  │     SessionManager (JSONL persistence)     │  │
│  │     Agent loop + streaming + compaction    │  │
│  └────────────────────┬───────────────────────┘  │
│                       │                           │
│       ┌───────────────┼───────────────┐          │
│       ▼               ▼               ▼          │
│  ┌─────────┐   ┌───────────┐   ┌──────────┐    │
│  │ Built-in│   │  Custom   │   │  Custom  │    │
│  │  Tools  │   │  Tools    │   │  Tools   │    │
│  │ (pi-mono│   │ (memory,  │   │ (user-   │    │
│  │  read,  │   │  cron,    │   │  defined)│    │
│  │  write, │   │  tts,     │   │          │    │
│  │  edit,  │   │  stt)     │   │          │    │
│  │  bash…) │   │           │   │          │    │
│  └─────────┘   └─────┬─────┘   └──────────┘    │
│                       │                           │
│          ┌────────────┼────────────┐             │
│          ▼            ▼            ▼             │
│   ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│   │  SQLite  │ │  croner  │ │ External │       │
│   │  + vec   │ │ scheduler│ │   APIs   │       │
│   │ (memory) │ │ (timers) │ │(TTS/STT) │       │
│   └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────────────────────────────┘
```

## Components

### 1. Core Agent Runtime

**Source:** `@mariozechner/pi-coding-agent` + `@mariozechner/pi-ai` (npm packages)

The entire agent bootstrap fits in ~20 lines:

```typescript
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

const { session } = await createAgentSession({
  cwd: workspaceDir,
  model: getModel("anthropic", "claude-sonnet-4-20250514"),
  thinkingLevel: "high",
  sessionManager: SessionManager.create(sessionDir),
  customTools: [memorySearchTool, cronTool, ttsTool, ...userTools],
});

// Send a message
await session.prompt("Hello, what's on my schedule today?");

// Listen for streaming responses
session.on("message_update", (event) => {
  sendToClient(event.text);
});
```

**What you get out of the box:**
- Session persistence (JSONL files with branching and compaction)
- Streaming responses
- Context window management (auto-compaction when context fills up)
- Model switching at runtime
- 7 built-in tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`
- Provider-agnostic: Anthropic, OpenAI, Google, Bedrock, Ollama, and more

**Effort:** Minimal — this is configuration, not implementation.

### 2. Memory (Vector Search)

**Source:** Custom implementation. Inspired by OpenClaw's `src/memory/` (17K lines) but drastically simplified for single-user use.

OpenClaw's memory system supports multiple embedding providers, batch processing, temporal decay, MMR reranking, remote embedding servers, and multi-agent memory isolation. We need approximately 5% of that.

**Our implementation:**
- **Storage:** `node:sqlite` (built into Node 22+) + [`sqlite-vec`](https://github.com/asg017/sqlite-vec) extension for vector similarity
- **Embeddings:** One provider — OpenAI `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens)
- **Search:** Hybrid — BM25 full-text search (SQLite FTS5) + vector cosine similarity, merged with score normalization
- **Indexing:** File watcher on workspace markdown files (MEMORY.md, memory/*.md). Chunk by heading/paragraph, embed on change.
- **Agent tools:**
  - `memory_search(query: string, limit?: number)` → returns top-K relevant snippets with source attribution
  - `memory_store(text: string, metadata?: object)` → stores a new memory chunk and embeds it

**Schema:**
```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,        -- file path or 'agent-stored'
  content TEXT NOT NULL,       -- the actual text chunk
  metadata TEXT,               -- JSON metadata
  embedding BLOB,              -- float32 vector
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE chunks_fts USING fts5(content, source);
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[1536]);
```

**Effort:** 500–800 lines. 3–5 days. This is the most complex component.

### 3. Cron / Scheduled Tasks

**Source:** [`croner`](https://www.npmjs.com/package/croner) npm package (same library OpenClaw uses internally) + custom job store.

OpenClaw's cron system (17K lines) handles isolated agent sessions, delivery routing, webhooks, subagent followups, and multi-agent job isolation. We need a scheduler that fires callbacks.

**Our implementation:**
- **Scheduler:** `croner` for cron expressions, intervals, and one-shot timers
- **Persistence:** JSON file (`cron-jobs.json`) — survives restarts
- **Agent tools:**
  - `cron_add(schedule, task, name?)` → creates a scheduled job
  - `cron_list()` → shows all active jobs
  - `cron_remove(id)` → deletes a job
- **Job types:**
  - One-shot: `{ "kind": "at", "at": "2026-03-15T09:00:00Z" }`
  - Recurring: `{ "kind": "cron", "expr": "0 9 * * MON" }`
  - Interval: `{ "kind": "every", "everyMs": 3600000 }`
- **Execution:** When a job fires, it injects the task text as a new message into the agent session

**Effort:** 200–300 lines. 1 day.

### 4. Speech-to-Text (STT)

**Source:** Internal agent tool wrapping cloud STT services. **Not exposed as an API** — the agent handles transcription internally when it receives an audio file.

**Supported providers:**
- **OpenAI Whisper:** `POST https://api.openai.com/v1/audio/transcriptions`
- **ElevenLabs Scribe:** `POST https://api.elevenlabs.io/v1/speech-to-text` (alternative)

**Agent tool:** `transcribe(audioFilePath, language?)` → returns transcript text

**How it works:** When the WebUI uploads an OGG file via `/chat/stream` (multipart), the server saves it to a temp path and passes the file reference to the agent. The agent then uses the `transcribe` tool internally to convert speech to text before processing the message.

**Configuration:** Provider selection + API key in config. User can add custom STT providers by implementing a simple interface.

**Effort:** 50–80 lines per provider. A few hours.

### 5. Text-to-Speech (TTS)

**Source:** Thin API wrappers over existing cloud services.

**Supported providers:**
- **ElevenLabs:** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`
- **OpenAI TTS:** `POST https://api.openai.com/v1/audio/speech` (alternative)

**Agent tool:** `tts(text, voice?)` → returns path to generated audio file

**Configuration:** Provider, voice, model selection in config.

**Effort:** 50–80 lines per provider. A few hours.

### 6. HTTP API

**Source:** Custom. Express.js (or raw `node:http` if we want zero dependencies).

**Endpoints:**
| Method | Path | Description |
|---|---|---|
| `POST` | `/chat` | Send message (text or multipart with audio), receive full response |
| `POST` | `/chat/stream` | Send message (text or multipart with audio), receive SSE stream |
| `GET` | `/health` | Health check |

**Removed endpoints (not needed):**
- ~~`POST /transcribe`~~ — STT is an internal agent tool, not an API. The WebUI sends audio as a multipart attachment to `/chat` or `/chat/stream`, and the agent transcribes it internally.
- ~~`GET /sessions`~~ — App manages its own session references via user IDs.
- ~~`DELETE /sessions/:id`~~ — Not needed for v1.

**Voice input flow:**
```
WebUI → record audio → POST /chat/stream (multipart: audio file + user ID)
  → Server saves OGG to temp path → passes file path to agent session
  → Agent uses internal `transcribe` tool → processes transcript → streams response back
```

The audio upload uses **multipart/form-data** — the simplest approach for sending binary + metadata in one request.

**Session routing:** User ID in request → maps to session file. One user = one persistent JSONL session. Sessions are created automatically on first message (upsert pattern).

**Authentication:** Bearer token (configurable). Simple but sufficient for internal/enterprise use.

**Effort:** 100–150 lines. 1 day.

### 7. System Prompt Builder

**Source:** Custom. Inspired by OpenClaw's bootstrap file loading.

Reads workspace files and injects them into the agent's system prompt:
- `AGENTS.md` — agent instructions and personality
- `TOOLS.md` — tool-specific notes
- `MEMORY.md` — long-term memory (also indexed for vector search)

The builder concatenates these files with appropriate headers, similar to how OpenClaw's `buildAgentSystemPrompt()` works but without the 50+ configuration parameters.

**Effort:** ~100 lines. Half a day.

### 8. Configuration

Single `config.json` file:

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "thinkingLevel": "high"
  },
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "${OPENAI_API_KEY}"
  },
  "tts": {
    "provider": "elevenlabs",
    "voiceId": "XrExE9yKIg1WjnnlVkGX",
    "apiKey": "${ELEVENLABS_API_KEY}"
  },
  "stt": {
    "provider": "openai",
    "apiKey": "${OPENAI_API_KEY}"
  },
  "server": {
    "port": 3000,
    "token": "${AGENT_API_TOKEN}"
  },
  "workspace": "./workspace",
  "sessions": "./sessions"
}
```

Environment variables override secrets (the `${...}` syntax). No secrets in files.

**Effort:** ~50 lines. Trivial.

## Project Structure

```
agent-harness/
├── src/
│   ├── index.ts              # Entry point, HTTP server bootstrap
│   ├── agent.ts              # createAgentSession wrapper, prompt builder
│   ├── config.ts             # Config loader with env var resolution
│   ├── tools/
│   │   ├── memory.ts         # memory_search, memory_store agent tools
│   │   ├── cron.ts           # cron_add, cron_list, cron_remove tools
│   │   ├── tts.ts            # text-to-speech agent tool
│   │   └── stt.ts            # speech-to-text agent tool
│   ├── memory/
│   │   ├── store.ts          # SQLite + sqlite-vec operations
│   │   ├── embeddings.ts     # Embedding API client
│   │   ├── indexer.ts        # File watcher + markdown chunker
│   │   └── search.ts         # Hybrid BM25 + vector search
│   └── cron/
│       ├── scheduler.ts      # croner wrapper + job execution
│       └── store.ts          # JSON persistence for jobs
├── workspace/                # Agent workspace (user-editable)
│   ├── AGENTS.md             # Agent instructions
│   ├── TOOLS.md              # Tool notes
│   └── MEMORY.md             # Long-term memory
├── config.json               # Configuration
├── package.json
├── tsconfig.json
└── README.md
```

## Technology Stack

| Component | Technology | Why |
|---|---|---|
| Runtime | Node.js 22+ | Required for `node:sqlite` built-in |
| Language | TypeScript | Type safety, same as pi-mono |
| Agent SDK | pi-mono (`pi-coding-agent`, `pi-ai`) | Battle-tested, same engine as OpenClaw |
| Database | `node:sqlite` + `sqlite-vec` | Zero-dependency SQLite with vector search |
| Scheduling | `croner` | Lightweight, well-maintained, cron + interval + one-shot |
| HTTP | Express 5 | Minimal, familiar, good enough |
| LLM | Anthropic Claude (default) | Configurable — pi-ai supports all major providers |
| Embeddings | OpenAI `text-embedding-3-small` | Cheap, fast, good quality |

## Implementation Timeline

| Day | Component | Deliverable |
|---|---|---|
| 1 | Core + HTTP API | End-to-end working: send message → get response |
| 2–4 | Memory system | SQLite store, embeddings, indexer, hybrid search, agent tools |
| 5 | Cron scheduler | Job store, croner integration, agent tools |
| 5–6 | STT + TTS | API wrappers, agent tools |
| 7 | Polish + docs | README, config validation, error handling, tests |

**Total estimated effort: ~7 working days** for a fully functional agent with persistent memory, scheduled tasks, and voice I/O.

## What We Explicitly Do NOT Build

| Feature | Reason |
|---|---|
| Multi-channel messaging | Our app handles all I/O |
| Docker sandboxing | Enterprise environment manages isolation |
| Browser automation | Out of scope |
| Sub-agent orchestration | Single agent per session |
| Plugin/extension system | Direct code is simpler (YAGNI) |
| Auth profile rotation | One API key per provider |
| Multi-model failover | Can be added later if needed |
| Rate limiting / billing | Application layer handles this |

## Testing Strategy

**Principle:** Maximize unit tests, minimize integration tests. Tests should run fast, offline, and free.

### Unit Tests (the bulk — no API calls, no network)

- **Test runner:** [Vitest](https://vitest.dev/) (same as pi-mono and OpenClaw)
- **Mock all external APIs** — embedding calls, LLM calls, TTS/STT API calls. Use Vitest's `vi.mock()`.
- **Test each module in isolation:**
  - Memory store: SQLite operations, chunking, FTS indexing (real SQLite, no mock — it's local)
  - Memory search: score merging, BM25+vector hybrid logic (mock embeddings, real SQLite)
  - Cron: job CRUD, schedule parsing, persistence (real JSON file, mock timers)
  - Config: env var resolution, validation, defaults
  - HTTP API: request/response handling (supertest or direct handler calls)
  - System prompt builder: file loading, concatenation, template rendering
  - Tool schemas: parameter validation, error cases

### Integration Tests (optional, gated behind env flag)

- **Triggered by:** `TEST_LIVE=true npm test`
- **What they test:** Real API calls — embedding generation, LLM completion, TTS/STT
- **Require:** Valid API keys in environment
- **Purpose:** Verify our API wrappers work against real endpoints. Run manually before releases, not in CI.

### Test Conventions

- Co-locate tests: `memory/store.ts` → `memory/store.test.ts`
- Name pattern: `*.test.ts`
- No test should take >5 seconds (unit) or >30 seconds (integration)
- No test should require network access unless gated behind `TEST_LIVE`

## Error Handling & Resilience

### LLM API Failures
- **Timeout:** Configurable per-request timeout (default: 120s). Agent session handles retries internally (pi-mono built-in).
- **Rate limiting:** Surface the error to the caller. Let the application layer decide retry strategy.
- **Auth errors:** Fail fast with clear error message. Don't retry with bad credentials.

### Embedding API Failures
- **Graceful degradation:** If embeddings fail, memory search falls back to BM25-only (keyword search). Vector search is enhanced recall, not a hard dependency.
- **Retry:** One automatic retry with exponential backoff for transient errors (429, 500, 503).

### Session File Corruption
- **Append-only JSONL** — inherently corruption-resistant. Partial writes only affect the last line.
- **pi-mono's SessionManager** handles recovery — truncates incomplete trailing entries on load.

### General Pattern
- **Fail loud, fail clear** — structured error responses with actionable messages.
- **No silent swallowing** — every caught error is logged.
- **Caller decides** — the harness surfaces errors to the HTTP layer. The application decides what to show the user.

## Concurrency

### Single-user, single-session (default)
The primary use case is one user per session. No concurrent writes to the same session file.

### Multiple users (via user ID routing)
Each user ID maps to a separate session file. No shared state between sessions. Concurrent requests for *different* users are safe — they touch different files.

### Same user, concurrent requests
If two requests arrive simultaneously for the same user:
- **Option A (simple):** Reject the second request with 409 Conflict while the first is processing. The agent is stateful — interleaving messages mid-turn produces unpredictable results.
- **Option B (queue):** Queue the second message and process it after the first completes. pi-mono's `AgentSession` supports message queuing natively.

**Default:** Option A for v1. Simple, predictable, correct.

## Custom Tool Extensibility

Developers add tools by implementing the `AgentTool` interface from pi-agent-core:

```typescript
// my-tools/weather.ts
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const WeatherSchema = Type.Object({
  city: Type.String({ description: "City name" }),
});

export const weatherTool: AgentTool<typeof WeatherSchema> = {
  name: "weather",
  description: "Get current weather for a city",
  schema: WeatherSchema,
  async execute(params: Static<typeof WeatherSchema>): Promise<AgentToolResult> {
    const data = await fetch(`https://wttr.in/${params.city}?format=j1`).then(r => r.json());
    return { resultForAssistant: JSON.stringify(data.current_condition[0]) };
  },
};
```

Register in config or pass to the harness at startup:

```typescript
import { weatherTool } from "./my-tools/weather.js";

const harness = createHarness({
  customTools: [weatherTool],
});
```

**Convention:** Place custom tools in a `tools/` directory. Each file exports one or more `AgentTool` objects.

## Deployment

### Development
```bash
npm install
cp config.example.json config.json  # edit with your API keys
npm run dev                          # ts-node or tsx with watch mode
```

### Production
```bash
npm run build                        # tsc → dist/
node dist/index.js                   # or: npm start
```

**No Docker required** for single-instance deployment. It's a Node.js process — run it however you run Node.js apps (systemd, PM2, Docker, Kubernetes, etc.).

**Environment variables** for secrets — never commit API keys:
```bash
export ANTHROPIC_API_KEY=sk-...
export OPENAI_API_KEY=sk-...
export ELEVENLABS_API_KEY=...
export AGENT_API_TOKEN=your-bearer-token
node dist/index.js
```

## Security Considerations

- **Minimal surface area:** No gateway daemon, no WebSocket server, no multi-tenant routing
- **No secrets in config files:** Environment variable resolution for all API keys
- **Session isolation:** Each user gets a separate JSONL file — no shared state
- **Tool restrictions:** Agent tools operate within the configured workspace directory
- **Bearer token auth:** Simple but effective for internal APIs

## Future Extensions (Not in v1)

These can be added incrementally without architectural changes:

- **Web search tool** — API wrapper around Brave/Google/Perplexity
- **Image analysis tool** — Vision model API calls
- **WebSocket streaming** — Real-time bidirectional communication
- **Multi-model failover** — Try provider B if provider A fails
- **Conversation export** — HTML/PDF export of session history
- **Session management API** — List/delete sessions if needed later

---

## Reference Repositories

This project is a simplified, enterprise-focused subset of [OpenClaw](https://github.com/openclaw/openclaw), built directly on the [pi-mono](https://github.com/badlogic/pi-mono) SDK that powers it. Both repositories are fully open source (MIT) and serve as reference implementations.

### pi-mono — The Agent Engine

**Repository:** https://github.com/badlogic/pi-mono

The core SDK we build on. These are the key files to understand:

| File | What It Does |
|---|---|
| `packages/coding-agent/src/core/sdk.ts` | `createAgentSession()` — main entry point. Shows full API: model setup, tool registration, session management, resource loading |
| `packages/coding-agent/src/core/agent-session.ts` | `AgentSession` class — event system (`on("message_update")`), `prompt()`, compaction, model switching |
| `packages/coding-agent/src/core/session-manager.ts` | `SessionManager` — JSONL persistence, branching, session context building |
| `packages/coding-agent/src/core/tools/index.ts` | Built-in tools (read, write, edit, bash, grep, find, ls) + `createCodingTools()` factory |
| `packages/coding-agent/src/core/tools/bash.ts` | Example of a full tool implementation — TypeBox schema, execute function, result formatting |
| `packages/coding-agent/src/core/resource-loader.ts` | How AGENTS.md / CLAUDE.md files are discovered and loaded into context |
| `packages/coding-agent/src/core/compaction/index.ts` | Session compaction (context window management) |
| `packages/coding-agent/src/core/system-prompt.ts` | How the system prompt is built from tools + context files + skills |
| `packages/agent/src/types.ts` | `AgentLoopConfig`, `AgentTool` interface — the contract for custom tools |
| `packages/ai/src/index.ts` | `streamSimple()`, `getModel()` — LLM abstraction layer |

**Custom tool interface (from pi-agent-core):**

```typescript
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const MyToolSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  limit: Type.Optional(Type.Number({ description: "Max results" })),
});

const myTool: AgentTool<typeof MyToolSchema> = {
  name: "my_tool",
  description: "Does something useful",
  schema: MyToolSchema,
  async execute(params: Static<typeof MyToolSchema>): Promise<AgentToolResult> {
    const result = await doSomething(params.query, params.limit ?? 10);
    return { resultForAssistant: JSON.stringify(result) };
  },
};
```

### OpenClaw — Reference Implementations

**Repository:** https://github.com/openclaw/openclaw

OpenClaw is a full-featured multi-channel AI gateway (~100K lines TypeScript). We use it as a reference for the specific subsystems we're reimplementing in simplified form. Navigate freely — the full codebase is available — but these are the most relevant starting points:

#### Memory System (`src/memory/`)

| File | What to Learn |
|---|---|
| `src/memory/manager.ts` | Main memory manager — search orchestration, hybrid merge logic |
| `src/memory/sqlite-vec.ts` | How to load the sqlite-vec extension with `node:sqlite` |
| `src/memory/sqlite.ts` | `node:sqlite` initialization pattern |
| `src/memory/embeddings-openai.ts` | OpenAI embedding API wrapper (batching, error handling) |
| `src/memory/hybrid.ts` | BM25 + vector score merging algorithm |
| `src/memory/mmr.ts` | Maximal Marginal Relevance reranking (optional, nice-to-have) |
| `src/memory/temporal-decay.ts` | Time-based score decay (optional) |
| `src/memory/session-files.ts` | How session JSONL files are indexed into memory |
| `src/agents/tools/memory-tool.ts` | `memory_search` and `memory_get` tool definitions — schema, execute, result formatting |

#### Cron / Scheduling (`src/cron/`)

| File | What to Learn |
|---|---|
| `src/cron/service.ts` | Main cron service — job lifecycle, scheduling |
| `src/cron/service/store.ts` | JSON-based job persistence |
| `src/cron/service/timer.ts` | croner integration pattern |
| `src/cron/types.ts` | Job schema: schedule types (at, every, cron), payloads |
| `src/cron/store.ts` | Low-level store operations |
| `src/agents/tools/cron-tool.ts` | `cron` agent tool — add/list/remove/run interface |

#### Voice (TTS / STT)

| File | What to Learn |
|---|---|
| `src/agents/tools/tts-tool.ts` | TTS tool definition and execution |
| `src/tts/tts.ts` | TTS provider abstraction |
| `src/media-understanding/providers/openai/` | OpenAI Whisper STT integration |

#### System Prompt & Bootstrap

| File | What to Learn |
|---|---|
| `src/agents/workspace.ts` | How workspace files (AGENTS.md, SOUL.md, TOOLS.md, etc.) are discovered and loaded |
| `src/agents/bootstrap-files.ts` | Bootstrap file resolution for agent runs |
| `src/agents/system-prompt.ts` | Full system prompt builder — `buildAgentSystemPrompt()` |
| `src/agents/pi-embedded-runner/run/attempt.ts` | How OpenClaw creates an embedded pi session with custom tools |

#### Tool Patterns

| File | What to Learn |
|---|---|
| `src/agents/pi-tools.ts` | `createOpenClawCodingTools()` — how tools are assembled and injected |
| `src/agents/tools/web-fetch.ts` | Example of a well-structured custom tool with validation |
| `src/agents/tools/web-search.ts` | Another clean tool example with provider abstraction |

### How to Use These References

1. **Start with pi-mono's `sdk.ts`** — understand `createAgentSession()` and the tool interface
2. **Look at OpenClaw's tool implementations** when building each module — they show battle-tested patterns
3. **Don't copy-paste** — OpenClaw's tools are tightly coupled to its config system, session routing, and plugin hooks. Extract the logic patterns, implement with our simpler architecture
4. **Navigate freely** — both repos are fully available. When you need to understand how something works deeper, follow the imports

---

*This document serves as the architectural decision record and implementation plan. It will be updated as the project evolves.*

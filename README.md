# Lightweight Agent Harness (TypeScript)

A self-contained HTTP agent harness built on **pi-mono**:

- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-agent-core`

This project implements the architecture from `ARCHITECTURE.md` with:

- Core agent runtime + persistent per-user sessions
- HTTP API (`/chat`, `/chat/stream`, `/health`)
- Vector memory (SQLite + sqlite-vec + FTS5)
- Cron scheduling (`croner`) with persistence
- STT tool (OpenAI or ElevenLabs)
- TTS tool (OpenAI or ElevenLabs)
- System prompt builder from workspace files
- JSON config with `${ENV_VAR}` secret resolution

## Requirements

- Node.js **22+**
- API keys (depending on enabled providers)

## Install

```bash
npm install
```

## Configure

Edit `config.json` (defaults are included) and/or set environment variables:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `AGENT_API_TOKEN`

## Run

```bash
# dev
npm run dev

# compile
npm run build

# run compiled
npm start
```

## API

### `GET /health`

Returns service health.

### `POST /chat`

JSON:

```json
{
  "userId": "alice",
  "message": "What's on my schedule today?"
}
```

Multipart (audio + optional text):

- `userId` (field)
- `message` (field, optional)
- `audio` (file, optional)

### `POST /chat/stream`

Same payload as `/chat`, response is SSE with events:

- `delta`
- `done`
- `error`

## Project Structure

```text
src/
  index.ts            # HTTP server
  agent.ts            # session runtime and routing
  config.ts           # config + env resolution
  system-prompt.ts    # AGENTS/TOOLS/MEMORY prompt builder
  tools/
    memory.ts
    cron.ts
    stt.ts
    tts.ts
  memory/
    store.ts
    embeddings.ts
    indexer.ts
    search.ts
  cron/
    store.ts
    scheduler.ts
```

## Notes

- One user ID maps to one persistent session history.
- Memory indexing is automatically disabled when embedding API key is missing.
- Old `index.html` and `server.js` are legacy POC artifacts; `src/` + TypeScript is the active implementation.

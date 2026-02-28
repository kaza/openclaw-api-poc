# OpenClaw API POC

Proof of concept: using [OpenClaw](https://github.com/openclaw/openclaw) as an AI execution engine with session routing from a custom web app.

## What This Proves

OpenClaw handles all the AI complexity (model calls, session memory, tool access, context management). Your app just sends messages to the right session.

```
[Your Web App] → POST /v1/responses → [OpenClaw Gateway] → [Agent + Session + Memory]
```

## Quick Start

1. **Enable the OpenResponses endpoint** in your OpenClaw config (`openclaw.json`):

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "responses": { "enabled": true }
      }
    }
  }
}
```

2. **Restart the gateway:**

```bash
openclaw gateway restart
```

3. **Serve the app** (any static HTTP server):

```bash
npx serve .
# or
python3 -m http.server 3000
```

4. **Open** `http://localhost:3000` and configure:
   - Gateway URL (default: `http://localhost:18789`)
   - Gateway Token (your `OPENCLAW_GATEWAY_TOKEN`)
   - Agent ID (e.g., `main`)

5. **Test session routing:**
   - Set User ID to "Alice" → send "Hi, I'm Alice"
   - Set User ID to "Bob" → send "Hi, I'm Bob"  
   - Set User ID to "Alice" → send "What's my name?" → should say "Alice"

## How It Works

- **Session routing**: The `user` field in the API request creates a stable session per user ID
- **Agent selection**: `model: "openclaw:<agentId>"` routes to the right agent
- **Memory**: OpenClaw maintains context per session automatically
- **Streaming**: SSE support for real-time responses

## API Reference

See [OpenClaw OpenResponses API docs](https://docs.openclaw.ai/gateway/openresponses-http-api).

## License

MIT

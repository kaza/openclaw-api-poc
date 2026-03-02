# Integration Tests

These tests run against a **live server** and are skipped by default.

## What is covered

- Streaming SSE from `POST /chat/stream` (`delta` + `done` events)
- Multipart audio streaming upload using a real `.ogg` fixture (`audio` field)
- User session isolation (`user-A` and `user-B` stay separate)
- Auth token validation (missing/invalid bearer token returns `401`)

## Prerequisites

1. Start the server in another shell:

```bash
AGENT_API_TOKEN=your-token npm run dev
```

2. Ensure required model API keys are set (`ANTHROPIC_API_KEY`, etc.).
3. The test fixture `tests/integration/fixtures/sample.ogg` is used for real audio upload coverage.

## Run

```bash
TEST_INTEGRATION=true \
TEST_BEARER_TOKEN=your-token \
TEST_BASE_URL=http://localhost:3000 \
npm test
```

Optional:

- `TEST_INTEGRATION_TIMEOUT_MS=180000` to increase per-test timeout.

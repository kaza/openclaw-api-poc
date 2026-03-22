# Integration Tests

These tests run against a **live server** and are skipped by default.

## What is covered

- Streaming SSE from `POST /chat/stream` (`delta` + `done` events)
- Multipart audio streaming upload using a real `.ogg` fixture (`audio` field)
- User session isolation (`user-A` and `user-B` stay separate)
- Auth token validation (missing/invalid bearer token returns `401`)

## Prerequisites

### Fast mode (recommended for local endpoint/UI smoke tests)

Start the server in another shell:

```bash
HARNESS_TEST_MODE=true AGENT_API_TOKEN=your-token npm run dev
```

This bypasses real model/STT calls and makes the integration suite much faster while still exercising auth, uploads, SSE, and per-user session behavior.

### Live mode (real provider path)

```bash
AGENT_API_TOKEN=your-token npm run dev
```

Ensure required model API keys are set (`ANTHROPIC_API_KEY`, etc.).
The test fixture `tests/integration/fixtures/sample.ogg` is used for real audio upload coverage.

## Run

Fast mode:

```bash
HARNESS_TEST_MODE=true \
TEST_INTEGRATION=true \
TEST_BEARER_TOKEN=your-token \
TEST_BASE_URL=http://localhost:3000 \
npm run test:integration:fast
```

Live mode:

```bash
TEST_INTEGRATION=true \
TEST_BEARER_TOKEN=your-token \
TEST_BASE_URL=http://localhost:3000 \
npm run test:integration
```

Optional:

- `TEST_INTEGRATION_TIMEOUT_MS=15000` for fast mode or a larger value for live mode.

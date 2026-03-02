import express from "express";
import multer from "multer";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { AgentHarness } from "./agent.js";

function parseUserId(body: Record<string, unknown>): string {
  const userId = body.userId ?? body.user ?? body.sessionId;
  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error("Missing userId");
  }
  return userId.trim();
}

function parseMessage(body: Record<string, unknown>): string {
  const value = body.message ?? body.text ?? "";
  return typeof value === "string" ? value : "";
}

async function cleanupFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch {
    // best effort
  }
}

function sendSse(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const { config } = await loadConfig();
const harness = new AgentHarness(config);
await harness.init();

const app = express();
const upload = multer({
  dest: path.join(config.sessions, "uploads"),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  const token = config.server.token?.trim();
  if (!token) return next();

  const auth = req.header("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  const presented = auth.slice("Bearer ".length).trim();
  if (presented !== token) return res.status(403).json({ error: "Invalid bearer token" });
  return next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/chat", upload.single("audio"), async (req, res) => {
  const audioFilePath = req.file?.path;

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = parseUserId(body);
    const message = parseMessage(body);

    if (!message && !audioFilePath) {
      return res.status(400).json({ error: "Provide message text or an audio upload" });
    }

    const text = await harness.prompt(userId, message, audioFilePath);
    return res.json({ userId, text });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : "chat failed",
    });
  } finally {
    await cleanupFile(audioFilePath);
  }
});

app.post("/chat/stream", upload.single("audio"), async (req, res) => {
  const audioFilePath = req.file?.path;
  let closed = false;

  req.on("close", () => {
    closed = true;
  });

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = parseUserId(body);
    const message = parseMessage(body);

    if (!message && !audioFilePath) {
      return res.status(400).json({ error: "Provide message text or an audio upload" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    await harness.promptStream(
      userId,
      message,
      {
        onDelta: (delta) => {
          if (closed) return;
          sendSse(res, "delta", { delta });
        },
        onDone: (text) => {
          if (closed) return;
          sendSse(res, "done", { text });
          res.end();
        },
      },
      audioFilePath,
    );

    return undefined;
  } catch (error) {
    if (!res.headersSent) {
      res.status(400).json({ error: error instanceof Error ? error.message : "stream failed" });
      return undefined;
    }

    sendSse(res, "error", { error: error instanceof Error ? error.message : "stream failed" });
    res.end();
    return undefined;
  } finally {
    await cleanupFile(audioFilePath);
  }
});

const server = app.listen(config.server.port, () => {
  console.log(`Agent harness listening on :${config.server.port}`);
});

async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  await harness.shutdown();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

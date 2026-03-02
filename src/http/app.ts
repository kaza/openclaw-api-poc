import express from "express";
import multer from "multer";
import type { Dirent } from "node:fs";
import path from "node:path";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { buildUserPaths } from "../user-paths.js";

export interface ChatHarness {
  prompt(userId: string, text: string, audioFilePath?: string): Promise<string>;
  promptStream(
    userId: string,
    text: string,
    handlers: {
      onDelta: (delta: string) => void;
      onDone: (fullText: string) => void;
    },
    audioFilePath?: string,
  ): Promise<void>;
}

export interface HttpAppConfig {
  sessions: string;
  uiDir?: string;
  server: {
    token?: string;
  };
}

export function parseUserId(body: Record<string, unknown>): string {
  const userId = body.userId ?? body.user ?? body.sessionId;
  if (typeof userId !== "string" || !userId.trim()) {
    throw new Error("Missing userId");
  }
  return userId.trim();
}

export function parseMessage(body: Record<string, unknown>): string {
  const value = body.message ?? body.text ?? "";
  return typeof value === "string" ? value : "";
}

export async function cleanupFile(filePath: string | undefined): Promise<void> {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch {
    // best effort
  }
}

export async function moveUploadToUserDir(
  sessionsDir: string,
  userId: string,
  file: Express.Multer.File | undefined,
): Promise<string | undefined> {
  if (!file) return undefined;

  const { uploadsDir } = buildUserPaths(sessionsDir, userId);
  await mkdir(uploadsDir, { recursive: true });

  const ext = path.extname(file.originalname ?? "");
  const filename = ext && !file.filename.endsWith(ext) ? `${file.filename}${ext}` : file.filename;
  const targetPath = path.join(uploadsDir, filename);

  await rename(file.path, targetPath);
  return targetPath;
}

export function sendSse(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1000;

function isProtectedApiPath(pathname: string): boolean {
  return pathname === "/health" || pathname.startsWith("/chat") || pathname === "/history";
}

function parseHistoryLimit(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_HISTORY_LIMIT;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT;

  return Math.min(parsed, MAX_HISTORY_LIMIT);
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textBlocks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;

    const block = item as { type?: unknown; text?: unknown };
    if (block.type !== "text" || typeof block.text !== "string") continue;

    const text = block.text.trim();
    if (text) textBlocks.push(text);
  }

  return textBlocks.join("\n\n").trim();
}

async function loadHistoryMessages(sessionsDir: string, userId: string, limit: number): Promise<HistoryMessage[]> {
  const { sessionDir } = buildUserPaths(sessionsDir, userId);

  let entries: Dirent[];
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort();

  if (!sessionFiles.length) return [];

  const timeline: HistoryMessage[] = [];

  for (const fileName of sessionFiles) {
    const fullPath = path.join(sessionDir, fileName);
    const raw = await readFile(fullPath, "utf8");
    const lines = raw.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (!parsed || typeof parsed !== "object") continue;

      const record = parsed as {
        type?: unknown;
        message?: {
          role?: unknown;
          content?: unknown;
        };
      };

      if (record.type !== "message") continue;
      if (!record.message || typeof record.message !== "object") continue;

      const role = record.message.role;
      if (role !== "user" && role !== "assistant") continue;

      const text = extractTextContent(record.message.content);
      if (!text) continue;

      timeline.push({ role, text });
    }
  }

  const pairs: Array<[HistoryMessage, HistoryMessage]> = [];
  let pendingUserMessage: HistoryMessage | undefined;
  let latestAssistantForPendingUser: HistoryMessage | undefined;

  for (const message of timeline) {
    if (message.role === "user") {
      if (pendingUserMessage && latestAssistantForPendingUser) {
        pairs.push([pendingUserMessage, latestAssistantForPendingUser]);
      }

      pendingUserMessage = message;
      latestAssistantForPendingUser = undefined;
      continue;
    }

    if (!pendingUserMessage) continue;
    latestAssistantForPendingUser = message;
  }

  if (pendingUserMessage && latestAssistantForPendingUser) {
    pairs.push([pendingUserMessage, latestAssistantForPendingUser]);
  }

  const maxPairs = Math.floor(limit / 2);
  if (maxPairs <= 0) return [];

  return pairs.slice(-maxPairs).flat();
}

export function createApp(config: HttpAppConfig, harness: ChatHarness): express.Express {
  const app = express();
  const uiDir = path.resolve(config.uiDir ?? path.join(process.cwd(), "ui"));

  const upload = multer({
    dest: path.join(config.sessions, ".uploads-tmp"),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  // Dev CORS policy: allow all origins.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization,Content-Type");

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }

    next();
  });

  app.use(express.json({ limit: "2mb" }));
  app.use(express.static(uiDir));

  app.use((req, res, next) => {
    if (!isProtectedApiPath(req.path)) return next();

    const token = config.server.token?.trim();
    if (!token) return next();

    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing bearer token" });
    }

    const presented = auth.slice("Bearer ".length).trim();
    if (presented !== token) return res.status(401).json({ error: "Invalid bearer token" });
    return next();
  });

  app.get("/", (_req, res) => {
    res.sendFile(path.join(uiDir, "index.html"));
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/history", async (req, res) => {
    try {
      const rawUserId = req.query.userId;
      const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
      if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
      }

      const limit = parseHistoryLimit(req.query.limit);
      const messages = await loadHistoryMessages(config.sessions, userId, limit);
      return res.json({ messages });
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : "history failed",
      });
    }
  });

  app.post("/chat", upload.single("audio"), async (req, res) => {
    const originalUploadPath = req.file?.path;
    let audioFilePath = originalUploadPath;

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = parseUserId(body);
      audioFilePath = await moveUploadToUserDir(config.sessions, userId, req.file);
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
      if (originalUploadPath && originalUploadPath !== audioFilePath) {
        await cleanupFile(originalUploadPath);
      }
    }
  });

  app.post("/chat/stream", upload.single("audio"), async (req, res) => {
    const originalUploadPath = req.file?.path;
    let audioFilePath = originalUploadPath;
    let clientDisconnected = false;

    res.on("close", () => {
      clientDisconnected = true;
    });
    req.on("aborted", () => {
      clientDisconnected = true;
    });

    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const userId = parseUserId(body);
      audioFilePath = await moveUploadToUserDir(config.sessions, userId, req.file);
      const message = parseMessage(body);

      if (!message && !audioFilePath) {
        return res.status(400).json({ error: "Provide message text or an audio upload" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(": stream-open\n\n");

      await harness.promptStream(
        userId,
        message,
        {
          onDelta: (delta) => {
            if (clientDisconnected || res.writableEnded) return;
            sendSse(res, "delta", { delta });
          },
          onDone: (text) => {
            if (clientDisconnected || res.writableEnded) return;
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

      if (!res.writableEnded) {
        sendSse(res, "error", { error: error instanceof Error ? error.message : "stream failed" });
        res.end();
      }
      return undefined;
    } finally {
      await cleanupFile(audioFilePath);
      if (originalUploadPath && originalUploadPath !== audioFilePath) {
        await cleanupFile(originalUploadPath);
      }
    }
  });

  return app;
}

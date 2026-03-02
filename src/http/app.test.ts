import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupFile, createApp, moveUploadToUserDir, parseMessage, parseUserId, sendSse } from "./app.js";

const dirs: string[] = [];

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function makeSessionsDir() {
  return makeTempDir("http-app-");
}

async function makeUiDir() {
  const uiDir = await makeTempDir("http-ui-");
  await writeFile(path.join(uiDir, "index.html"), "<html><body>ui ok</body></html>", "utf8");
  return uiDir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("http app helpers", () => {
  it("parseUserId resolves accepted keys and rejects missing values", () => {
    expect(parseUserId({ userId: " u " })).toBe("u");
    expect(parseUserId({ user: "u2" })).toBe("u2");
    expect(parseUserId({ sessionId: "u3" })).toBe("u3");
    expect(() => parseUserId({})).toThrow("Missing userId");
  });

  it("parseMessage resolves message/text and defaults to empty", () => {
    expect(parseMessage({ message: "hello" })).toBe("hello");
    expect(parseMessage({ text: "hello2" })).toBe("hello2");
    expect(parseMessage({ message: 123 })).toBe("");
  });

  it("cleanupFile removes files and ignores missing paths", async () => {
    const dir = await makeSessionsDir();
    const filePath = path.join(dir, "tmp.txt");
    await writeFile(filePath, "data", "utf8");

    await cleanupFile(filePath);
    await expect(readFile(filePath, "utf8")).rejects.toThrow();
    await expect(cleanupFile(undefined)).resolves.toBeUndefined();
  });

  it("moveUploadToUserDir relocates files into sessions/{user}/uploads", async () => {
    const sessions = await makeSessionsDir();
    const tmpDir = path.join(sessions, ".uploads-tmp");
    await rm(tmpDir, { recursive: true, force: true });
    await writeFile(path.join(sessions, "raw.bin"), "audio", "utf8");

    const src = path.join(sessions, "raw.bin");
    const moved = await moveUploadToUserDir(sessions, "user/with:chars", {
      path: src,
      filename: "upload-id",
      originalname: "voice.ogg",
    } as Express.Multer.File);

    expect(moved).toBe(path.join(sessions, "user_with_chars", "uploads", "upload-id.ogg"));
    await expect(stat(moved!)).resolves.toBeTruthy();
    await expect(readFile(src, "utf8")).rejects.toThrow();
  });

  it("sendSse writes expected SSE frame", () => {
    const writes: string[] = [];
    sendSse({ write: (chunk: string) => writes.push(chunk) } as never, "delta", { x: 1 });
    expect(writes.join("")).toBe('event: delta\ndata: {"x":1}\n\n');
  });
});

describe("createApp", () => {
  it("handles auth, health, and chat routes", async () => {
    const sessions = await makeSessionsDir();
    const uiDir = await makeUiDir();
    const harness = {
      prompt: vi.fn().mockResolvedValue("assistant reply"),
      promptStream: vi.fn(),
    };

    const app = createApp({ sessions, uiDir, server: { token: "secret" } }, harness as never);

    await request(app).get("/health").expect(401);
    await request(app).post("/chat").set("authorization", "Bearer wrong").send({ userId: "u", message: "m" }).expect(401);

    const ok = await request(app)
      .post("/chat")
      .set("authorization", "Bearer secret")
      .send({ userId: "u", message: "hello" })
      .expect(200);

    expect(ok.body).toEqual({ userId: "u", text: "assistant reply" });
    expect(harness.prompt).toHaveBeenCalledWith("u", "hello", undefined);
  });

  it("stores multipart uploads under sessions/{user}/uploads before handing to harness", async () => {
    const sessions = await makeSessionsDir();
    const uiDir = await makeUiDir();
    const harness = {
      prompt: vi.fn().mockResolvedValue("ok"),
      promptStream: vi.fn(),
    };

    const app = createApp({ sessions, uiDir, server: {} }, harness as never);

    await request(app)
      .post("/chat")
      .field("userId", "user-1")
      .field("message", "hello")
      .attach("audio", Buffer.from("audio"), "clip.ogg")
      .expect(200);

    expect(harness.prompt).toHaveBeenCalledTimes(1);
    const audioPath = harness.prompt.mock.calls[0][2] as string;
    expect(audioPath).toContain(path.join("user-1", "uploads"));

    await expect(stat(audioPath)).rejects.toThrow();
  });

  it("serves UI at / and applies CORS headers", async () => {
    const sessions = await makeSessionsDir();
    const uiDir = await makeUiDir();
    const harness = {
      prompt: vi.fn(),
      promptStream: vi.fn(),
    };

    const app = createApp({ sessions, uiDir, server: { token: "secret" } }, harness as never);

    const root = await request(app).get("/").expect(200);
    expect(root.text).toContain("ui ok");

    const preflight = await request(app)
      .options("/chat")
      .set("origin", "http://example.local")
      .set("access-control-request-method", "POST")
      .expect(204);

    expect(preflight.headers["access-control-allow-origin"]).toBe("*");
    expect(preflight.headers["access-control-allow-headers"]).toContain("Authorization");
  });

  it("returns validation and execution errors from /chat", async () => {
    const sessions = await makeSessionsDir();
    const uiDir = await makeUiDir();
    const harness = {
      prompt: vi.fn().mockRejectedValue(new Error("chat-failed")),
      promptStream: vi.fn(),
    };

    const app = createApp({ sessions, uiDir, server: {} }, harness as never);

    await request(app).post("/chat").send({ userId: "u" }).expect(400);

    const failed = await request(app).post("/chat").send({ userId: "u", message: "x" }).expect(400);
    expect(failed.body.error).toBe("chat-failed");
  });

  it("streams deltas/done events and streams error events when already in SSE mode", async () => {
    const sessions = await makeSessionsDir();
    const uiDir = await makeUiDir();

    const harnessOk = {
      prompt: vi.fn(),
      promptStream: vi.fn(async (_u: string, _m: string, handlers: { onDelta: (d: string) => void; onDone: (t: string) => void }) => {
        handlers.onDelta("a");
        handlers.onDelta("b");
        handlers.onDone("ab");
      }),
    };

    const appOk = createApp({ sessions, uiDir, server: {} }, harnessOk as never);
    const streamed = await request(appOk).post("/chat/stream").send({ userId: "u", message: "m" }).expect(200);

    expect(streamed.text).toContain(": stream-open");
    expect(streamed.text).toContain("event: delta");
    expect(streamed.text).toContain('data: {"delta":"a"}');
    expect(streamed.text).toContain("event: done");

    const harnessErr = {
      prompt: vi.fn(),
      promptStream: vi.fn(async (_u: string, _m: string, handlers: { onDelta: (d: string) => void }) => {
        handlers.onDelta("partial");
        throw new Error("stream-failed");
      }),
    };

    const appErr = createApp({ sessions, uiDir, server: {} }, harnessErr as never);
    const errored = await request(appErr).post("/chat/stream").send({ userId: "u", message: "m" }).expect(200);

    expect(errored.text).toContain("event: error");
    expect(errored.text).toContain("stream-failed");
  });
});

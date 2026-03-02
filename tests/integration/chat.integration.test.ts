import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATION_ENABLED = process.env.TEST_INTEGRATION === "true";
const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const VALID_TOKEN = process.env.TEST_BEARER_TOKEN ?? process.env.AGENT_API_TOKEN ?? "";
const TIMEOUT_MS = Number(process.env.TEST_INTEGRATION_TIMEOUT_MS ?? 180000);
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_FIXTURE = path.join(TEST_DIR, "fixtures", "sample.ogg");

interface ChatResponse {
  userId: string;
  text: string;
}

interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authJsonHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function authHeader(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
  };
}

async function postChat(userId: string, message: string, token = VALID_TOKEN): Promise<{ status: number; json: unknown }> {
  const response = await fetchWithTimeout(`${BASE_URL}/chat`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ userId, message }),
  });

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = {};
  }

  return { status: response.status, json };
}

async function collectSseEvents(response: Response): Promise<StreamEvent[]> {
  if (!response.body) return [];

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const events: StreamEvent[] = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const lines = frame.split(/\r?\n/);
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!dataLine) continue;

      const event = eventLine ? eventLine.slice(6).trim() : "message";
      const rawData = dataLine.slice(5).trim();

      try {
        const data = JSON.parse(rawData) as Record<string, unknown>;
        events.push({ event, data });
      } catch {
        // ignore malformed frames
      }
    }
  }

  return events;
}

async function postChatStreamJson(userId: string, message: string, token = VALID_TOKEN): Promise<{ status: number; events: StreamEvent[] }> {
  const response = await fetchWithTimeout(`${BASE_URL}/chat/stream`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ userId, message }),
  });

  return {
    status: response.status,
    events: await collectSseEvents(response),
  };
}

async function postChatStreamForm(form: FormData, token = VALID_TOKEN): Promise<{ status: number; events: StreamEvent[] }> {
  const response = await fetchWithTimeout(`${BASE_URL}/chat/stream`, {
    method: "POST",
    headers: authHeader(token),
    body: form,
  });

  return {
    status: response.status,
    events: await collectSseEvents(response),
  };
}

async function buildAudioForm(userId: string, message?: string): Promise<FormData> {
  const audio = await readFile(AUDIO_FIXTURE);
  const form = new FormData();
  form.set("userId", userId);
  if (message) form.set("message", message);
  form.set("audio", new Blob([audio], { type: "audio/ogg" }), "sample.ogg");
  return form;
}

function extractDeltaText(events: StreamEvent[]): string {
  return events
    .filter((e) => e.event === "delta")
    .map((e) => (typeof e.data.delta === "string" ? e.data.delta : ""))
    .join("");
}

function extractDoneText(events: StreamEvent[]): string {
  const done = events.find((e) => e.event === "done");
  return typeof done?.data.text === "string" ? done.data.text : "";
}

const integrationDescribe = INTEGRATION_ENABLED ? describe : describe.skip;

integrationDescribe("integration: /chat + /chat/stream", () => {
  it(
    "streams delta events and a complete done event",
    async () => {
      if (!VALID_TOKEN) {
        throw new Error("Missing TEST_BEARER_TOKEN (or AGENT_API_TOKEN) for integration tests");
      }

      const marker = `STREAM_OK_${Date.now().toString(36)}`;
      const userId = `integration-stream-${Date.now().toString(36)}`;
      const prompt = `Reply with exactly this token and nothing else: ${marker}`;

      const { status, events } = await postChatStreamJson(userId, prompt);
      expect(status).toBe(200);

      const deltaText = extractDeltaText(events);
      const doneText = extractDoneText(events);

      expect(deltaText.length).toBeGreaterThan(0);
      expect(doneText.length).toBeGreaterThan(0);
      expect(doneText).toContain(marker);
      expect(doneText.replace(/\s+/g, " ").trim()).toBe(deltaText.replace(/\s+/g, " ").trim());
    },
    TIMEOUT_MS,
  );

  it(
    "accepts multipart OGG audio uploads on /chat/stream",
    async () => {
      if (!VALID_TOKEN) {
        throw new Error("Missing TEST_BEARER_TOKEN (or AGENT_API_TOKEN) for integration tests");
      }

      const userId = `integration-audio-${Date.now().toString(36)}`;
      const form = await buildAudioForm(userId, "Transcribe this audio and answer in one short sentence.");
      const { status, events } = await postChatStreamForm(form);

      expect(status).toBe(200);

      const doneText = extractDoneText(events);
      expect(doneText.length).toBeGreaterThan(0);
      expect(events.some((event) => event.event === "delta")).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "keeps user sessions isolated while preserving history per user",
    async () => {
      if (!VALID_TOKEN) {
        throw new Error("Missing TEST_BEARER_TOKEN (or AGENT_API_TOKEN) for integration tests");
      }

      const testId = Date.now().toString(36);
      const userA = `integration-user-a-${testId}`;
      const userB = `integration-user-b-${testId}`;
      const secret = `SECRET_${Math.random().toString(36).slice(2, 12).toUpperCase()}`;

      const a1 = await postChat(
        userA,
        `For this session, remember this exact secret token: ${secret}. Reply with: stored.`,
      );
      expect(a1.status).toBe(200);

      const b1 = await postChat(
        userB,
        "What secret token did I ask you to remember earlier in this session? If none, reply with NO_SECRET.",
      );
      expect(b1.status).toBe(200);

      const b1Text = String((b1.json as ChatResponse).text ?? "");
      expect(b1Text).not.toContain(secret);

      const a2 = await postChat(
        userA,
        "What secret token did I ask you to remember earlier in this session? Reply with the token.",
      );
      expect(a2.status).toBe(200);

      const a2Text = String((a2.json as ChatResponse).text ?? "");
      expect(a2Text).toContain(secret);
    },
    TIMEOUT_MS,
  );

  it("rejects requests without a valid bearer token", async () => {
    const userId = `integration-auth-${Date.now().toString(36)}`;

    const noAuthResponse = await fetchWithTimeout(`${BASE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, message: "hello" }),
    });

    expect(noAuthResponse.status).toBe(401);

    const invalid = await postChat(userId, "hello", "definitely-wrong-token");
    expect(invalid.status).toBe(401);
  });
});

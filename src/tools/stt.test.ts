import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createSttTool } from "./stt.js";

const dirs: string[] = [];

async function makeAudioFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stt-tool-"));
  dirs.push(dir);
  const filePath = path.join(dir, "audio.wav");
  await writeFile(filePath, Buffer.from("fake-audio"));
  return filePath;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createSttTool", () => {
  it("transcribes with OpenAI provider", async () => {
    const audio = await makeAudioFile();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "hello from openai" }),
      }),
    );

    const tool = createSttTool({
      llm: { provider: "anthropic", model: "x" },
      embedding: { provider: "openai", model: "m" },
      tts: { provider: "openai" },
      stt: { provider: "openai", apiKey: "key", model: "whisper-1" },
      server: { port: 3000 },
      workspace: ".",
      sessions: ".",
    });

    const result = await tool.execute("1", { audioFilePath: audio, language: "en" });
    expect(result.content[0].text).toBe("hello from openai");
  });

  it("transcribes with ElevenLabs provider", async () => {
    const audio = await makeAudioFile();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ text: "hello from eleven" }),
      }),
    );

    const tool = createSttTool({
      llm: { provider: "anthropic", model: "x" },
      embedding: { provider: "openai", model: "m" },
      tts: { provider: "openai" },
      stt: { provider: "elevenlabs", apiKey: "key" },
      server: { port: 3000 },
      workspace: ".",
      sessions: ".",
    });

    const result = await tool.execute("1", { audioFilePath: audio });
    expect(result.content[0].text).toBe("hello from eleven");
  });

  it("throws for missing API key and upstream failures", async () => {
    const audio = await makeAudioFile();

    const missingKeyTool = createSttTool({
      llm: { provider: "anthropic", model: "x" },
      embedding: { provider: "openai", model: "m" },
      tts: { provider: "openai" },
      stt: { provider: "openai" },
      server: { port: 3000 },
      workspace: ".",
      sessions: ".",
    });

    await expect(missingKeyTool.execute("1", { audioFilePath: audio })).rejects.toThrow("Missing OpenAI API key");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "bad" }),
    );

    const failingTool = createSttTool({
      llm: { provider: "anthropic", model: "x" },
      embedding: { provider: "openai", model: "m" },
      tts: { provider: "openai" },
      stt: { provider: "elevenlabs", apiKey: "k" },
      server: { port: 3000 },
      workspace: ".",
      sessions: ".",
    });

    await expect(failingTool.execute("1", { audioFilePath: audio })).rejects.toThrow("ElevenLabs transcription failed");
  });

  it("throws when API response text is missing and exposes schema validation", async () => {
    const audio = await makeAudioFile();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );

    const tool = createSttTool({
      llm: { provider: "anthropic", model: "x" },
      embedding: { provider: "openai", model: "m" },
      tts: { provider: "openai" },
      stt: { provider: "openai", apiKey: "k" },
      server: { port: 3000 },
      workspace: ".",
      sessions: ".",
    });

    await expect(tool.execute("1", { audioFilePath: audio })).rejects.toThrow("response missing text");

    expect(Value.Check(tool.parameters, { audioFilePath: audio })).toBe(true);
    expect(Value.Check(tool.parameters, { language: "en" })).toBe(false);
  });
});

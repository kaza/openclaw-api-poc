import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createTtsTool } from "./tts.js";

const dirs: string[] = [];

async function makeOutputDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tts-tool-"));
  dirs.push(dir);
  return dir;
}

function baseConfig(outputDir: string) {
  return {
    llm: { provider: "anthropic", model: "x" },
    embedding: { provider: "openai", model: "m" },
    tts: { provider: "openai" as const, apiKey: "key", outputDir },
    stt: { provider: "openai" as const },
    server: { port: 3000 },
    workspace: ".",
    sessions: ".",
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createTtsTool", () => {
  it("synthesizes speech with OpenAI and writes audio file", async () => {
    const outputDir = await makeOutputDir();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from("mp3-openai").buffer,
      }),
    );

    const tool = createTtsTool(baseConfig(outputDir));
    const result = await tool.execute("1", { text: "hello" });
    const outputPath = result.content[0].text;

    const bytes = await readFile(outputPath);
    expect(bytes.length).toBeGreaterThan(0);
    expect(result.details).toMatchObject({ provider: "openai" });
  });

  it("synthesizes speech with ElevenLabs provider", async () => {
    const outputDir = await makeOutputDir();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from("mp3-eleven").buffer,
      }),
    );

    const tool = createTtsTool({
      ...baseConfig(outputDir),
      tts: {
        provider: "elevenlabs",
        apiKey: "key",
        voiceId: "voice-1",
        outputDir,
      },
    });

    const result = await tool.execute("1", { text: "hello", voice: "voice-2" });
    expect(result.details).toMatchObject({ provider: "elevenlabs" });
  });

  it("throws for missing keys/voice and upstream failures", async () => {
    const outputDir = await makeOutputDir();

    const missingOpenAiKey = createTtsTool({
      ...baseConfig(outputDir),
      tts: { provider: "openai", outputDir },
    });
    await expect(missingOpenAiKey.execute("1", { text: "x" })).rejects.toThrow("Missing OpenAI API key");

    const missingVoice = createTtsTool({
      ...baseConfig(outputDir),
      tts: { provider: "elevenlabs", apiKey: "k", outputDir },
    });
    await expect(missingVoice.execute("1", { text: "x" })).rejects.toThrow("Missing ElevenLabs voiceId");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "bad input",
      }),
    );

    const failing = createTtsTool(baseConfig(outputDir));
    await expect(failing.execute("1", { text: "x" })).rejects.toThrow("OpenAI TTS failed (400): bad input");
  });

  it("exposes a strict parameter schema", async () => {
    const outputDir = await makeOutputDir();
    const tool = createTtsTool(baseConfig(outputDir));

    expect(Value.Check(tool.parameters, { text: "hello" })).toBe(true);
    expect(Value.Check(tool.parameters, { voice: "alloy" })).toBe(false);
  });
});

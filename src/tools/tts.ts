import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { HarnessConfig } from "../config.js";

const TtsParams = Type.Object({
  text: Type.String({ description: "Text to synthesize" }),
  voice: Type.Optional(Type.String({ description: "Optional voice override" })),
});

async function synthesizeElevenLabs(config: HarnessConfig, text: string, voice?: string): Promise<Buffer> {
  if (!config.tts.apiKey) throw new Error("Missing ElevenLabs API key for TTS");

  const voiceId = voice ?? config.tts.voiceId;
  if (!voiceId) throw new Error("Missing ElevenLabs voiceId");

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": config.tts.apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      model_id: config.tts.model ?? "eleven_multilingual_v2",
      text,
    }),
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${await response.text()}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function synthesizeOpenAI(config: HarnessConfig, text: string, voice?: string): Promise<Buffer> {
  if (!config.tts.apiKey) throw new Error("Missing OpenAI API key for TTS");

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.tts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.tts.model ?? "gpt-4o-mini-tts",
      input: text,
      voice: voice ?? config.tts.voiceId ?? "alloy",
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI TTS failed (${response.status}): ${await response.text()}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function createTtsTool(config: HarnessConfig): ToolDefinition<typeof TtsParams> {
  return {
    name: "tts",
    label: "tts",
    description: "Convert text to speech and save audio to a file",
    parameters: TtsParams,
    async execute(_toolCallId, params: Static<typeof TtsParams>) {
      const bytes =
        config.tts.provider === "openai"
          ? await synthesizeOpenAI(config, params.text, params.voice)
          : await synthesizeElevenLabs(config, params.text, params.voice);

      const outputPath = path.join(config.tts.outputDir ?? config.sessions, `${randomUUID()}.mp3`);
      await writeFile(outputPath, bytes);

      return textResult(outputPath, {
        outputPath,
        provider: config.tts.provider,
        bytes: bytes.byteLength,
      });
    },
  };
}

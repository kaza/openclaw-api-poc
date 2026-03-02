import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { HarnessConfig } from "../config.js";

const TranscribeParams = Type.Object({
  audioFilePath: Type.String({ description: "Path to an audio file" }),
  language: Type.Optional(Type.String({ description: "Optional language code" })),
});

interface SttConfig {
  provider: "openai" | "elevenlabs";
  apiKey?: string;
  model?: string;
}

async function transcribeOpenAI(config: SttConfig, filePath: string, language?: string): Promise<string> {
  if (!config.apiKey) throw new Error("Missing OpenAI API key for STT");

  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(filePath));
  form.append("model", config.model ?? "whisper-1");
  if (language) form.append("language", language);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as { text?: string };
  if (!json.text) throw new Error("OpenAI STT response missing text");
  return json.text;
}

async function transcribeElevenLabs(config: SttConfig, filePath: string, language?: string): Promise<string> {
  if (!config.apiKey) throw new Error("Missing ElevenLabs API key for STT");

  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([bytes]), path.basename(filePath));
  if (language) form.append("language_code", language);

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: {
      "xi-api-key": config.apiKey,
    },
    body: form,
  });

  if (!response.ok) {
    throw new Error(`ElevenLabs transcription failed (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as { text?: string };
  if (!json.text) throw new Error("ElevenLabs STT response missing text");
  return json.text;
}

function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function createSttTool(config: HarnessConfig): ToolDefinition<typeof TranscribeParams> {
  return {
    name: "transcribe",
    label: "transcribe",
    description: "Transcribe an audio file to text",
    parameters: TranscribeParams,
    async execute(_toolCallId, params: Static<typeof TranscribeParams>) {
      const resolved = path.resolve(params.audioFilePath);
      const transcript =
        config.stt.provider === "openai"
          ? await transcribeOpenAI(config.stt, resolved, params.language)
          : await transcribeElevenLabs(config.stt, resolved, params.language);

      return textResult(transcript, {
        provider: config.stt.provider,
        audioFilePath: resolved,
      });
    },
  };
}

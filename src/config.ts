import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ALLOWED_BASH_COMMANDS } from "./security/defaults.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface HarnessConfig {
  llm: {
    provider: string;
    model: string;
    apiKey?: string;
    thinkingLevel?: ThinkingLevel;
  };
  security?: {
    allowedCommands?: string[];
  };
  embedding: {
    provider: "openai";
    model: string;
    apiKey?: string;
    dimensions?: number;
  };
  tts: {
    provider: "elevenlabs" | "openai";
    apiKey?: string;
    voiceId?: string;
    model?: string;
    outputDir?: string;
  };
  stt: {
    provider: "openai" | "elevenlabs";
    apiKey?: string;
    model?: string;
  };
  server: {
    port: number;
    token?: string;
  };
  workspace: string;
  sessions: string;
  memory?: {
    watch?: boolean;
    watchIntervalMs?: number;
  };
}

function resolveEnvVars(input: string): string {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function deepResolve<T>(value: T): T {
  if (typeof value === "string") return resolveEnvVars(value) as T;
  if (Array.isArray(value)) return value.map((v) => deepResolve(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepResolve(v as unknown);
    return out as T;
  }
  return value;
}

export interface LoadedConfig {
  config: HarnessConfig;
  configDir: string;
}

export async function loadConfig(configPath = path.resolve(process.cwd(), "config.json")): Promise<LoadedConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as HarnessConfig;
  const config = deepResolve(parsed);
  const configDir = path.dirname(configPath);

  config.workspace = path.resolve(configDir, config.workspace);
  config.sessions = path.resolve(configDir, config.sessions);

  config.memory ??= {};
  config.memory.watch ??= true;
  config.memory.watchIntervalMs ??= 10_000;

  config.security ??= {};
  config.security.allowedCommands ??= [...DEFAULT_ALLOWED_BASH_COMMANDS];

  config.server.port ??= 3000;
  config.embedding.dimensions ??= 1536;
  config.tts.outputDir = path.resolve(configDir, config.tts.outputDir ?? path.join(config.sessions, "audio"));

  await mkdir(config.workspace, { recursive: true });
  await mkdir(config.sessions, { recursive: true });
  await mkdir(config.tts.outputDir, { recursive: true });

  return { config, configDir };
}

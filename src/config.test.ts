import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("resolves env vars, applies defaults, and creates required directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));

    process.env.TEST_ANTHROPIC_KEY = "anthropic-secret";
    process.env.TEST_OPENAI_KEY = "openai-secret";
    process.env.TEST_TOKEN = "bearer-secret";

    const configPath = path.join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify(
        {
          llm: {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            apiKey: "${TEST_ANTHROPIC_KEY}",
          },
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
            apiKey: "${TEST_OPENAI_KEY}",
          },
          tts: {
            provider: "openai",
            apiKey: "${TEST_OPENAI_KEY}",
          },
          stt: {
            provider: "openai",
            apiKey: "${MISSING_ENV_SHOULD_BE_EMPTY}",
          },
          server: {
            port: 0,
            token: "${TEST_TOKEN}",
          },
          workspace: "./workspace",
          sessions: "./sessions",
        },
        null,
        2,
      ),
      "utf8",
    );

    const { config, configDir } = await loadConfig(configPath);

    expect(configDir).toBe(root);
    expect(config.llm.apiKey).toBe("anthropic-secret");
    expect(config.embedding.apiKey).toBe("openai-secret");
    expect(config.stt.apiKey).toBe("");
    expect(config.server.token).toBe("bearer-secret");

    expect(config.workspace).toBe(path.join(root, "workspace"));
    expect(config.sessions).toBe(path.join(root, "sessions"));
    expect(config.memory?.watch).toBe(true);
    expect(config.memory?.watchIntervalMs).toBe(10_000);
    expect(config.embedding.dimensions).toBe(1536);
    expect(config.tts.outputDir).toBe(path.join(root, "sessions", "audio"));
    expect(config.security?.allowedCommands).toEqual([
      "ls",
      "cat",
      "head",
      "tail",
      "wc",
      "sort",
      "uniq",
      "grep",
      "find",
      "echo",
      "date",
    ]);

    await expect(stat(config.workspace)).resolves.toBeTruthy();
    await expect(stat(config.sessions)).resolves.toBeTruthy();
    await expect(stat(config.tts.outputDir!)).resolves.toBeTruthy();

    await rm(root, { recursive: true, force: true });
  });

  it("throws when config file cannot be read", async () => {
    const missing = path.join(os.tmpdir(), `missing-config-${Date.now()}.json`);
    await expect(loadConfig(missing)).rejects.toThrow();
  });
});

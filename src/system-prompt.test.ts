import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("buildSystemPrompt", () => {
  it("concatenates available workspace files with headers", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "system-prompt-"));
    dirs.push(workspace);

    await writeFile(path.join(workspace, "AGENTS.md"), "agents body", "utf8");
    await writeFile(path.join(workspace, "TOOLS.md"), "tools body", "utf8");
    await writeFile(path.join(workspace, "MEMORY.md"), "memory body", "utf8");

    const prompt = await buildSystemPrompt(workspace);

    expect(prompt).toContain("You are running inside a lightweight enterprise agent harness.");
    expect(prompt).toContain("## AGENTS.md\nagents body");
    expect(prompt).toContain("## TOOLS.md\ntools body");
    expect(prompt).toContain("## MEMORY.md\nmemory body");
  });

  it("skips missing files gracefully", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "system-prompt-missing-"));
    dirs.push(workspace);

    await writeFile(path.join(workspace, "AGENTS.md"), "only one file", "utf8");

    const prompt = await buildSystemPrompt(workspace);
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).not.toContain("## TOOLS.md");
    expect(prompt).not.toContain("## MEMORY.md");
  });
});

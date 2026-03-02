import { mkdtemp, mkdir, readFile, readlink, rm, writeFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapUserSessionFilesystem } from "./session-bootstrap.js";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (!root) continue;
    await rm(root, { recursive: true, force: true });
  }
});

function resolveBinary(command: string): string {
  const candidates = [path.join("/usr/bin", command), path.join("/bin", command)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing test binary: ${command}`);
}

describe("bootstrapUserSessionFilesystem", () => {
  it("copies AGENTS.md, TOOLS.md, MEMORY.md into user dir", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-bootstrap-"));
    roots.push(root);

    const workspaceDir = path.join(root, "workspace");
    const userDir = path.join(root, "sessions", "user-a");

    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "agents", "utf8");
    await writeFile(path.join(workspaceDir, "TOOLS.md"), "tools", "utf8");
    await writeFile(path.join(workspaceDir, "MEMORY.md"), "memory", "utf8");

    await bootstrapUserSessionFilesystem(workspaceDir, userDir, ["ls"]);

    await expect(readFile(path.join(userDir, "AGENTS.md"), "utf8")).resolves.toBe("agents");
    await expect(readFile(path.join(userDir, "TOOLS.md"), "utf8")).resolves.toBe("tools");
    await expect(readFile(path.join(userDir, "MEMORY.md"), "utf8")).resolves.toBe("memory");
  });

  it("creates readonly command symlinks in user bin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "session-bootstrap-bin-"));
    roots.push(root);

    const workspaceDir = path.join(root, "workspace");
    const userDir = path.join(root, "sessions", "user-a");

    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(workspaceDir, "AGENTS.md"), "agents", "utf8");

    await bootstrapUserSessionFilesystem(workspaceDir, userDir, ["ls", "cat", "grep"]);

    for (const command of ["ls", "cat", "grep"]) {
      const linkPath = path.join(userDir, "bin", command);
      const stat = await lstat(linkPath);
      expect(stat.isSymbolicLink()).toBe(true);

      const target = await readlink(linkPath);
      const resolvedTarget = path.resolve(path.dirname(linkPath), target);
      expect(resolvedTarget).toBe(resolveBinary(command));
    }
  });
});

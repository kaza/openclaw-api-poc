import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePath } from "./path-validation.js";

interface TestDirs {
  root: string;
  userDir: string;
  otherUserDir: string;
  workspaceDir: string;
  outsideDir: string;
}

async function setupDirs(): Promise<TestDirs> {
  const root = await mkdtemp(path.join(os.tmpdir(), "path-validation-"));
  const userDir = path.join(root, "sessions", "user-a");
  const otherUserDir = path.join(root, "sessions", "user-b");
  const workspaceDir = path.join(root, "workspace");
  const outsideDir = path.join(root, "outside");

  await mkdir(userDir, { recursive: true });
  await mkdir(otherUserDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(path.join(userDir, "notes.txt"), "user notes", "utf8");
  await writeFile(path.join(otherUserDir, "memory.db"), "secret", "utf8");
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "workspace", "utf8");
  await writeFile(path.join(outsideDir, "outside.txt"), "outside", "utf8");

  return { root, userDir, otherUserDir, workspaceDir, outsideDir };
}

describe("validatePath", () => {
  const roots: string[] = [];

  afterEach(async () => {
    while (roots.length) {
      const root = roots.pop();
      if (!root) continue;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows reading files inside user directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const resolved = validatePath("notes.txt", dirs.userDir, dirs.workspaceDir, false);
    expect(resolved).toBe(path.join(dirs.userDir, "notes.txt"));
  });

  it("allows writing files inside user directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const resolved = validatePath("new.txt", dirs.userDir, dirs.workspaceDir, true);
    expect(resolved).toBe(path.join(dirs.userDir, "new.txt"));
  });

  it("allows edit/write path validation inside user directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const resolved = validatePath("notes.txt", dirs.userDir, dirs.workspaceDir, true);
    expect(resolved).toBe(path.join(dirs.userDir, "notes.txt"));
  });

  it("allows reading files inside workspace directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const workspaceFile = path.join(dirs.workspaceDir, "AGENTS.md");
    const resolved = validatePath(workspaceFile, dirs.userDir, dirs.workspaceDir, false);
    expect(resolved).toBe(workspaceFile);
  });

  it("blocks writing files inside workspace directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const workspaceFile = path.join(dirs.workspaceDir, "AGENTS.md");
    expect(() => validatePath(workspaceFile, dirs.userDir, dirs.workspaceDir, true)).toThrow(
      /Blocked write outside user directory/,
    );
  });

  it("blocks reading absolute paths outside allowed directories", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("/etc/passwd", dirs.userDir, dirs.workspaceDir, false)).toThrow(
      /Blocked path outside allowed directories/,
    );
  });

  it("blocks writing absolute paths outside allowed directories", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("/etc/passwd", dirs.userDir, dirs.workspaceDir, true)).toThrow(
      /Blocked path outside allowed directories|Blocked write outside user directory/,
    );
  });

  it("blocks traversal attacks to system files", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("../../etc/passwd", dirs.userDir, dirs.workspaceDir, false)).toThrow(
      /Blocked path traversal attempt/,
    );
  });

  it("blocks traversal attacks to other users", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("../user-b/memory.db", dirs.userDir, dirs.workspaceDir, false)).toThrow(
      /Blocked path traversal attempt/,
    );
  });

  it("blocks symlink escapes", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const outsideFile = path.join(dirs.outsideDir, "outside.txt");
    const fileSymlink = path.join(dirs.userDir, "escape-file");
    const dirSymlink = path.join(dirs.userDir, "escape-dir");

    try {
      await symlink(outsideFile, fileSymlink);
      await symlink(dirs.outsideDir, dirSymlink);
    } catch {
      return;
    }

    expect(() => validatePath("escape-file", dirs.userDir, dirs.workspaceDir, false)).toThrow(
      /Blocked symlink escape outside allowed directories/,
    );

    expect(() => validatePath("escape-dir/created.txt", dirs.userDir, dirs.workspaceDir, true)).toThrow(
      /Blocked symlink escape outside allowed directories|Blocked write outside user directory/,
    );
  });
});

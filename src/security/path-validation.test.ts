import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePath } from "./path-validation.js";

interface TestDirs {
  root: string;
  userDir: string;
  otherUserDir: string;
  outsideDir: string;
}

async function setupDirs(): Promise<TestDirs> {
  const root = await mkdtemp(path.join(os.tmpdir(), "path-validation-"));
  const userDir = path.join(root, "sessions", "user-a");
  const otherUserDir = path.join(root, "sessions", "user-b");
  const outsideDir = path.join(root, "outside");

  await mkdir(userDir, { recursive: true });
  await mkdir(otherUserDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });

  await writeFile(path.join(userDir, "notes.txt"), "user notes", "utf8");
  await writeFile(path.join(otherUserDir, "memory.db"), "secret", "utf8");
  await writeFile(path.join(outsideDir, "outside.txt"), "outside", "utf8");

  return { root, userDir, otherUserDir, outsideDir };
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

    const resolved = validatePath("notes.txt", dirs.userDir, false);
    expect(resolved).toBe(path.join(dirs.userDir, "notes.txt"));
  });

  it("allows writing files inside user directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const resolved = validatePath("new.txt", dirs.userDir, true);
    expect(resolved).toBe(path.join(dirs.userDir, "new.txt"));
  });

  it("allows edit/write path validation inside user directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    const resolved = validatePath("notes.txt", dirs.userDir, true);
    expect(resolved).toBe(path.join(dirs.userDir, "notes.txt"));
  });

  it("blocks reading absolute paths outside user directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("/etc/passwd", dirs.userDir, false)).toThrow(/Blocked path outside user directory/);
  });

  it("blocks writing absolute paths outside user directory", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("/etc/passwd", dirs.userDir, true)).toThrow(/Blocked path outside user directory/);
  });

  it("blocks traversal attacks to system files", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("../../etc/passwd", dirs.userDir, false)).toThrow(/Blocked path traversal attempt/);
  });

  it("blocks traversal attacks to other users", async () => {
    const dirs = await setupDirs();
    roots.push(dirs.root);

    expect(() => validatePath("../user-b/memory.db", dirs.userDir, false)).toThrow(/Blocked path traversal attempt/);
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

    expect(() => validatePath("escape-file", dirs.userDir, false)).toThrow(/Blocked symlink escape outside user directory/);

    expect(() => validatePath("escape-dir/created.txt", dirs.userDir, true)).toThrow(
      /Blocked symlink escape outside user directory/,
    );
  });
});

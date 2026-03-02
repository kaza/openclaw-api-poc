import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readlink,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const BOOTSTRAP_FILES = ["AGENTS.md", "TOOLS.md", "MEMORY.md"] as const;

function resolveBinaryTarget(command: string): string {
  const candidates = [path.join("/usr/bin", command), path.join("/bin", command)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Required whitelisted command binary not found: ${command}`);
}

async function ensureSymlink(linkPath: string, target: string): Promise<void> {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = await readlink(linkPath);
      const currentResolved = path.resolve(path.dirname(linkPath), currentTarget);
      if (currentResolved === target) return;
    }

    await unlink(linkPath);
  } catch {
    // Missing path is fine.
  }

  await symlink(target, linkPath);
}

export async function bootstrapUserSessionFilesystem(
  workspaceDir: string,
  userDir: string,
  allowedCommands: readonly string[],
): Promise<void> {
  await mkdir(userDir, { recursive: true });

  for (const fileName of BOOTSTRAP_FILES) {
    const source = path.join(workspaceDir, fileName);
    if (!existsSync(source)) continue;

    const target = path.join(userDir, fileName);
    await copyFile(source, target);
  }

  const userBinDir = path.join(userDir, "bin");
  await mkdir(userBinDir, { recursive: true });

  for (const command of allowedCommands) {
    const target = resolveBinaryTarget(command);
    const linkPath = path.join(userBinDir, command);
    await ensureSymlink(linkPath, target);
  }
}

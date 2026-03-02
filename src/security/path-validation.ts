import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

function isWithin(candidate: string, baseDir: string): boolean {
  const relative = path.relative(baseDir, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasTraversalSegment(requestedPath: string): boolean {
  return requestedPath
    .split(/[\\/]+/)
    .filter(Boolean)
    .includes("..");
}

function resolveRealTargetForRead(resolvedPath: string): string {
  if (!existsSync(resolvedPath)) return resolvedPath;
  return path.resolve(realpathSync(resolvedPath));
}

function resolveRealTargetForWrite(resolvedPath: string): string {
  let existingAncestor = resolvedPath;

  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }

  if (!existsSync(existingAncestor)) {
    return resolvedPath;
  }

  const realAncestor = path.resolve(realpathSync(existingAncestor));
  const suffix = path.relative(existingAncestor, resolvedPath);
  return path.resolve(realAncestor, suffix);
}

function resolveRealRoot(rootDir: string): string {
  const normalized = path.resolve(rootDir);
  if (!existsSync(normalized)) return normalized;
  return path.resolve(realpathSync(normalized));
}

export function validatePath(requestedPath: string, userDir: string, allowWrite: boolean): string {
  const trimmed = requestedPath.trim();
  if (!trimmed) throw new Error("Blocked path: empty path is not allowed");

  if (hasTraversalSegment(trimmed)) {
    throw new Error(`Blocked path traversal attempt: ${requestedPath}`);
  }

  const normalizedUserDir = path.resolve(userDir);
  const resolvedPath = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(normalizedUserDir, trimmed);

  if (!isWithin(resolvedPath, normalizedUserDir)) {
    throw new Error(`Blocked path outside user directory: ${requestedPath}`);
  }

  const realUserDir = resolveRealRoot(normalizedUserDir);
  const realTarget = allowWrite ? resolveRealTargetForWrite(resolvedPath) : resolveRealTargetForRead(resolvedPath);
  if (!isWithin(realTarget, realUserDir)) {
    throw new Error(`Blocked symlink escape outside user directory: ${requestedPath}`);
  }

  return resolvedPath;
}

export function validatePathInUserDir(requestedPath: string, userDir: string): string {
  return validatePath(requestedPath, userDir, true);
}

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

function resolveRequestedPath(requestedPath: string, userDir: string, workspaceDir: string): string {
  if (path.isAbsolute(requestedPath)) return path.resolve(requestedPath);

  if (requestedPath === "workspace" || requestedPath.startsWith("workspace/") || requestedPath.startsWith("workspace\\")) {
    const suffix = requestedPath.slice("workspace".length).replace(/^[/\\]+/, "");
    return path.resolve(workspaceDir, suffix);
  }

  return path.resolve(userDir, requestedPath);
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

export function validatePath(
  requestedPath: string,
  userDir: string,
  workspaceDir: string,
  allowWrite: boolean,
): string {
  const trimmed = requestedPath.trim();
  if (!trimmed) throw new Error("Blocked path: empty path is not allowed");

  if (hasTraversalSegment(trimmed)) {
    throw new Error(`Blocked path traversal attempt: ${requestedPath}`);
  }

  const normalizedUserDir = path.resolve(userDir);
  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const resolvedPath = resolveRequestedPath(trimmed, normalizedUserDir, normalizedWorkspaceDir);

  const inUserDir = isWithin(resolvedPath, normalizedUserDir);
  const inWorkspaceDir = isWithin(resolvedPath, normalizedWorkspaceDir);

  if (!inUserDir && !inWorkspaceDir) {
    throw new Error(`Blocked path outside allowed directories: ${requestedPath}`);
  }

  if (allowWrite && !inUserDir) {
    throw new Error(`Blocked write outside user directory: ${requestedPath}`);
  }

  const realUserDir = resolveRealRoot(normalizedUserDir);
  const realWorkspaceDir = resolveRealRoot(normalizedWorkspaceDir);

  const realTarget = allowWrite ? resolveRealTargetForWrite(resolvedPath) : resolveRealTargetForRead(resolvedPath);
  const inRealUserDir = isWithin(realTarget, realUserDir);
  const inRealWorkspaceDir = isWithin(realTarget, realWorkspaceDir);

  if (!inRealUserDir && !inRealWorkspaceDir) {
    throw new Error(`Blocked symlink escape outside allowed directories: ${requestedPath}`);
  }

  if (allowWrite && !inRealUserDir) {
    throw new Error(`Blocked write outside user directory: ${requestedPath}`);
  }

  return resolvedPath;
}

export function validatePathInUserDir(requestedPath: string, userDir: string): string {
  return validatePath(requestedPath, userDir, userDir, true);
}

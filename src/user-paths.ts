import path from "node:path";

export function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export interface UserPaths {
  safeUserId: string;
  rootDir: string;
  memoryDbPath: string;
  sessionDir: string;
  cronStorePath: string;
  audioDir: string;
  uploadsDir: string;
}

export function buildUserPaths(sessionsDir: string, userId: string): UserPaths {
  const safeUserId = sanitizeUserId(userId);
  const rootDir = path.join(sessionsDir, safeUserId);

  return {
    safeUserId,
    rootDir,
    memoryDbPath: path.join(rootDir, "memory.db"),
    sessionDir: path.join(rootDir, "session"),
    cronStorePath: path.join(rootDir, "cron-jobs.json"),
    audioDir: path.join(rootDir, "audio"),
    uploadsDir: path.join(rootDir, "uploads"),
  };
}

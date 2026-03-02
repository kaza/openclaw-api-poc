import { describe, expect, it } from "vitest";
import { buildUserPaths, sanitizeUserId } from "./user-paths.js";

describe("user path helpers", () => {
  it("sanitizes user ids for filesystem-safe directory names", () => {
    expect(sanitizeUserId("user/1:abc")).toBe("user_1_abc");
  });

  it("builds the expected per-user directory layout", () => {
    const paths = buildUserPaths("/tmp/sessions", "u/1");

    expect(paths.safeUserId).toBe("u_1");
    expect(paths.rootDir).toBe("/tmp/sessions/u_1");
    expect(paths.memoryDbPath).toBe("/tmp/sessions/u_1/memory.db");
    expect(paths.sessionDir).toBe("/tmp/sessions/u_1/session");
    expect(paths.cronStorePath).toBe("/tmp/sessions/u_1/cron-jobs.json");
    expect(paths.audioDir).toBe("/tmp/sessions/u_1/audio");
    expect(paths.uploadsDir).toBe("/tmp/sessions/u_1/uploads");
  });
});

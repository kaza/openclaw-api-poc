import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronStore } from "./store.js";

const tempDirs: string[] = [];

async function createStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cron-store-"));
  tempDirs.push(dir);
  return new CronStore(path.join(dir, "cron-jobs.json"));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("CronStore", () => {
  it("returns [] when file is missing or invalid", async () => {
    const store = await createStore();
    await expect(store.load()).resolves.toEqual([]);

    const badDir = await mkdtemp(path.join(os.tmpdir(), "cron-store-bad-"));
    tempDirs.push(badDir);
    const badPath = path.join(badDir, "cron-jobs.json");
    await writeFile(badPath, "{oops", "utf8");

    const bad = new CronStore(badPath);
    await expect(bad.load()).resolves.toEqual([]);
  });

  it("saves and loads jobs from JSON", async () => {
    const store = await createStore();
    const jobs = [
      {
        id: "1",
        userId: "u1",
        task: "task",
        schedule: { kind: "every", everyMs: 1000 } as const,
        createdAt: 100,
      },
    ];

    await store.save(jobs);
    await expect(store.load()).resolves.toEqual(jobs);
  });

  it("createJob sets id and createdAt", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(123456);
    const store = await createStore();

    const job = store.createJob({
      userId: "u",
      task: "run",
      schedule: { kind: "cron", expr: "* * * * *" },
    });

    expect(job.id).toBeTypeOf("string");
    expect(job.createdAt).toBe(123456);
    expect(job.task).toBe("run");
    now.mockRestore();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cronInstances: Array<{ expr: string; stop: ReturnType<typeof vi.fn>; trigger: () => void }> = [];

vi.mock("croner", () => {
  return {
    Cron: class {
      private readonly run: () => void;
      public readonly stop = vi.fn();
      constructor(expr: string, run: () => void) {
        this.run = run;
        cronInstances.push({ expr, stop: this.stop, trigger: () => this.run() });
      }
    },
  };
});

import { CronScheduler } from "./scheduler.js";
import type { CronJobRecord } from "./store.js";

function makeStore(initial: CronJobRecord[] = []) {
  let jobs = [...initial];
  let seq = 0;

  return {
    load: vi.fn(async () => [...jobs]),
    save: vi.fn(async (next: CronJobRecord[]) => {
      jobs = [...next];
    }),
    createJob: vi.fn((data: Omit<CronJobRecord, "id" | "createdAt">) => ({
      ...data,
      id: `job-${++seq}`,
      createdAt: Date.now(),
    })),
  };
}

describe("CronScheduler", () => {
  beforeEach(() => {
    cronInstances.splice(0, cronInstances.length);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("initializes from store and lists jobs with optional user filter", async () => {
    const store = makeStore([
      {
        id: "a",
        userId: "u1",
        task: "task-a",
        schedule: { kind: "every", everyMs: 1000 },
        createdAt: 1,
      },
      {
        id: "b",
        userId: "u2",
        task: "task-b",
        schedule: { kind: "cron", expr: "* * * * *" },
        createdAt: 2,
      },
    ]);

    const onFire = vi.fn(async () => {});
    const scheduler = new CronScheduler(store as never, onFire);

    await scheduler.init();

    expect(scheduler.list()).toHaveLength(2);
    expect(scheduler.list("u1").map((j) => j.id)).toEqual(["a"]);
    expect(cronInstances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("adds interval jobs, persists them, and removes existing/non-existing jobs", async () => {
    const store = makeStore();
    const onFire = vi.fn(async () => {});
    const scheduler = new CronScheduler(store as never, onFire);
    await scheduler.init();

    const job = await scheduler.add({
      userId: "u1",
      task: "interval-task",
      schedule: { kind: "every", everyMs: 250 },
      name: "repeat",
    });

    expect(job.id).toBe("job-1");
    expect(store.save).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(onFire).toHaveBeenCalledTimes(2);

    await expect(scheduler.remove("missing", "u1")).resolves.toBe(false);
    await expect(scheduler.remove(job.id, "u1")).resolves.toBe(true);

    const countAfterRemove = onFire.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(onFire.mock.calls.length).toBe(countAfterRemove);
  });

  it("handles one-shot at schedules in the past and future", async () => {
    vi.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
    const store = makeStore();
    const onFire = vi.fn(async () => {});
    const scheduler = new CronScheduler(store as never, onFire);
    await scheduler.init();

    const past = await scheduler.add({
      userId: "u",
      task: "past",
      schedule: { kind: "at", at: "2026-03-02T09:00:00.000Z" },
    });

    await Promise.resolve();
    expect(onFire).toHaveBeenCalledWith(expect.objectContaining({ id: past.id }));

    const future = await scheduler.add({
      userId: "u",
      task: "future",
      schedule: { kind: "at", at: "2026-03-02T10:00:02.000Z" },
    });

    await vi.advanceTimersByTimeAsync(1900);
    expect(onFire).not.toHaveBeenCalledWith(expect.objectContaining({ id: future.id }));

    await vi.advanceTimersByTimeAsync(200);
    expect(onFire).toHaveBeenCalledWith(expect.objectContaining({ id: future.id }));
  });

  it("schedules cron jobs and stops timers on shutdown", async () => {
    const store = makeStore();
    const onFire = vi.fn(async () => {});
    const scheduler = new CronScheduler(store as never, onFire);
    await scheduler.init();

    await scheduler.add({
      userId: "u",
      task: "cron-task",
      schedule: { kind: "cron", expr: "*/5 * * * * *" },
    });

    expect(cronInstances).toHaveLength(1);
    cronInstances[0].trigger();
    await Promise.resolve();
    expect(onFire).toHaveBeenCalledTimes(1);

    await scheduler.shutdown();
    expect(cronInstances[0].stop).toHaveBeenCalled();
  });

  it("logs and swallows onFire failures", async () => {
    const store = makeStore();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new CronScheduler(store as never, vi.fn(async () => {
      throw new Error("fire-failed");
    }));

    await scheduler.init();
    await scheduler.add({
      userId: "u",
      task: "fail",
      schedule: { kind: "every", everyMs: 100 },
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(errorSpy).toHaveBeenCalledWith(
      "[cron] job failed",
      expect.objectContaining({
        error: expect.any(Error),
      }),
    );
  });
});

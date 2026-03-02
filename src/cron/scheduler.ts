import { Cron } from "croner";
import type { CronJobRecord, CronStore, ScheduleSpec } from "./store.js";

type TimerHandle =
  | { kind: "cron"; timer: Cron }
  | { kind: "timeout"; timer: NodeJS.Timeout }
  | { kind: "interval"; timer: NodeJS.Timeout };

export interface AddCronJobInput {
  userId: string;
  task: string;
  schedule: ScheduleSpec;
  name?: string;
}

export class CronScheduler {
  private jobs: CronJobRecord[] = [];
  private timers = new Map<string, TimerHandle>();

  constructor(
    private readonly store: CronStore,
    private readonly onFire: (job: CronJobRecord) => Promise<void>,
  ) {}

  async init(): Promise<void> {
    this.jobs = await this.store.load();
    for (const job of this.jobs) this.scheduleJob(job);
  }

  async shutdown(): Promise<void> {
    for (const handle of this.timers.values()) {
      this.cancelHandle(handle);
    }
    this.timers.clear();
  }

  list(userId?: string): CronJobRecord[] {
    if (!userId) return [...this.jobs];
    return this.jobs.filter((job) => job.userId === userId);
  }

  async add(input: AddCronJobInput): Promise<CronJobRecord> {
    const job = this.store.createJob(input);
    this.jobs.push(job);
    await this.store.save(this.jobs);
    this.scheduleJob(job);
    return job;
  }

  async remove(jobId: string, userId?: string): Promise<boolean> {
    const index = this.jobs.findIndex((job) => job.id === jobId && (!userId || job.userId === userId));
    if (index === -1) return false;

    const [job] = this.jobs.splice(index, 1);
    const handle = this.timers.get(job.id);
    if (handle) {
      this.cancelHandle(handle);
      this.timers.delete(job.id);
    }

    await this.store.save(this.jobs);
    return true;
  }

  private scheduleJob(job: CronJobRecord): void {
    if (this.timers.has(job.id)) return;

    if (job.schedule.kind === "cron") {
      const timer = new Cron(job.schedule.expr, () => {
        void this.fire(job);
      });
      this.timers.set(job.id, { kind: "cron", timer });
      return;
    }

    if (job.schedule.kind === "every") {
      const timer = setInterval(() => {
        void this.fire(job);
      }, job.schedule.everyMs);
      this.timers.set(job.id, { kind: "interval", timer });
      return;
    }

    const delay = new Date(job.schedule.at).getTime() - Date.now();
    if (delay <= 0) {
      void this.fire(job).finally(() => {
        void this.remove(job.id);
      });
      return;
    }

    const timer = setTimeout(() => {
      void this.fire(job).finally(() => {
        void this.remove(job.id);
      });
    }, delay);

    this.timers.set(job.id, { kind: "timeout", timer });
  }

  private cancelHandle(handle: TimerHandle): void {
    if (handle.kind === "cron") {
      handle.timer.stop();
      return;
    }

    if (handle.kind === "interval") {
      clearInterval(handle.timer);
      return;
    }

    clearTimeout(handle.timer);
  }

  private async fire(job: CronJobRecord): Promise<void> {
    try {
      await this.onFire(job);
    } catch (error) {
      console.error("[cron] job failed", { jobId: job.id, error });
    }
  }
}

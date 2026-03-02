import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ScheduleSpec =
  | { kind: "at"; at: string }
  | { kind: "cron"; expr: string }
  | { kind: "every"; everyMs: number };

export interface CronJobRecord {
  id: string;
  userId: string;
  name?: string;
  task: string;
  schedule: ScheduleSpec;
  createdAt: number;
}

interface CronStoreFile {
  jobs: CronJobRecord[];
}

export class CronStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<CronJobRecord[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as CronStoreFile;
      return parsed.jobs ?? [];
    } catch {
      return [];
    }
  }

  async save(jobs: CronJobRecord[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ jobs }, null, 2), "utf8");
  }

  createJob(data: Omit<CronJobRecord, "id" | "createdAt">): CronJobRecord {
    return {
      ...data,
      id: randomUUID(),
      createdAt: Date.now(),
    };
  }
}

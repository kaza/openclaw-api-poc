import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { CronScheduler } from "../cron/scheduler.js";

const AtScheduleSchema = Type.Object({
  kind: Type.Literal("at"),
  at: Type.String({ description: "ISO timestamp" }),
});

const CronScheduleSchema = Type.Object({
  kind: Type.Literal("cron"),
  expr: Type.String({ description: "Cron expression" }),
});

const EveryScheduleSchema = Type.Object({
  kind: Type.Literal("every"),
  everyMs: Type.Number({ minimum: 1000 }),
});

const ScheduleSchema = Type.Union([AtScheduleSchema, CronScheduleSchema, EveryScheduleSchema]);

const CronAddParams = Type.Object({
  schedule: ScheduleSchema,
  task: Type.String({ description: "Task text to inject into the agent when triggered" }),
  name: Type.Optional(Type.String()),
});

const CronRemoveParams = Type.Object({
  id: Type.String(),
});

function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function createCronTools(scheduler: CronScheduler, userId: string): ToolDefinition[] {
  const cronAdd: ToolDefinition<typeof CronAddParams> = {
    name: "cron_add",
    label: "cron_add",
    description: "Add a scheduled task (one-shot, recurring cron, or interval)",
    parameters: CronAddParams,
    async execute(_toolCallId, params: Static<typeof CronAddParams>) {
      const job = await scheduler.add({
        userId,
        task: params.task,
        schedule: params.schedule,
        name: params.name,
      });

      return textResult(`Scheduled job ${job.id}`, job);
    },
  };

  const cronList: ToolDefinition = {
    name: "cron_list",
    label: "cron_list",
    description: "List active scheduled jobs",
    parameters: Type.Object({}),
    async execute() {
      const jobs = scheduler.list(userId);
      const text =
        jobs.length === 0
          ? "No scheduled jobs."
          : jobs
              .map((job) => `${job.id} | ${job.name ?? "(unnamed)"} | ${JSON.stringify(job.schedule)} | ${job.task}`)
              .join("\n");
      return textResult(text, { jobs });
    },
  };

  const cronRemove: ToolDefinition<typeof CronRemoveParams> = {
    name: "cron_remove",
    label: "cron_remove",
    description: "Remove a scheduled job by id",
    parameters: CronRemoveParams,
    async execute(_toolCallId, params: Static<typeof CronRemoveParams>) {
      const removed = await scheduler.remove(params.id, userId);
      return textResult(removed ? `Removed job ${params.id}` : `Job ${params.id} not found`, {
        removed,
        id: params.id,
      });
    },
  };

  return [
    cronAdd as unknown as ToolDefinition,
    cronList as unknown as ToolDefinition,
    cronRemove as unknown as ToolDefinition,
  ];
}

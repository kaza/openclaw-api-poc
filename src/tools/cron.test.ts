import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createCronTools } from "./cron.js";

describe("createCronTools", () => {
  it("creates add/list/remove tools and executes happy paths", async () => {
    const scheduler = {
      add: vi.fn().mockResolvedValue({ id: "job-1", name: "n", task: "t", schedule: { kind: "every", everyMs: 1000 } }),
      list: vi.fn().mockReturnValue([{ id: "job-1", name: "n", task: "t", schedule: { kind: "every", everyMs: 1000 } }]),
      remove: vi.fn().mockResolvedValue(true),
    };

    const tools = createCronTools(scheduler as never, "user-1");
    expect(tools.map((t) => t.name)).toEqual(["cron_add", "cron_list", "cron_remove"]);

    const addTool = tools[0];
    const listTool = tools[1];
    const removeTool = tools[2];

    const added = await addTool.execute("1", {
      task: "do it",
      schedule: { kind: "every", everyMs: 2000 },
      name: "test",
    } as never);
    expect(added.content[0].text).toContain("Scheduled job job-1");

    const listed = await listTool.execute("2", {} as never);
    expect(listed.content[0].text).toContain("job-1");

    const removed = await removeTool.execute("3", { id: "job-1" } as never);
    expect(removed.content[0].text).toContain("Removed job job-1");
  });

  it("handles empty list and remove-not-found edge cases", async () => {
    const tools = createCronTools(
      {
        add: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn().mockResolvedValue(false),
      } as never,
      "user-1",
    );

    const list = await tools[1].execute("1", {} as never);
    expect(list.content[0].text).toBe("No scheduled jobs.");

    const remove = await tools[2].execute("2", { id: "missing" } as never);
    expect(remove.content[0].text).toContain("not found");
  });

  it("exposes parameter schemas that reject invalid values", () => {
    const tools = createCronTools(
      {
        add: vi.fn(),
        list: vi.fn(),
        remove: vi.fn(),
      } as never,
      "u",
    );

    const addSchema = tools[0].parameters;
    const removeSchema = tools[2].parameters;

    expect(
      Value.Check(addSchema, {
        task: "x",
        schedule: { kind: "cron", expr: "* * * * *" },
      }),
    ).toBe(true);

    expect(
      Value.Check(addSchema, {
        task: "x",
        schedule: { kind: "every", everyMs: 100 },
      }),
    ).toBe(false);

    expect(Value.Check(removeSchema, { id: "abc" })).toBe(true);
    expect(Value.Check(removeSchema, { id: 1 })).toBe(false);
  });
});

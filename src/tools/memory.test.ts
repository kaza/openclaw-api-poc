import { describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { createMemoryTools } from "./memory.js";

describe("createMemoryTools", () => {
  it("creates memory_search and memory_store tools", async () => {
    const searchService = {
      search: vi.fn().mockResolvedValue([
        { id: 1, source: "MEMORY.md", content: "hello world", metadata: null, score: 0.99, vectorScore: 1, bm25Score: 0.8 },
      ]),
    };
    const store = {
      insertAgentMemory: vi.fn().mockReturnValue(123),
    };
    const embeddings = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    const tools = createMemoryTools(searchService as never, store as never, embeddings as never);
    expect(tools.map((t) => t.name)).toEqual(["memory_search", "memory_store"]);

    const searchRes = await tools[0].execute("1", { query: "hello", limit: 2 } as never);
    expect(searchRes.content[0].text).toContain("[MEMORY.md]");
    expect(searchService.search).toHaveBeenCalledWith("hello", 2);

    const storeRes = await tools[1].execute("2", { text: "save me", metadata: { tag: "x" } } as never);
    expect(store.insertAgentMemory).toHaveBeenCalledWith("save me", { tag: "x" }, [0.1, 0.2]);
    expect(storeRes.content[0].text).toContain("Stored memory chunk 123");
  });

  it("handles no search hits and default limit", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const tools = createMemoryTools(
      { search } as never,
      { insertAgentMemory: vi.fn() } as never,
      { embed: vi.fn() } as never,
    );

    const res = await tools[0].execute("1", { query: "none" } as never);
    expect(res.content[0].text).toBe("No matching memories found.");
    expect(search).toHaveBeenCalledWith("none", 5);
  });

  it("propagates embedding failures during memory_store", async () => {
    const tools = createMemoryTools(
      { search: vi.fn() } as never,
      { insertAgentMemory: vi.fn() } as never,
      { embed: vi.fn().mockRejectedValue(new Error("embed-error")) } as never,
    );

    await expect(tools[1].execute("1", { text: "bad" } as never)).rejects.toThrow("embed-error");
  });

  it("exposes parameter schemas with validation", () => {
    const tools = createMemoryTools(
      { search: vi.fn() } as never,
      { insertAgentMemory: vi.fn() } as never,
      { embed: vi.fn() } as never,
    );

    const searchSchema = tools[0].parameters;
    const storeSchema = tools[1].parameters;

    expect(Value.Check(searchSchema, { query: "q", limit: 1 })).toBe(true);
    expect(Value.Check(searchSchema, { query: "q", limit: 100 })).toBe(false);

    expect(Value.Check(storeSchema, { text: "memory", metadata: { a: 1 } })).toBe(true);
    expect(Value.Check(storeSchema, { metadata: {} })).toBe(false);
  });
});

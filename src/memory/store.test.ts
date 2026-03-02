import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "./store.js";

const tempDirs: string[] = [];

async function createStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-store-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "memory.db");
  const store = new MemoryStore(dbPath, 3);
  store.init();
  return store;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("MemoryStore", () => {
  it("initializes idempotently and supports source hash operations", async () => {
    const store = await createStore();
    store.init();

    expect(store.getIndexedHash("memory/file.md")).toBeNull();
    store.setIndexedHash("memory/file.md", "hash-a");
    expect(store.getIndexedHash("memory/file.md")).toBe("hash-a");

    store.close();
  });

  it("inserts chunks and fetches them by ids with metadata", async () => {
    const store = await createStore();

    const id = store.insertChunk("source-a", "alpha beta", { test: true }, [1, 0, 0]);
    expect(store.getChunksByIds([])).toEqual([]);

    const chunks = store.getChunksByIds([id]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      id,
      source: "source-a",
      content: "alpha beta",
      metadata: { test: true },
    });

    store.close();
  });

  it("supports insertAgentMemory and full-text search with safe invalid query handling", async () => {
    const store = await createStore();

    const id = store.insertAgentMemory("the quick brown fox", { origin: "agent" }, [0.5, 0.4, 0.1]);
    const hits = store.bm25Search("quick", 5);

    expect(hits.some((hit) => hit.id === id)).toBe(true);
    expect(store.bm25Search("\"unclosed", 5)).toEqual([]);

    store.close();
  });

  it("supports vectorSearch and source deletion across chunks, FTS, and vectors", async () => {
    const store = await createStore();

    const id1 = store.insertChunk("source-b", "vector apple", null, [1, 0, 0]);
    const id2 = store.insertChunk("source-b", "vector banana", null, [0, 1, 0]);

    const vectorHits = store.vectorSearch([1, 0, 0], 2);
    expect(vectorHits[0]?.id).toBe(id1);
    expect(vectorHits.map((h) => h.id)).toContain(id2);

    store.deleteSourceChunks("source-b");

    expect(store.getChunksByIds([id1, id2])).toHaveLength(0);
    expect(store.bm25Search("vector", 5)).toEqual([]);
    expect(store.vectorSearch([1, 0, 0], 5)).toEqual([]);

    store.close();
  });

  it("commits successful transactions and rolls back failing ones", async () => {
    const store = await createStore();

    const committedId = store.withTransaction(() => store.insertChunk("tx", "committed", null, [0.1, 0.2, 0.3]));
    expect(store.getChunksByIds([committedId])).toHaveLength(1);

    expect(() =>
      store.withTransaction(() => {
        store.insertChunk("tx", "rolled-back", null, [0.3, 0.2, 0.1]);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const rolledBack = store.bm25Search("rolled", 5);
    expect(rolledBack).toEqual([]);

    store.close();
  });
});

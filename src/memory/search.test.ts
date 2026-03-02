import { describe, expect, it, vi } from "vitest";
import { MemorySearchService } from "./search.js";

describe("MemorySearchService", () => {
  it("merges vector and BM25 scores and returns top results", async () => {
    const store = {
      vectorSearch: vi.fn().mockReturnValue([
        { id: 1, distance: 0.1 },
        { id: 2, distance: 0.7 },
      ]),
      bm25Search: vi.fn().mockReturnValue([
        { id: 2, bm25: 0.05 },
        { id: 3, bm25: 0.2 },
      ]),
      getChunksByIds: vi.fn().mockImplementation((ids: number[]) =>
        ids.map((id) => ({
          id,
          source: `s-${id}`,
          content: `content-${id}`,
          metadata: null,
          createdAt: 1,
          updatedAt: 1,
        })),
      ),
    };

    const embeddings = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2]),
    };

    const service = new MemorySearchService(store as never, embeddings as never);
    const results = await service.search("query", 2);

    expect(embeddings.embed).toHaveBeenCalledWith("query");
    expect(store.vectorSearch).toHaveBeenCalledWith([0.1, 0.2], 20);
    expect(store.bm25Search).toHaveBeenCalledWith("query", 20);
    expect(results).toHaveLength(2);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results.map((r) => r.id)).toEqual([2, 1]);
  });

  it("skips ids with missing chunk records and respects requested limit", async () => {
    const store = {
      vectorSearch: vi.fn().mockReturnValue([{ id: 10, distance: 0.1 }]),
      bm25Search: vi.fn().mockReturnValue([{ id: 11, bm25: 0.1 }]),
      getChunksByIds: vi.fn().mockReturnValue([
        {
          id: 10,
          source: "only-one",
          content: "exists",
          metadata: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    };

    const service = new MemorySearchService(store as never, {
      embed: vi.fn().mockResolvedValue([0.2]),
    } as never);

    const results = await service.search("q", 1);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(10);
  });

  it("propagates embedding failures", async () => {
    const service = new MemorySearchService(
      {
        vectorSearch: vi.fn(),
        bm25Search: vi.fn(),
        getChunksByIds: vi.fn(),
      } as never,
      {
        embed: vi.fn().mockRejectedValue(new Error("embed-failed")),
      } as never,
    );

    await expect(service.search("x")).rejects.toThrow("embed-failed");
  });
});

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexer, chunkMarkdown } from "./indexer.js";

const tempDirs: string[] = [];

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-indexer-"));
  tempDirs.push(dir);
  await mkdir(path.join(dir, "memory"), { recursive: true });
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("chunkMarkdown", () => {
  it("splits markdown by blocks and max size", () => {
    const chunks = chunkMarkdown("# A\n\nB\n\n" + "x".repeat(15), 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 10)).toBe(true);
  });

  it("returns empty array for blank markdown", () => {
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
  });
});

describe("MemoryIndexer", () => {
  it("start triggers initial indexing and stop is safe", async () => {
    const workspace = await makeWorkspace();
    const indexer = new MemoryIndexer(
      {
        getIndexedHash: vi.fn().mockReturnValue(null),
        withTransaction: (fn: () => unknown) => fn(),
        deleteSourceChunks: vi.fn(),
        insertChunk: vi.fn(),
        setIndexedHash: vi.fn(),
      } as never,
      { embed: vi.fn().mockResolvedValue([0.1]) } as never,
      { workspaceDir: workspace, watchIntervalMs: 60_000 },
    );

    const spy = vi.spyOn(indexer, "reindexAll").mockResolvedValue();
    await indexer.start();
    expect(spy).toHaveBeenCalledTimes(1);
    indexer.stop();
  });

  it("reindexAll scans root memory docs and memory/*.md files", async () => {
    const workspace = await makeWorkspace();
    const agents = path.join(workspace, "AGENTS.md");
    const tools = path.join(workspace, "TOOLS.md");
    const rootMemory = path.join(workspace, "MEMORY.md");
    const daily = path.join(workspace, "memory", "2026-03-02.md");
    await writeFile(agents, "agents", "utf8");
    await writeFile(tools, "tools", "utf8");
    await writeFile(rootMemory, "root", "utf8");
    await writeFile(daily, "daily", "utf8");

    const indexer = new MemoryIndexer(
      {
        getIndexedHash: vi.fn().mockReturnValue(null),
        withTransaction: (fn: () => unknown) => fn(),
        deleteSourceChunks: vi.fn(),
        insertChunk: vi.fn(),
        setIndexedHash: vi.fn(),
      } as never,
      { embed: vi.fn().mockResolvedValue([0.1]) } as never,
      { workspaceDir: workspace, watchIntervalMs: 10_000 },
    );

    const spy = vi.spyOn(indexer, "reindexFile").mockResolvedValue();
    await indexer.reindexAll();

    expect(spy).toHaveBeenCalledWith(agents);
    expect(spy).toHaveBeenCalledWith(tools);
    expect(spy).toHaveBeenCalledWith(rootMemory);
    expect(spy).toHaveBeenCalledWith(daily);
  });

  it("reindexFile indexes changed markdown and skips unchanged/non-markdown/missing files", async () => {
    const workspace = await makeWorkspace();
    const markdownPath = path.join(workspace, "memory", "note.md");
    const nonMarkdown = path.join(workspace, "memory", "note.txt");
    await writeFile(markdownPath, "First chunk\n\nSecond chunk", "utf8");
    await writeFile(nonMarkdown, "ignored", "utf8");

    const hashes = new Map<string, string>();
    const insertChunk = vi.fn();
    const setIndexedHash = vi.fn((source: string, hash: string) => hashes.set(source, hash));

    const store = {
      getIndexedHash: vi.fn((source: string) => hashes.get(source) ?? null),
      withTransaction: (fn: () => unknown) => fn(),
      deleteSourceChunks: vi.fn(),
      insertChunk,
      setIndexedHash,
    };

    const embeddings = { embed: vi.fn().mockResolvedValue([1, 2, 3]) };

    const indexer = new MemoryIndexer(store as never, embeddings as never, {
      workspaceDir: workspace,
      watchIntervalMs: 10_000,
    });

    await indexer.reindexFile(nonMarkdown);
    await indexer.reindexFile(path.join(workspace, "memory", "missing.md"));
    expect(insertChunk).not.toHaveBeenCalled();

    await indexer.reindexFile(markdownPath);
    expect(store.deleteSourceChunks).toHaveBeenCalledWith("memory/note.md");
    expect(insertChunk).toHaveBeenCalled();
    expect(setIndexedHash).toHaveBeenCalled();

    const embedCallsAfterFirstIndex = embeddings.embed.mock.calls.length;
    await indexer.reindexFile(markdownPath);
    expect(embeddings.embed).toHaveBeenCalledTimes(embedCallsAfterFirstIndex);
  });
});

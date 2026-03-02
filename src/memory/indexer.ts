import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { OpenAIEmbeddingClient } from "./embeddings.js";
import type { MemoryStore } from "./store.js";

function hashText(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

export function chunkMarkdown(markdown: string, maxChars = 1200): string[] {
  const rawBlocks = markdown
    .split(/\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let buffer = "";

  for (const block of rawBlocks) {
    const next = buffer ? `${buffer}\n\n${block}` : block;
    if (next.length <= maxChars) {
      buffer = next;
      continue;
    }

    if (buffer) chunks.push(buffer);

    if (block.length <= maxChars) {
      buffer = block;
      continue;
    }

    for (let i = 0; i < block.length; i += maxChars) {
      chunks.push(block.slice(i, i + maxChars));
    }
    buffer = "";
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

export interface MemoryIndexerOptions {
  workspaceDir: string;
  watchIntervalMs: number;
}

export class MemoryIndexer {
  private watchers: FSWatcher[] = [];
  private timer: NodeJS.Timeout | null = null;
  private debounces = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings: OpenAIEmbeddingClient,
    private readonly options: MemoryIndexerOptions,
  ) {}

  async start(): Promise<void> {
    await this.reindexAll();

    this.watchers.push(
      watch(this.options.workspaceDir, (eventType, filename) => {
        if (!filename || eventType !== "change") return;
        const target = path.join(this.options.workspaceDir, filename.toString());
        this.scheduleFile(target);
      }),
    );

    const memoryDir = path.join(this.options.workspaceDir, "memory");
    if (await exists(memoryDir)) {
      this.watchers.push(
        watch(memoryDir, () => {
          void this.reindexAll();
        }),
      );
    }

    this.timer = setInterval(() => {
      void this.reindexAll();
    }, this.options.watchIntervalMs);
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const timeout of this.debounces.values()) clearTimeout(timeout);
    this.debounces.clear();
  }

  private scheduleFile(filePath: string): void {
    const prior = this.debounces.get(filePath);
    if (prior) clearTimeout(prior);

    const timer = setTimeout(() => {
      this.debounces.delete(filePath);
      void this.reindexFile(filePath);
    }, 500);

    this.debounces.set(filePath, timer);
  }

  async reindexAll(): Promise<void> {
    const files = await this.getTargetFiles();
    for (const file of files) {
      await this.reindexFile(file);
    }
  }

  private async getTargetFiles(): Promise<string[]> {
    const files: string[] = [];

    const rootFiles = ["AGENTS.md", "TOOLS.md", "MEMORY.md"];
    for (const rootFile of rootFiles) {
      const filePath = path.join(this.options.workspaceDir, rootFile);
      if (await exists(filePath)) files.push(filePath);
    }

    const memoryDir = path.join(this.options.workspaceDir, "memory");
    if (await exists(memoryDir)) {
      const entries = await readdir(memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(path.join(memoryDir, entry.name));
        }
      }
    }

    return files;
  }

  async reindexFile(filePath: string): Promise<void> {
    if (!filePath.endsWith(".md")) return;
    if (!(await exists(filePath))) return;

    const text = await readFile(filePath, "utf8");
    const hash = hashText(text);
    const source = toPosix(path.relative(this.options.workspaceDir, filePath));

    if (this.store.getIndexedHash(source) === hash) return;

    const chunks = chunkMarkdown(text);

    const embeddings: number[][] = [];
    for (const chunk of chunks) {
      embeddings.push(await this.embeddings.embed(chunk));
    }

    this.store.withTransaction(() => {
      this.store.deleteSourceChunks(source);

      for (let i = 0; i < chunks.length; i += 1) {
        const content = chunks[i];
        const embedding = embeddings[i];
        this.store.insertChunk(
          source,
          content,
          {
            source,
            chunkIndex: i,
            chunkCount: chunks.length,
            indexedFrom: "workspace",
          },
          embedding,
        );
      }

      this.store.setIndexedHash(source, hash);
    });
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

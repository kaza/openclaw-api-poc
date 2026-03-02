import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";

export interface ChunkRecord {
  id: number;
  source: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface VectorHit {
  id: number;
  distance: number;
}

export interface Bm25Hit {
  id: number;
  bm25: number;
}

export class MemoryStore {
  private readonly db: DatabaseSync;
  private initialized = false;

  constructor(
    private readonly dbPath: string,
    private readonly embeddingDimensions: number,
  ) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { allowExtension: true });
  }

  init(): void {
    if (this.initialized) return;

    sqliteVec.load(this.db);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_index (
        source TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        source,
        tokenize = 'porter unicode61'
      );
    `);

    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${this.embeddingDimensions}]);`,
    );

    this.initialized = true;
  }

  close(): void {
    this.db.close();
  }

  getIndexedHash(source: string): string | null {
    const row = this.db
      .prepare("SELECT content_hash FROM source_index WHERE source = ?")
      .get(source) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  setIndexedHash(source: string, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO source_index (source, content_hash, indexed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET content_hash = excluded.content_hash, indexed_at = excluded.indexed_at`,
      )
      .run(source, hash, Date.now());
  }

  deleteSourceChunks(source: string): void {
    const ids = this.db.prepare("SELECT id FROM chunks WHERE source = ?").all(source) as Array<{ id: number }>;
    const deleteChunk = this.db.prepare("DELETE FROM chunks WHERE id = ?");
    const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
    const deleteVec = this.db.prepare("DELETE FROM chunks_vec WHERE rowid = ?");

    for (const { id } of ids) {
      const rowId = BigInt(id);
      deleteChunk.run(id);
      deleteFts.run(rowId);
      deleteVec.run(rowId);
    }
  }

  insertChunk(source: string, content: string, metadata: Record<string, unknown> | null, embedding: number[]): number {
    const now = Date.now();
    const inserted = this.db
      .prepare(
        "INSERT INTO chunks (source, content, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(source, content, metadata ? JSON.stringify(metadata) : null, now, now);

    const id = Number(inserted.lastInsertRowid);
    const rowId = BigInt(id);
    this.db.prepare("INSERT INTO chunks_fts (rowid, content, source) VALUES (?, ?, ?)").run(rowId, content, source);
    this.db
      .prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, vec_f32(?))")
      .run(rowId, JSON.stringify(embedding));

    return id;
  }

  insertAgentMemory(content: string, metadata: Record<string, unknown> | null, embedding: number[]): number {
    return this.insertChunk("agent-stored", content, metadata, embedding);
  }

  vectorSearch(queryEmbedding: number[], limit: number): VectorHit[] {
    const rows = this.db
      .prepare("SELECT rowid as id, distance FROM chunks_vec WHERE embedding MATCH vec_f32(?) AND k = ?")
      .all(JSON.stringify(queryEmbedding), limit) as unknown as Array<{ id: number | bigint; distance: number }>;

    return rows.map((row) => ({
      id: Number(row.id),
      distance: row.distance,
    }));
  }

  bm25Search(query: string, limit: number): Bm25Hit[] {
    try {
      const rows = this.db
        .prepare("SELECT rowid as id, bm25(chunks_fts) as bm25 FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25 LIMIT ?")
        .all(query, limit) as unknown as Array<{ id: number | bigint; bm25: number }>;

      return rows.map((row) => ({
        id: Number(row.id),
        bm25: row.bm25,
      }));
    } catch {
      return [];
    }
  }

  getChunksByIds(ids: number[]): ChunkRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, source, content, metadata, created_at, updated_at
         FROM chunks
         WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{
      id: number;
      source: string;
      content: string;
      metadata: string | null;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      content: r.content,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  withTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

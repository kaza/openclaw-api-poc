import type { OpenAIEmbeddingClient } from "./embeddings.js";
import type { ChunkRecord, MemoryStore } from "./store.js";

export interface MemorySearchResult {
  id: number;
  source: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
  vectorScore: number;
  bm25Score: number;
}

interface Scored {
  vectorScore?: number;
  bm25Score?: number;
}

function normalizeInverse(raw: number): number {
  return 1 / (1 + Math.max(raw, 0));
}

export class MemorySearchService {
  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings: OpenAIEmbeddingClient,
  ) {}

  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    const topN = Math.max(limit * 4, 20);

    const embedding = await this.embeddings.embed(query);
    const vectorHits = this.store.vectorSearch(embedding, topN);
    const bm25Hits = this.store.bm25Search(query, topN);

    const merged = new Map<number, Scored>();

    for (const hit of vectorHits) {
      const entry = merged.get(hit.id) ?? {};
      entry.vectorScore = normalizeInverse(hit.distance);
      merged.set(hit.id, entry);
    }

    for (const hit of bm25Hits) {
      const entry = merged.get(hit.id) ?? {};
      entry.bm25Score = normalizeInverse(hit.bm25);
      merged.set(hit.id, entry);
    }

    const ids = [...merged.keys()];
    const chunks = this.store.getChunksByIds(ids);
    const chunkMap = new Map<number, ChunkRecord>(chunks.map((c) => [c.id, c]));

    const scored: MemorySearchResult[] = [];
    for (const id of ids) {
      const chunk = chunkMap.get(id);
      if (!chunk) continue;

      const partial = merged.get(id);
      const vectorScore = partial?.vectorScore ?? 0;
      const bm25Score = partial?.bm25Score ?? 0;
      const score = vectorScore * 0.65 + bm25Score * 0.35;

      scored.push({
        id,
        source: chunk.source,
        content: chunk.content,
        metadata: chunk.metadata,
        score,
        vectorScore,
        bm25Score,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { MemorySearchService } from "../memory/search.js";
import type { MemoryStore } from "../memory/store.js";
import type { OpenAIEmbeddingClient } from "../memory/embeddings.js";

const MemorySearchParams = Type.Object({
  query: Type.String({ description: "Natural language search query" }),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Max results" })),
});

const MemoryStoreParams = Type.Object({
  text: Type.String({ description: "Memory text to store" }),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

function textResult(text: string, details: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

export function createMemoryTools(
  searchService: MemorySearchService,
  store: MemoryStore,
  embeddingClient: OpenAIEmbeddingClient,
): ToolDefinition[] {
  const memorySearchTool: ToolDefinition<typeof MemorySearchParams> = {
    name: "memory_search",
    label: "memory_search",
    description: "Search indexed workspace and stored memories",
    parameters: MemorySearchParams,
    async execute(_toolCallId, params: Static<typeof MemorySearchParams>) {
      const limit = params.limit ?? 5;
      const hits = await searchService.search(params.query, limit);
      const formatted = hits
        .map(
          (hit, index) =>
            `${index + 1}. [${hit.source}] score=${hit.score.toFixed(3)}\n${hit.content}`,
        )
        .join("\n\n---\n\n");

      return textResult(
        hits.length > 0 ? formatted : "No matching memories found.",
        {
          count: hits.length,
          hits,
        },
      );
    },
  };

  const memoryStoreTool: ToolDefinition<typeof MemoryStoreParams> = {
    name: "memory_store",
    label: "memory_store",
    description: "Store memory text so it can be retrieved with memory_search",
    parameters: MemoryStoreParams,
    async execute(_toolCallId, params: Static<typeof MemoryStoreParams>) {
      const embedding = await embeddingClient.embed(params.text);
      const id = store.insertAgentMemory(params.text, params.metadata ?? null, embedding);

      return textResult(`Stored memory chunk ${id}.`, {
        id,
        source: "agent-stored",
      });
    },
  };

  return [
    memorySearchTool as unknown as ToolDefinition,
    memoryStoreTool as unknown as ToolDefinition,
  ];
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingClient } from "./embeddings.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenAIEmbeddingClient", () => {
  it("returns an embedding vector on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAIEmbeddingClient({
      apiKey: "key",
      model: "text-embedding-3-small",
      dimensions: 3,
    });

    await expect(client.embed("hello")).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when API key is missing", async () => {
    const client = new OpenAIEmbeddingClient({
      model: "text-embedding-3-small",
    });

    await expect(client.embed("hello")).rejects.toThrow("Missing embedding API key");
  });

  it("throws on non-OK HTTP responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "too many requests",
      }),
    );

    const client = new OpenAIEmbeddingClient({ apiKey: "k", model: "m" });
    await expect(client.embed("hello")).rejects.toThrow("Embedding request failed (429): too many requests");
  });

  it("throws when response is missing embedding data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      }),
    );

    const client = new OpenAIEmbeddingClient({ apiKey: "k", model: "m" });
    await expect(client.embed("hello")).rejects.toThrow("Embedding response missing vector");
  });
});

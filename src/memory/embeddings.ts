export interface EmbeddingClientConfig {
  apiKey?: string;
  model: string;
  dimensions?: number;
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

export class OpenAIEmbeddingClient {
  constructor(private readonly config: EmbeddingClientConfig) {}

  async embed(text: string): Promise<number[]> {
    if (!this.config.apiKey) throw new Error("Missing embedding API key (OPENAI_API_KEY)");

    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
        dimensions: this.config.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Embedding request failed (${response.status}): ${body}`);
    }

    const json = (await response.json()) as OpenAIEmbeddingResponse;
    const embedding = json.data?.[0]?.embedding;
    if (!embedding) throw new Error("Embedding response missing vector");
    return embedding;
  }
}

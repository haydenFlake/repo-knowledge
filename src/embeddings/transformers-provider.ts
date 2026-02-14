import type { EmbeddingProvider } from "./provider.js";

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  private extractor: unknown = null;

  constructor(
    readonly modelId: string = "Xenova/jina-embeddings-v2-base-code",
    readonly dimensions: number = 768,
  ) {}

  async initialize(): Promise<void> {
    const { pipeline } = await import("@huggingface/transformers");
    this.extractor = await pipeline("feature-extraction", this.modelId, {
      dtype: "q8" as never,
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!this.extractor) throw new Error("Not initialized");
    const extractor = this.extractor as (
      texts: string[],
      options: { pooling: string; normalize: boolean },
    ) => Promise<{ tolist: () => number[][] }>;

    const output = await extractor(texts, {
      pooling: "mean",
      normalize: true,
    });
    return output.tolist().map((arr: number[]) => new Float32Array(arr));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [result] = await this.embed([text]);
    return result;
  }

  async dispose(): Promise<void> {
    this.extractor = null;
  }
}

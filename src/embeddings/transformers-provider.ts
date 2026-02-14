import type { EmbeddingProvider } from "./provider.js";

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  private extractor: unknown = null;

  constructor(
    readonly modelId: string = "Xenova/all-MiniLM-L6-v2",
    readonly dimensions: number = 384,
  ) {}

  async initialize(): Promise<void> {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      this.extractor = await pipeline("feature-extraction", this.modelId, {
        dtype: "q8",
      });
    } catch (err) {
      throw new Error(
        `Failed to initialize embedding model "${this.modelId}": ${err instanceof Error ? err.message : err}`,
      );
    }

    // Validate output dimensions match config (#17)
    const test = await this.embed(["test"]);
    if (test.length > 0 && test[0].length !== this.dimensions) {
      const actual = test[0].length;
      throw new Error(
        `Embedding dimension mismatch: model "${this.modelId}" produces ${actual}-dim vectors but config expects ${this.dimensions}`,
      );
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.extractor) throw new Error("Not initialized");
    if (texts.length === 0) return [];

    const extractor = this.extractor as (
      texts: string[],
      options: { pooling: string; normalize: boolean },
    ) => Promise<{ tolist: () => number[][] }>;

    const output = await extractor(texts, {
      pooling: "mean",
      normalize: true,
    });
    return output.tolist();
  }

  async embedQuery(text: string): Promise<number[]> {
    const [result] = await this.embed([text]);
    return result;
  }

  async dispose(): Promise<void> {
    // Attempt to call dispose on the pipeline if available
    if (this.extractor && typeof (this.extractor as { dispose?: () => Promise<void> }).dispose === "function") {
      try {
        await (this.extractor as { dispose: () => Promise<void> }).dispose();
      } catch {
        // Best-effort
      }
    }
    this.extractor = null;
  }
}

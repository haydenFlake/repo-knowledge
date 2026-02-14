import type { EmbeddingProvider } from "./provider.js";

export interface BatchEmbedOptions {
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function batchEmbed(
  texts: string[],
  provider: EmbeddingProvider,
  options: BatchEmbedOptions = {},
): Promise<number[][]> {
  const batchSize = options.batchSize ?? 32;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    try {
      const vectors = await provider.embed(batch);
      results.push(...vectors);
    } catch (err) {
      throw new Error(
        `Embedding failed on batch ${Math.floor(i / batchSize) + 1} (items ${i}-${Math.min(i + batchSize, texts.length)}): ${err instanceof Error ? err.message : err}`,
      );
    }
    options.onProgress?.(Math.min(i + batchSize, texts.length), texts.length);
  }

  return results;
}

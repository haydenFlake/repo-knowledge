import type { EmbeddingProvider } from "./provider.js";

export interface BatchEmbedOptions {
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function batchEmbed(
  texts: string[],
  provider: EmbeddingProvider,
  options: BatchEmbedOptions = {},
): Promise<Float32Array[]> {
  const batchSize = options.batchSize ?? 32;
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const vectors = await provider.embed(batch);
    results.push(...vectors);
    options.onProgress?.(Math.min(i + batchSize, texts.length), texts.length);
  }

  return results;
}

import { LanceStore } from "../storage/lance.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { SearchResult } from "./hybrid.js";

export async function vectorSearch(
  lance: LanceStore,
  queryVector: Float32Array,
  options: {
    limit?: number;
    languageFilter?: string;
    fileFilter?: string;
  } = {},
): Promise<SearchResult[]> {
  let filter: string | undefined;
  if (options.languageFilter) {
    filter = `language = '${options.languageFilter}'`;
  }

  const results = await lance.vectorSearch(queryVector, {
    limit: options.limit ?? 20,
    filter,
  });

  return results.map((r) => ({
    filePath: r.file_path,
    startLine: r.start_line,
    endLine: r.end_line,
    content: r.content,
    score: 1 / (1 + r._distance), // Convert distance to similarity score [0,1]
    matchType: "vector" as const,
    symbols: r.symbol_names ? r.symbol_names.split(" ").filter(Boolean) : [],
    language: r.language,
  }));
}

import type { LanceStore } from "../storage/lance.js";
import type { SearchResult } from "./hybrid.js";

export async function vectorSearch(
  lance: LanceStore,
  queryVector: number[],
  options: {
    limit?: number;
    languageFilter?: string;
    fileFilter?: string;
  } = {},
): Promise<SearchResult[]> {
  let filter: string | undefined;
  if (options.languageFilter) {
    // Sanitize: only allow alphanumeric, hyphens, and underscores in language names
    const sanitized = options.languageFilter.replace(/[^a-zA-Z0-9_-]/g, "");
    filter = `language = '${sanitized}'`;
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
    score: r._distance != null && r._distance >= 0 ? 1 / (1 + r._distance) : 0,
    matchType: "vector" as const,
    symbols: r.symbol_names ? r.symbol_names.split(" ").filter(Boolean) : [],
    language: r.language,
  }));
}

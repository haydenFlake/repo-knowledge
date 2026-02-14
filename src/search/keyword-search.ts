import type { SqliteStore } from "../storage/sqlite.js";
import type { SearchResult } from "./hybrid.js";

export function keywordSearch(
  sqlite: SqliteStore,
  query: string,
  options: {
    limit?: number;
    languageFilter?: string;
  } = {},
): SearchResult[] {
  // Escape special FTS5 characters and build query
  const ftsQuery = query
    .replace(/['"(){}[\]^~*?:\\!]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .join(" OR ");

  if (!ftsQuery) return [];

  try {
    const results = sqlite.searchChunks(ftsQuery, options.limit ?? 20);

    return results.map((r) => {
      const file = sqlite.getFileById(r.file_id);
      return {
        filePath: file?.path ?? "unknown",
        startLine: r.start_line,
        endLine: r.end_line,
        content: r.content,
        score: Math.abs(r.rank) > 0 ? 1 / (1 + Math.abs(r.rank)) : 0,
        matchType: "keyword" as const,
        symbols: r.symbol_ids
          ? JSON.parse(r.symbol_ids).filter(Boolean)
          : [],
        language: file?.language ?? "unknown",
      };
    });
  } catch {
    // FTS5 query syntax errors are possible
    return [];
  }
}

export function symbolSearch(
  sqlite: SqliteStore,
  query: string,
  options: {
    limit?: number;
    kind?: string;
  } = {},
): SearchResult[] {
  const ftsQuery = query
    .replace(/['"(){}[\]^~*?:\\!]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .join(" OR ");

  if (!ftsQuery) return [];

  try {
    const symbols = sqlite.searchSymbols(ftsQuery, options.limit ?? 20);

    return symbols.map((s) => {
      const file = sqlite.getFileById(s.file_id);
      const content = [
        s.signature ?? s.name,
        s.docstring ? `// ${s.docstring}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      return {
        filePath: file?.path ?? "unknown",
        startLine: s.start_line,
        endLine: s.end_line,
        content,
        score: s.importance_score + 0.1, // Boost symbol matches slightly
        matchType: "symbol" as const,
        symbols: [s.name],
        language: file?.language ?? "unknown",
      };
    });
  } catch {
    return [];
  }
}

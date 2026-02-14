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
    .filter((w) => w.length > 0)
    .join(" OR ");

  if (!ftsQuery) return [];

  try {
    // Fetch extra results when language-filtering to compensate for post-filter losses
    const fetchLimit = options.languageFilter
      ? (options.limit ?? 20) * 3
      : (options.limit ?? 20);
    const results = sqlite.searchChunks(ftsQuery, fetchLimit);

    // Batch-load unique file records to avoid N+1 queries
    const uniqueFileIds = [...new Set(results.map((r) => r.file_id))];
    const fileCache = new Map<number, { path: string; language: string | null }>();
    for (const fid of uniqueFileIds) {
      const f = sqlite.getFileById(fid);
      if (f) fileCache.set(fid, { path: f.path, language: f.language });
    }

    let mapped = results.map((r) => {
      const file = fileCache.get(r.file_id);
      return {
        filePath: file?.path ?? "unknown",
        startLine: r.start_line,
        endLine: r.end_line,
        content: r.content,
        score: Math.abs(r.rank) > 0 ? 1 / (1 + Math.abs(r.rank)) : 0,
        matchType: "keyword" as const,
        symbols: r.symbol_ids
          ? r.symbol_ids.split(/\s+/).filter(Boolean)
          : [],
        language: file?.language ?? "unknown",
      };
    });

    // Apply language filter
    if (options.languageFilter) {
      mapped = mapped.filter((r) => r.language === options.languageFilter);
    }

    return mapped;
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
    .filter((w) => w.length > 0)
    .join(" OR ");

  if (!ftsQuery) return [];

  try {
    const symbols = sqlite.searchSymbols(ftsQuery, options.limit ?? 20);

    // Batch-load unique file records to avoid N+1 queries
    const uniqueFileIds = [...new Set(symbols.map((s) => s.file_id))];
    const fileCache = new Map<number, { path: string; language: string | null }>();
    for (const fid of uniqueFileIds) {
      const f = sqlite.getFileById(fid);
      if (f) fileCache.set(fid, { path: f.path, language: f.language });
    }

    return symbols.map((s) => {
      const file = fileCache.get(s.file_id);
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
        score: Math.min(s.importance_score + 0.1, 1.0), // Normalize to [0,1]
        matchType: "symbol" as const,
        symbols: [s.name],
        language: file?.language ?? "unknown",
      };
    });
  } catch {
    return [];
  }
}

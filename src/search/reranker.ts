import type { SearchResult } from "./hybrid.js";

interface RankedSource {
  results: SearchResult[];
  weight: number;
}

/**
 * Reciprocal Rank Fusion (RRF) -- merges results from multiple ranking sources.
 * Standard formula: score = sum( weight_i / (k + rank_i) )
 */
export function reciprocalRankFusion(
  sources: RankedSource[],
  k: number = 60,
): SearchResult[] {
  const merged = new Map<
    string,
    { result: SearchResult; score: number }
  >();

  for (const { results, weight } of sources) {
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      const key = `${r.filePath}:${r.startLine}-${r.endLine}`;
      const rrfScore = weight / (k + rank + 1);

      const existing = merged.get(key);
      if (existing) {
        existing.score += rrfScore;
        // Keep the result with better content (longer usually means more context)
        if (r.content.length > existing.result.content.length) {
          existing.result = { ...r, score: existing.score };
        }
      } else {
        merged.set(key, { result: r, score: rrfScore });
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ result, score }) => ({ ...result, score }));
}

/**
 * Deduplicate results that overlap in file and line range.
 */
export function deduplicateResults(
  results: SearchResult[],
): SearchResult[] {
  const seen: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
  }> = [];

  return results.filter((r) => {
    const overlaps = seen.some(
      (s) =>
        s.filePath === r.filePath &&
        r.startLine <= s.endLine &&
        r.endLine >= s.startLine,
    );
    if (!overlaps) {
      seen.push({
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
      });
      return true;
    }
    return false;
  });
}

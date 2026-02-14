import type { Project } from "../core/project.js";
import { vectorSearch } from "./vector-search.js";
import { keywordSearch, symbolSearch } from "./keyword-search.js";
import { reciprocalRankFusion, deduplicateResults } from "./reranker.js";

export interface SearchOptions {
  query: string;
  limit?: number;
  tokenBudget?: number;
  fileFilter?: string;
  languageFilter?: string;
  searchMode?: "hybrid" | "vector" | "keyword" | "symbol";
}

export interface SearchResult {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  matchType: "vector" | "keyword" | "symbol" | "graph";
  symbols: string[];
  language: string;
}

export async function hybridSearch(
  project: Project,
  options: SearchOptions,
): Promise<SearchResult[]> {
  const mode = options.searchMode ?? "hybrid";
  const limit = options.limit ?? 10;

  const fetchLimit = Math.max(limit * 3, 30); // Fetch more than needed for reranking

  let results: SearchResult[];

  if (mode === "vector") {
    if (!project.hasEmbeddings) await project.initEmbeddings();
    const queryVector = await project.embeddings.embedQuery(options.query);
    const lance = await project.getLance();
    results = await vectorSearch(lance, queryVector, {
      limit: fetchLimit,
      languageFilter: options.languageFilter,
    });
  } else if (mode === "keyword") {
    results = keywordSearch(project.sqlite, options.query, {
      limit: fetchLimit,
      languageFilter: options.languageFilter,
    });
  } else if (mode === "symbol") {
    results = symbolSearch(project.sqlite, options.query, {
      limit: fetchLimit,
    });
  } else {
    // Hybrid: combine all three
    if (!project.hasEmbeddings) await project.initEmbeddings();
    const queryVector = await project.embeddings.embedQuery(options.query);
    const lance = await project.getLance();

    const [vecResults, kwResults, symResults] = await Promise.all([
      vectorSearch(lance, queryVector, {
        limit: fetchLimit,
        languageFilter: options.languageFilter,
      }),
      keywordSearch(project.sqlite, options.query, {
        limit: fetchLimit,
        languageFilter: options.languageFilter,
      }),
      symbolSearch(project.sqlite, options.query, {
        limit: fetchLimit,
      }),
    ]);

    results = reciprocalRankFusion([
      { results: vecResults, weight: 0.5 },
      { results: kwResults, weight: 0.3 },
      { results: symResults, weight: 0.2 },
    ]);
  }

  // Apply file filter if specified
  if (options.fileFilter) {
    const filterPattern = options.fileFilter;
    // Escape regex metacharacters, then convert glob wildcards
    const escaped = filterPattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0GLOBSTAR\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\0GLOBSTAR\0/g, ".*");
    try {
      const regex = new RegExp("^" + escaped + "$");
      results = results.filter((r) => regex.test(r.filePath));
    } catch {
      // Invalid pattern, skip filtering
    }
  }

  // Deduplicate overlapping results
  results = deduplicateResults(results);

  return results.slice(0, limit);
}

import type { Project } from "../core/project.js";
import { LanceStore } from "../storage/lance.js";
import { vectorSearch } from "./vector-search.js";
import { keywordSearch, symbolSearch } from "./keyword-search.js";
import { reciprocalRankFusion, deduplicateResults } from "./reranker.js";
import { estimateTokens } from "../utils/token-counter.js";

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
  const budget = options.tokenBudget ?? 4000;

  const fetchLimit = Math.max(limit * 3, 30); // Fetch more than needed for reranking

  let results: SearchResult[];

  if (mode === "vector") {
    if (!project.hasEmbeddings) await project.initEmbeddings();
    const queryVector = await project.embeddings.embedQuery(options.query);
    const lance = new LanceStore();
    await lance.connect(project.config.projectRoot);
    results = await vectorSearch(lance, queryVector, {
      limit: fetchLimit,
      languageFilter: options.languageFilter,
    });
    await lance.close();
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
    const lance = new LanceStore();
    await lance.connect(project.config.projectRoot);

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

    await lance.close();

    results = reciprocalRankFusion([
      { results: vecResults, weight: 0.5 },
      { results: kwResults, weight: 0.3 },
      { results: symResults, weight: 0.2 },
    ]);
  }

  // Deduplicate overlapping results
  results = deduplicateResults(results);

  // Apply token budget
  results = applyTokenBudget(results, budget);

  return results.slice(0, limit);
}

function applyTokenBudget(
  results: SearchResult[],
  budget: number,
): SearchResult[] {
  const budgeted: SearchResult[] = [];
  let tokensUsed = 0;

  for (const r of results) {
    const tokens = estimateTokens(r.content) + 20; // overhead for metadata
    if (tokensUsed + tokens > budget) {
      // Try a truncated version
      const remaining = budget - tokensUsed;
      if (remaining > 100) {
        const truncated = r.content.slice(0, remaining * 3); // ~3 chars per token
        budgeted.push({ ...r, content: truncated + "\n// ... (truncated)" });
      }
      break;
    }
    budgeted.push(r);
    tokensUsed += tokens;
  }

  return budgeted;
}

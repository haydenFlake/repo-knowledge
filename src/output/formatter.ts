import type { SearchResult } from "../search/hybrid.js";
import type { SqliteStore, SymbolRecord } from "../storage/sqlite.js";
import { estimateTokens } from "../utils/token-counter.js";

export function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlContent(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format search results as XML-tagged output optimized for LLM consumption.
 */
export function formatSearchResults(
  results: SearchResult[],
  tokenBudget: number = 4000,
): string {
  if (results.length === 0) {
    return "<search_results count=\"0\">\nNo results found.\n</search_results>";
  }

  let output = `<search_results count="${results.length}">\n`;
  let tokensUsed = estimateTokens(output);

  for (const r of results) {
    const block = formatResultBlock(r);
    const blockTokens = estimateTokens(block);

    if (tokensUsed + blockTokens > tokenBudget) {
      // Try signature-only
      const sig = formatResultSignature(r);
      const sigTokens = estimateTokens(sig);
      if (tokensUsed + sigTokens <= tokenBudget) {
        output += sig;
        tokensUsed += sigTokens;
      }
      continue;
    }

    output += block;
    tokensUsed += blockTokens;
  }

  output += "</search_results>";
  return output;
}

function formatResultBlock(r: SearchResult): string {
  const scoreStr = r.score.toFixed(2);
  return `<result file="${escapeXmlAttr(r.filePath)}" lines="${r.startLine}-${r.endLine}" language="${escapeXmlAttr(r.language)}" score="${scoreStr}" match="${r.matchType}">\n${escapeXmlContent(r.content)}\n</result>\n`;
}

function formatResultSignature(r: SearchResult): string {
  const firstLine = r.content.split("\n").slice(0, 3).join("\n");
  return `<result file="${escapeXmlAttr(r.filePath)}" lines="${r.startLine}-${r.endLine}" language="${escapeXmlAttr(r.language)}" score="${r.score.toFixed(2)}" match="${r.matchType}" truncated="true">\n${escapeXmlContent(firstLine)}\n</result>\n`;
}

/**
 * Format a file summary.
 */
export function formatFileSummary(
  filePath: string,
  language: string | null,
  lineCount: number | null,
  symbols: SymbolRecord[],
  purpose: string | null,
): string {
  let output = `<file_summary path="${escapeXmlAttr(filePath)}" language="${escapeXmlAttr(language ?? "unknown")}" lines="${lineCount ?? 0}">\n`;

  if (purpose) {
    output += `  <purpose>${escapeXmlContent(purpose)}</purpose>\n`;
  }

  const exported = symbols.filter((s) => s.exported);
  if (exported.length > 0) {
    output += "  <exports>\n";
    for (const s of exported) {
      const sig = s.signature ?? s.name;
      output += `    <symbol kind="${s.kind}" name="${escapeXmlAttr(s.name)}" lines="${s.start_line}-${s.end_line}" importance="${s.importance_score.toFixed(2)}">${escapeXmlContent(sig)}</symbol>\n`;
    }
    output += "  </exports>\n";
  }

  output += "</file_summary>";
  return output;
}

/**
 * Format a repo overview (Aider-style repo map).
 */
export function formatRepoOverview(
  stats: {
    totalFiles: number;
    totalSymbols: number;
    languages: Record<string, number>;
  },
  topSymbols: SymbolRecord[],
  sqlite: SqliteStore,
  tokenBudget: number = 2000,
): string {
  const langList = Object.entries(stats.languages)
    .map(([l, c]) => `${l}(${c})`)
    .join(", ");

  let output = `<repo_overview files="${stats.totalFiles}" symbols="${stats.totalSymbols}" languages="${escapeXmlAttr(langList)}">\n`;
  output += "  <key_symbols>\n";

  let tokensUsed = estimateTokens(output);

  // Batch-load files to avoid N+1
  const uniqueFileIds = [...new Set(topSymbols.map((s) => s.file_id))];
  const fileCache = new Map<number, string>();
  for (const fid of uniqueFileIds) {
    const f = sqlite.getFileById(fid);
    if (f) fileCache.set(fid, f.path);
  }

  for (const s of topSymbols) {
    const sig = escapeXmlContent(s.signature ?? s.name);
    const line = `    ${sig}  [${fileCache.get(s.file_id) ?? "?"}:${s.start_line}]\n`;
    const lineTokens = estimateTokens(line);

    if (tokensUsed + lineTokens > tokenBudget - 50) break;
    output += line;
    tokensUsed += lineTokens;
  }

  output += "  </key_symbols>\n";
  output += "</repo_overview>";
  return output;
}

/**
 * Format results for CLI display (not XML).
 */
export function formatSearchResultsCLI(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";

  const lines: string[] = [];
  const totalTokens = results.reduce(
    (a, r) => a + estimateTokens(r.content),
    0,
  );
  lines.push(
    `Found ${results.length} results (${totalTokens} tokens):\n`,
  );

  for (const r of results) {
    lines.push(
      `  ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(2)}) [${r.matchType}]`,
    );
    lines.push("  " + "─".repeat(50));

    // Show first 10 lines of content
    const contentLines = r.content.split("\n");
    const preview = contentLines.slice(0, 10);
    for (const line of preview) {
      lines.push(`  ${line}`);
    }
    if (contentLines.length > 10) {
      lines.push(`  ... (${contentLines.length - 10} more lines)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

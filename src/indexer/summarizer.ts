import * as path from "node:path";
import type { SqliteStore } from "../storage/sqlite.js";
import { estimateTokens } from "../utils/token-counter.js";
import { logger } from "../utils/logger.js";

/**
 * Generate heuristic summaries at file, directory, and project levels.
 * No LLM required -- uses structural analysis of the indexed data.
 */
export function generateSummaries(sqlite: SqliteStore): void {
  generateFileSummaries(sqlite);
  generateDirectorySummaries(sqlite);
  generateProjectSummary(sqlite);
}

function generateFileSummaries(sqlite: SqliteStore): void {
  const files = sqlite.getAllFiles();
  let count = 0;

  for (const file of files) {
    if (!file.id) continue;

    const symbols = sqlite.getSymbolsByFile(file.id);
    const exportedSymbols = symbols.filter((s) => s.exported);
    const deps = sqlite.getFileDependencies(file.id);

    // Infer purpose from filename and exports
    const basename = path.basename(file.path, path.extname(file.path));
    const exportNames = exportedSymbols
      .slice(0, 5)
      .map((s) => s.name)
      .join(", ");
    const depCount = deps.length;

    let purpose = `${basename} module`;
    if (exportedSymbols.length > 0) {
      const mainExport = exportedSymbols[0];
      if (mainExport.kind === "class") {
        purpose = `${mainExport.name} class definition`;
      } else if (mainExport.kind === "function") {
        purpose = `Provides ${mainExport.name} function`;
      } else if (mainExport.kind === "interface" || mainExport.kind === "type") {
        purpose = `Type definitions for ${exportNames}`;
      }
    }

    let summary = `File: ${file.path}\n`;
    summary += `Purpose: ${purpose}\n`;
    summary += `Lines: ${file.line_count ?? 0}\n`;
    if (exportNames) {
      summary += `Exports: ${exportNames}\n`;
    }
    if (depCount > 0) {
      summary += `Dependencies: ${depCount} imports\n`;
    }

    // Key symbols with signatures
    const topSymbols = exportedSymbols
      .sort((a, b) => b.importance_score - a.importance_score)
      .slice(0, 5);
    if (topSymbols.length > 0) {
      summary += "Key symbols:\n";
      for (const s of topSymbols) {
        summary += `  ${s.kind} ${s.signature ?? s.name}\n`;
      }
    }

    sqlite.upsertSummary({
      scope_type: "file",
      scope_id: String(file.id),
      content: summary,
      token_count: estimateTokens(summary),
    });

    // Also update the file's purpose field
    sqlite.upsertFile({
      ...file,
      purpose,
    });

    count++;
  }

  logger.info(`  Generated ${count} file summaries`);
}

function generateDirectorySummaries(sqlite: SqliteStore): void {
  const files = sqlite.getAllFiles();

  // Group files by directory
  const dirFiles = new Map<string, typeof files>();
  for (const file of files) {
    const dir = path.dirname(file.path);
    const existing = dirFiles.get(dir) ?? [];
    existing.push(file);
    dirFiles.set(dir, existing);
  }

  let count = 0;
  for (const [dir, dirFileList] of dirFiles) {
    const fileNames = dirFileList.map((f) => path.basename(f.path));

    // Collect all symbols in this directory
    const allSymbols = dirFileList.flatMap((f) =>
      f.id ? sqlite.getSymbolsByFile(f.id) : [],
    );

    const exportedSymbols = allSymbols
      .filter((s) => s.exported)
      .sort((a, b) => b.importance_score - a.importance_score);

    let summary = `Directory: ${dir}/\n`;
    summary += `Files: ${fileNames.join(", ")}\n`;
    summary += `Total symbols: ${allSymbols.length}\n`;

    if (exportedSymbols.length > 0) {
      summary += `Key exports: ${exportedSymbols.slice(0, 10).map((s) => s.name).join(", ")}\n`;
    }

    sqlite.upsertSummary({
      scope_type: "directory",
      scope_id: dir,
      content: summary,
      token_count: estimateTokens(summary),
    });
    count++;
  }

  logger.info(`  Generated ${count} directory summaries`);
}

function generateProjectSummary(sqlite: SqliteStore): void {
  const stats = sqlite.getStats();
  const topSymbols = sqlite.getTopSymbols(20);

  let summary = `Project Overview\n`;
  summary += `Total files: ${stats.totalFiles}\n`;
  summary += `Total symbols: ${stats.totalSymbols}\n`;
  summary += `Total graph edges: ${stats.totalEdges}\n`;
  summary += `Languages: ${Object.entries(stats.languages).map(([l, c]) => `${l}(${c})`).join(", ")}\n`;

  if (topSymbols.length > 0) {
    summary += `\nMost important symbols:\n`;
    for (const s of topSymbols.slice(0, 15)) {
      const file = sqlite.getFileById(s.file_id);
      summary += `  ${s.kind} ${s.name} [${file?.path ?? "?"}:${s.start_line}] importance=${s.importance_score.toFixed(2)}\n`;
    }
  }

  sqlite.upsertSummary({
    scope_type: "project",
    scope_id: "root",
    content: summary,
    token_count: estimateTokens(summary),
  });

  logger.info("  Generated project summary");
}

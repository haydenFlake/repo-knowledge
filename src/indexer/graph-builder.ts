import * as path from "node:path";
import type { SqliteStore, GraphEdgeRecord, SymbolRecord, ChunkRecord } from "../storage/sqlite.js";
import type { ImportDeclaration, ExtractedSymbol } from "../parser/queries/common.js";
import { logger } from "../utils/logger.js";

interface FileParseData {
  fileId: number;
  filePath: string;
  symbols: ExtractedSymbol[];
  imports: ImportDeclaration[];
}

/**
 * Build the code knowledge graph from parsed files.
 * Creates edges: calls, imports, extends, implements, references.
 */
export function buildGraph(
  sqlite: SqliteStore,
  parsedFiles: FileParseData[],
): void {
  // Build lookup maps
  const fileByPath = new Map<string, number>();
  const knownFiles = new Set<string>();
  const symbolsByName = new Map<string, Array<{ id: number; fileId: number; kind: string }>>();

  // Get all files and symbols from DB
  const allFiles = sqlite.getAllFiles();
  for (const f of allFiles) {
    if (f.id) {
      fileByPath.set(f.path, f.id);
      knownFiles.add(f.path);
    }
  }

  for (const f of allFiles) {
    if (!f.id) continue;
    const symbols = sqlite.getSymbolsByFile(f.id);
    for (const s of symbols) {
      if (!s.id) continue;
      const existing = symbolsByName.get(s.name) ?? [];
      existing.push({ id: s.id, fileId: f.id, kind: s.kind });
      symbolsByName.set(s.name, existing);
    }
  }

  // Pre-compile call-detection regexes for all symbol names (avoids O(symbols * files) regex compilation)
  const callPatternCache = new Map<string, RegExp>();
  for (const [name] of symbolsByName) {
    if (name.length >= 2) {
      callPatternCache.set(name, new RegExp(`\\b${escapeRegex(name)}\\s*\\(`));
    }
  }

  const edges: GraphEdgeRecord[] = [];

  for (const parsed of parsedFiles) {
    const { fileId, filePath, imports } = parsed;
    const sourceSymbols = sqlite.getSymbolsByFile(fileId);
    const chunks = sqlite.getChunksByFile(fileId);

    // 1. File-level import dependencies
    for (const imp of imports) {
      const resolvedPath = resolveImportPath(filePath, imp.source, knownFiles);
      if (resolvedPath) {
        const targetFileId = fileByPath.get(resolvedPath);
        if (targetFileId) {
          sqlite.insertFileDependency({
            source_file_id: fileId,
            target_file_id: targetFileId,
            dependency_type: "imports",
          });
        }
      }

      // 2. Symbol-level import edges: attribute to the symbols that actually
      //    reference the imported name, not just the first symbol in the file
      for (const name of imp.names) {
        const targets = symbolsByName.get(name);
        if (!targets) continue;

        // Find source symbols whose body references the imported name
        const namePattern = new RegExp(`\\b${escapeRegex(name)}\\b`);
        const usingSources = sourceSymbols.filter(
          (s) => s.id != null && namePattern.test(s.name !== name ? (getSymbolBody(s, chunks) ?? "") : ""),
        );

        // Fallback to first symbol if no specific user found
        const sources = usingSources.length > 0
          ? usingSources
          : sourceSymbols.filter((s) => s.id != null).slice(0, 1);

        for (const src of sources) {
          for (const target of targets) {
            edges.push({
              source_symbol_id: src.id!,
              target_symbol_id: target.id,
              edge_type: "imports",
              weight: 0.5,
              source_file_id: fileId,
              target_file_id: target.fileId,
            });
          }
        }
      }
    }

    // 3. Infer call edges from symbol references in body text
    const fileSymbols = sourceSymbols;
    // Strip chunk headers (// File: ... | Symbols: ...) to prevent false-positive matches
    const stripHeader = (content: string) => {
      const lines = content.split("\n");
      if (lines[0]?.startsWith("// File: ")) {
        return lines.slice(1).join("\n");
      }
      return content;
    };
    const fileContent = chunks.map((c) => stripHeader(c.content)).join("\n");
    const fileSymbolNames = new Set(fileSymbols.map((s) => s.name));

    // Find which external symbols are called in this file
    for (const [name, targets] of symbolsByName) {
      if (name.length < 2) continue;
      if (fileSymbolNames.has(name) && targets.every((t) => t.fileId === fileId)) continue;

      const callPattern = callPatternCache.get(name);
      if (!callPattern) continue;

      // First check if the call exists anywhere in the file
      if (!callPattern.test(fileContent)) continue;

      // Attribute calls to the correct source symbol based on line range overlap
      const sourceSymIds = new Set<number>();
      for (const chunk of chunks) {
        if (callPattern.test(stripHeader(chunk.content))) {
          for (const sym of fileSymbols) {
            if (!sym.id) continue;
            // Symbol overlaps with this chunk's line range
            if (sym.start_line <= chunk.end_line && sym.end_line >= chunk.start_line) {
              sourceSymIds.add(sym.id);
            }
          }
        }
      }

      // Fallback: attribute to first symbol if no specific overlap found
      if (sourceSymIds.size === 0) {
        const fallback = fileSymbols.find((s) => s.id != null);
        if (fallback?.id) sourceSymIds.add(fallback.id);
      }

      for (const sourceId of sourceSymIds) {
        for (const target of targets) {
          if (target.id === sourceId) continue;
          if (target.fileId === fileId) continue; // Skip intra-file calls
          edges.push({
            source_symbol_id: sourceId,
            target_symbol_id: target.id,
            edge_type: "calls",
            weight: 1.0,
            source_file_id: fileId,
            target_file_id: target.fileId,
          });
        }
      }
    }
  }

  // Batch insert edges
  if (edges.length > 0) {
    sqlite.insertEdges(edges);
    logger.info(`  Built ${edges.length} graph edges`);
  }
}

function resolveImportPath(
  currentFile: string,
  importSource: string,
  knownFiles: Set<string>,
): string | null {
  // Skip external packages
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return null;
  }

  const dir = path.dirname(currentFile);
  let resolved = path.join(dir, importSource);

  // Normalize path separators
  resolved = resolved.replace(/\\/g, "/");

  // Remove leading ./
  if (resolved.startsWith("./")) {
    resolved = resolved.slice(2);
  }

  // Try common extensions
  const extensions = [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
    ".py",
    ".rs",
    ".go",
  ];

  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }

  // Handle TS imports with .js extensions (e.g., import from "./bar.js" → bar.ts)
  if (resolved.endsWith(".js") || resolved.endsWith(".jsx")) {
    const stripped = resolved.replace(/\.jsx?$/, "");
    const tsExtensions = [".ts", ".tsx", "/index.ts", "/index.tsx"];
    for (const ext of tsExtensions) {
      const candidate = stripped + ext;
      if (knownFiles.has(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Get the body text of a symbol from the chunks that overlap its line range. */
function getSymbolBody(sym: SymbolRecord, chunks: ChunkRecord[]): string | null {
  const overlapping = chunks.filter(
    (c) => c.start_line <= sym.end_line && c.end_line >= sym.start_line,
  );
  if (overlapping.length === 0) return null;
  return overlapping.map((c) => c.content).join("\n");
}

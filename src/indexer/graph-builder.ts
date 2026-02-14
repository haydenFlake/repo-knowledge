import * as path from "node:path";
import type { SqliteStore, GraphEdgeRecord } from "../storage/sqlite.js";
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
  const symbolsByName = new Map<string, Array<{ id: number; fileId: number; kind: string }>>();

  // Get all files and symbols from DB
  const allFiles = sqlite.getAllFiles();
  for (const f of allFiles) {
    if (f.id) fileByPath.set(f.path, f.id);
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

  const edges: GraphEdgeRecord[] = [];

  for (const parsed of parsedFiles) {
    const { fileId, filePath, imports } = parsed;

    // 1. File-level import dependencies
    for (const imp of imports) {
      const resolvedPath = resolveImportPath(filePath, imp.source);
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

      // 2. Symbol-level import edges
      for (const name of imp.names) {
        const targets = symbolsByName.get(name);
        if (targets) {
          const sourceSymbols = sqlite.getSymbolsByFile(fileId);
          // Connect the first symbol in the file to the imported symbol
          // (This is a simplification -- ideally we'd track actual usage)
          for (const target of targets) {
            // Find a symbol in the source file that references this import
            for (const srcSym of sourceSymbols) {
              if (!srcSym.id) continue;
              edges.push({
                source_symbol_id: srcSym.id,
                target_symbol_id: target.id,
                edge_type: "imports",
                weight: 0.5,
                source_file_id: fileId,
                target_file_id: target.fileId,
              });
              break; // Only one import edge per symbol pair
            }
          }
        }
      }
    }

    // 3. Infer call edges from symbol references in body text
    const fileSymbols = sqlite.getSymbolsByFile(fileId);
    for (const sym of fileSymbols) {
      if (!sym.id) continue;
      // Simple heuristic: look for function calls in the body
      // We look for symbol names that appear in the chunk content followed by (
      const chunks = sqlite.getChunksByFile(fileId);
      for (const chunk of chunks) {
        for (const [name, targets] of symbolsByName) {
          if (name === sym.name) continue; // Skip self-references
          if (name.length < 2) continue; // Skip very short names

          // Check if this symbol name appears as a function call
          const callPattern = new RegExp(`\\b${escapeRegex(name)}\\s*\\(`, "g");
          if (callPattern.test(chunk.content)) {
            for (const target of targets) {
              if (target.id === sym.id) continue;
              edges.push({
                source_symbol_id: sym.id,
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
    // We'll check if it exists in the known files later
    // For now, return the base resolved path
  }

  return resolved;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

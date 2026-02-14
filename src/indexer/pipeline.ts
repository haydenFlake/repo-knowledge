import * as fs from "node:fs";
import type { Project } from "../core/project.js";
import { discoverFiles, type DiscoveredFile } from "./file-discovery.js";
import { hashContent, computeDiff } from "./hasher.js";
import { extractSymbols } from "./symbol-extractor.js";
import { chunkFile, type CodeChunk } from "./chunker.js";
import { buildGraph } from "./graph-builder.js";
import { rankSymbols } from "./ranker.js";
import { generateSummaries } from "./summarizer.js";
import { batchEmbed } from "../embeddings/batch.js";
import { TreeSitterManager } from "../parser/tree-sitter-manager.js";
import { CODE_LANGUAGES } from "../parser/languages.js";
import type { ChunkEmbeddingRecord } from "../storage/lance.js";
import type { ChunkRecord, SymbolRecord } from "../storage/sqlite.js";
import type { ExtractedSymbol, ImportDeclaration } from "../parser/queries/common.js";
import { logger } from "../utils/logger.js";

export interface IndexOptions {
  full?: boolean;
  filePatterns?: string[];
  generateSummaries?: boolean;
  dryRun?: boolean;
}

export interface IndexResult {
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  filesUnchanged: number;
  totalSymbols: number;
  totalChunks: number;
  totalEmbeddings: number;
}

interface ParsedFile {
  file: DiscoveredFile;
  source: string;
  contentHash: string;
  symbols: ExtractedSymbol[];
  imports: ImportDeclaration[];
  chunks: CodeChunk[];
}

export async function runIndexingPipeline(
  project: Project,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const config = project.config;
  const sqlite = project.sqlite;

  logger.info("Starting indexing pipeline...");

  // Phase 1: File Discovery
  logger.info("Phase 1: Discovering files...");
  const discovered = await discoverFiles(config, options.filePatterns);
  logger.info(`  Found ${discovered.length} files`);

  if (options.dryRun) {
    logger.info("Dry run complete. Would index:");
    for (const f of discovered) {
      logger.info(`  ${f.relativePath} (${f.language ?? "unknown"})`);
    }
    return {
      filesAdded: discovered.length,
      filesModified: 0,
      filesRemoved: 0,
      filesUnchanged: 0,
      totalSymbols: 0,
      totalChunks: 0,
      totalEmbeddings: 0,
    };
  }

  // Cache for file contents read during diff (avoids reading modified files twice)
  const contentCache = new Map<string, { content: string; hash: string }>();

  // Phase 2: Incremental Diff
  let filesToProcess: DiscoveredFile[];
  let addedFiles: DiscoveredFile[] = [];
  let modifiedFiles: DiscoveredFile[] = [];
  let removedPaths: string[] = [];
  let unchangedCount = 0;

  if (options.full) {
    logger.info("Phase 2: Full re-index (clearing existing data)...");
    sqlite.clearAllData();
    filesToProcess = discovered;
    addedFiles = discovered;
  } else {
    logger.info("Phase 2: Computing incremental diff...");
    const existingHashes = sqlite.getFileHashes();
    const existingSizes = sqlite.getFileSizes();
    const diff = computeDiff(discovered, existingHashes, contentCache, existingSizes);

    addedFiles = diff.added;
    modifiedFiles = diff.modified;
    filesToProcess = [...addedFiles, ...modifiedFiles];
    removedPaths = diff.removed;
    unchangedCount = diff.unchanged.length;

    logger.info(
      `  Added: ${diff.added.length}, Modified: ${diff.modified.length}, ` +
        `Removed: ${diff.removed.length}, Unchanged: ${diff.unchanged.length}`,
    );

    // Clean up LanceDB vectors for removed and modified files
    if (diff.removed.length > 0 || diff.modified.length > 0) {
      const lance = await project.getLance();

      // Remove stale vectors for deleted files
      for (const removedPath of diff.removed) {
        await lance.deleteByFilePath(removedPath);
      }

      // Clean up modified files (will be re-indexed)
      // Defer FTS rebuild until after all deletes to avoid O(total_records * N)
      for (const file of diff.modified) {
        const existing = sqlite.getFileByPath(file.relativePath);
        if (existing?.id) {
          sqlite.deleteSymbolsByFile(existing.id, false);
          sqlite.deleteChunksByFile(existing.id, false);
          sqlite.deleteEdgesByFile(existing.id);
          sqlite.deleteFileDependenciesByFile(existing.id);
        }
        await lance.deleteByFilePath(file.relativePath);
      }

      // Rebuild FTS once after all deletes
      if (diff.modified.length > 0) {
        sqlite.rebuildSymbolsFts();
        sqlite.rebuildChunksFts();
      }
    }

    // Remove deleted files from SQLite (after LanceDB cleanup)
    if (diff.removed.length > 0) {
      sqlite.deleteFilesByPaths(diff.removed);
    }
  }

  if (filesToProcess.length === 0) {
    logger.info("No files to process.");
    return {
      filesAdded: 0,
      filesModified: 0,
      filesRemoved: removedPaths.length,
      filesUnchanged: unchangedCount,
      totalSymbols: 0,
      totalChunks: 0,
      totalEmbeddings: 0,
    };
  }

  // Phase 3: Parse + Extract Symbols
  logger.info(
    `Phase 3: Parsing ${filesToProcess.length} files with tree-sitter...`,
  );
  const tsManager = new TreeSitterManager();
  await tsManager.initialize();

  const parsedFiles: ParsedFile[] = [];

  for (const file of filesToProcess) {
    try {
      // Use cached content if available (from computeDiff), otherwise read from disk
      const cached = contentCache.get(file.relativePath);
      const source = cached?.content ?? fs.readFileSync(file.absolutePath, "utf-8");
      const contentHash = cached?.hash ?? hashContent(source);

      let symbols: ExtractedSymbol[] = [];
      let imports: ImportDeclaration[] = [];

      // Only extract symbols from code languages (not JSON, YAML, etc.)
      if (file.language && CODE_LANGUAGES.has(file.language)) {
        const tree = await tsManager.parse(source, file.language);
        if (tree) {
          const result = extractSymbols(tree, source, file.language);
          symbols = result.symbols;
          imports = result.imports;
        }
      }

      // Phase 4: Chunk
      const chunks = chunkFile(
        source,
        file.relativePath,
        symbols,
        config.chunkMaxTokens,
      );

      parsedFiles.push({
        file,
        source,
        contentHash,
        symbols,
        imports,
        chunks,
      });
    } catch (err) {
      logger.warn(`  Failed to process ${file.relativePath}: ${err}`);
    }
  }

  // Free memory from content cache
  contentCache.clear();

  logger.info(
    `  Extracted ${parsedFiles.reduce((a, p) => a + p.symbols.length, 0)} symbols, ` +
      `${parsedFiles.reduce((a, p) => a + p.chunks.length, 0)} chunks`,
  );

  // Phase 5: Store file metadata + symbols + chunks in SQLite
  logger.info("Phase 5: Storing metadata...");
  const allChunksForEmbedding: Array<{
    chunkId: number;
    content: string;
    fileId: number;
    filePath: string;
    language: string;
    startLine: number;
    endLine: number;
    symbolNames: string;
  }> = [];

  for (const parsed of parsedFiles) {
    // Upsert file record
    const fileId = sqlite.upsertFile({
      path: parsed.file.relativePath,
      language: parsed.file.language,
      size_bytes: parsed.file.sizeBytes,
      content_hash: parsed.contentHash,
      line_count: parsed.source.endsWith("\n")
        ? parsed.source.split("\n").length - 1
        : parsed.source.split("\n").length,
      summary: null,
      purpose: null,
    });

    if (fileId === 0) {
      logger.warn(`  Failed to upsert file: ${parsed.file.relativePath}`);
      continue;
    }

    // Insert symbols
    const symbolRecords: SymbolRecord[] = parsed.symbols.map((s) => ({
      file_id: fileId,
      name: s.name,
      kind: s.kind,
      signature: s.signature,
      start_line: s.startLine,
      end_line: s.endLine,
      start_col: s.startCol,
      end_col: s.endCol,
      parent_symbol_id: null,
      docstring: s.docstring ?? null,
      exported: s.exported ? 1 : 0,
      importance_score: 0,
    }));

    const insertedIds = sqlite.insertSymbols(symbolRecords);

    // Resolve parent_symbol_id for nested symbols (e.g., methods inside classes)
    // Only store top-level symbols (those without a parent) as potential parents
    // to avoid collisions between methods with the same name across different classes
    const parentNameToId = new Map<string, number>();
    for (let i = 0; i < parsed.symbols.length; i++) {
      if (!parsed.symbols[i].parentName) {
        parentNameToId.set(parsed.symbols[i].name, insertedIds[i]);
      }
    }
    for (let i = 0; i < parsed.symbols.length; i++) {
      const sym = parsed.symbols[i];
      if (sym.parentName) {
        const parentId = parentNameToId.get(sym.parentName);
        if (parentId) {
          sqlite.updateSymbolParent(insertedIds[i], parentId);
        }
      }
    }

    // Insert chunks (wrapped in transaction for performance)
    sqlite.transaction(() => {
      for (const chunk of parsed.chunks) {
        const chunkRecord: ChunkRecord = {
          file_id: fileId,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          content_hash: hashContent(chunk.content),
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          symbol_ids: chunk.containedSymbolNames.join(" "),
          token_count: chunk.tokenCount,
          embedding_model: null,
          embedded_at: null,
          lance_row_id: null,
        };
        const chunkId = sqlite.insertChunk(chunkRecord, parsed.file.relativePath);

        allChunksForEmbedding.push({
          chunkId,
          content: chunk.content,
          fileId,
          filePath: parsed.file.relativePath,
          language: parsed.file.language ?? "unknown",
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbolNames: chunk.containedSymbolNames.join(" "),
        });
      }
    });
  }

  // Phase 6: Embed chunks and store in LanceDB
  logger.info(
    `Phase 6: Embedding ${allChunksForEmbedding.length} chunks...`,
  );

  if (!project.hasEmbeddings) {
    logger.info("  Initializing embedding model (first run may download the model)...");
    await project.initEmbeddings();
  }

  const texts = allChunksForEmbedding.map((c) => c.content);
  const vectors = await batchEmbed(texts, project.embeddings, {
    batchSize: 16,
    onProgress: (done, total) => {
      if (done % 64 === 0 || done === total) {
        logger.info(`  Embedded: ${done}/${total}`);
      }
    },
  });

  // Build LanceDB records
  const lanceRecords: ChunkEmbeddingRecord[] = allChunksForEmbedding.map(
    (c, i) => ({
      vector: vectors[i],
      chunk_id: c.chunkId,
      file_id: c.fileId,
      file_path: c.filePath,
      language: c.language,
      start_line: c.startLine,
      end_line: c.endLine,
      symbol_names: c.symbolNames,
      content: c.content,
    }),
  );

  if (lanceRecords.length > 0) {
    const lance = await project.getLance();
    if (options.full) {
      await lance.createTable(lanceRecords);
    } else {
      await lance.addRecords(lanceRecords);
    }
    logger.info(`  Stored ${lanceRecords.length} embeddings in LanceDB`);
  }

  // Phase 7: Build graph
  logger.info("Phase 7: Building knowledge graph...");
  const graphData = parsedFiles.map((p) => {
    const fileRecord = sqlite.getFileByPath(p.file.relativePath);
    return {
      fileId: fileRecord?.id ?? 0,
      filePath: p.file.relativePath,
      symbols: p.symbols,
      imports: p.imports,
    };
  }).filter((d) => d.fileId > 0);
  buildGraph(sqlite, graphData);

  // Phase 8: Rank symbols by importance
  logger.info("Phase 8: Running PageRank on symbol graph...");
  rankSymbols(sqlite);

  // Phase 9: Generate summaries (only when explicitly requested)
  if (options.generateSummaries) {
    logger.info("Phase 9: Generating summaries...");
    generateSummaries(sqlite);
  }

  // Update index state
  sqlite.setState("last_indexed", new Date().toISOString());
  if (options.full) {
    sqlite.setState("last_full_index", new Date().toISOString());
  }
  sqlite.setState("embedding_model", config.embeddingModel);
  const stats = sqlite.getStats();
  sqlite.setState("total_files", String(stats.totalFiles));
  sqlite.setState("total_chunks", String(stats.totalChunks));

  const result: IndexResult = {
    filesAdded: addedFiles.length,
    filesModified: modifiedFiles.length,
    filesRemoved: removedPaths.length,
    filesUnchanged: unchangedCount,
    totalSymbols: parsedFiles.reduce((a, p) => a + p.symbols.length, 0),
    totalChunks: allChunksForEmbedding.length,
    totalEmbeddings: vectors.length,
  };

  logger.info("Indexing complete!");
  logger.info(
    `  ${result.totalSymbols} symbols, ${result.totalChunks} chunks, ${result.totalEmbeddings} embeddings`,
  );

  return result;
}

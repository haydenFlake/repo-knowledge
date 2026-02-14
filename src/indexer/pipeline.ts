import * as fs from "node:fs";
import type { Project } from "../core/project.js";
import { discoverFiles, type DiscoveredFile } from "./file-discovery.js";
import { hashContent, computeDiff } from "./hasher.js";
import { extractSymbols } from "./symbol-extractor.js";
import { chunkFile, type CodeChunk } from "./chunker.js";
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

  // Phase 2: Incremental Diff
  let filesToProcess: DiscoveredFile[];
  let removedPaths: string[] = [];
  let unchangedCount = 0;

  if (options.full) {
    logger.info("Phase 2: Full re-index (clearing existing data)...");
    sqlite.clearAllData();
    filesToProcess = discovered;
  } else {
    logger.info("Phase 2: Computing incremental diff...");
    const existingHashes = sqlite.getFileHashes();
    const diff = computeDiff(discovered, existingHashes);

    filesToProcess = [...diff.added, ...diff.modified];
    removedPaths = diff.removed;
    unchangedCount = diff.unchanged.length;

    logger.info(
      `  Added: ${diff.added.length}, Modified: ${diff.modified.length}, ` +
        `Removed: ${diff.removed.length}, Unchanged: ${diff.unchanged.length}`,
    );

    // Remove deleted files from index
    if (diff.removed.length > 0) {
      sqlite.deleteFilesByPaths(diff.removed);
    }

    // Clean up modified files (will be re-indexed)
    for (const file of diff.modified) {
      const existing = sqlite.getFileByPath(file.relativePath);
      if (existing?.id) {
        sqlite.deleteSymbolsByFile(existing.id);
        sqlite.deleteChunksByFile(existing.id);
        sqlite.deleteEdgesByFile(existing.id);
        sqlite.deleteFileDependenciesByFile(existing.id);
      }
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
    const source = fs.readFileSync(file.absolutePath, "utf-8");
    const contentHash = hashContent(source);
    const lineCount = source.split("\n").length;

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
  }

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
      line_count: parsed.source.split("\n").length,
      summary: null,
      purpose: null,
    });

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
      parent_symbol_id: null, // TODO: resolve parent references
      docstring: s.docstring ?? null,
      exported: s.exported ? 1 : 0,
      importance_score: 0,
    }));

    sqlite.insertSymbols(symbolRecords);

    // Insert chunks
    for (const chunk of parsed.chunks) {
      const chunkRecord: ChunkRecord = {
        file_id: fileId,
        chunk_index: chunk.chunkIndex,
        content: chunk.content,
        content_hash: hashContent(chunk.content),
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        symbol_ids: JSON.stringify(chunk.containedSymbolNames),
        token_count: chunk.tokenCount,
        embedding_model: null,
        embedded_at: null,
        lance_row_id: null,
      };
      const chunkId = sqlite.insertChunk(chunkRecord);

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
      vector: Array.from(vectors[i]),
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
    const { LanceStore } = await import("../storage/lance.js");
    const lance = new LanceStore();
    await lance.connect(config.projectRoot);
    await lance.createTable(lanceRecords);
    await lance.close();
    logger.info(`  Stored ${lanceRecords.length} embeddings in LanceDB`);
  }

  // Update index state
  sqlite.setState("last_full_index", new Date().toISOString());
  sqlite.setState("embedding_model", config.embeddingModel);
  sqlite.setState("total_files", String(parsedFiles.length));
  sqlite.setState(
    "total_chunks",
    String(allChunksForEmbedding.length),
  );

  const result: IndexResult = {
    filesAdded: options.full
      ? filesToProcess.length
      : filesToProcess.filter((f) =>
          !sqlite.getFileByPath(f.relativePath),
        ).length,
    filesModified: options.full ? 0 : filesToProcess.length,
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

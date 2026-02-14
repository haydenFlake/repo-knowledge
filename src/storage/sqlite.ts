import Database from "better-sqlite3";
import { getSqlitePath } from "../core/config.js";

export interface FileRecord {
  id?: number;
  path: string;
  language: string | null;
  size_bytes: number;
  content_hash: string;
  last_indexed_at?: string;
  line_count: number | null;
  summary: string | null;
  purpose: string | null;
}

export interface SymbolRecord {
  id?: number;
  file_id: number;
  name: string;
  kind: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  start_col: number | null;
  end_col: number | null;
  parent_symbol_id: number | null;
  docstring: string | null;
  exported: number;
  importance_score: number;
}

export interface ChunkRecord {
  id?: number;
  file_id: number;
  chunk_index: number;
  content: string;
  content_hash: string;
  start_line: number;
  end_line: number;
  symbol_ids: string | null;
  token_count: number | null;
  embedding_model: string | null;
  embedded_at: string | null;
  lance_row_id: number | null;
}

export interface GraphEdgeRecord {
  id?: number;
  source_symbol_id: number;
  target_symbol_id: number;
  edge_type: string;
  weight: number;
  source_file_id: number | null;
  target_file_id: number | null;
}

export interface FileDependencyRecord {
  id?: number;
  source_file_id: number;
  target_file_id: number;
  dependency_type: string;
}

export interface SummaryRecord {
  id?: number;
  scope_type: string;
  scope_id: string;
  content: string;
  token_count: number | null;
  generated_at?: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  language TEXT,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  line_count INTEGER,
  summary TEXT,
  purpose TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_col INTEGER,
  end_col INTEGER,
  parent_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  docstring TEXT,
  exported INTEGER NOT NULL DEFAULT 0,
  importance_score REAL DEFAULT 0.0
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  symbol_ids TEXT,
  token_count INTEGER,
  embedding_model TEXT,
  embedded_at TEXT,
  lance_row_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);

CREATE TABLE IF NOT EXISTS graph_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  source_file_id INTEGER REFERENCES files(id),
  target_file_id INTEGER REFERENCES files(id),
  UNIQUE(source_symbol_id, target_symbol_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type);

CREATE TABLE IF NOT EXISTS file_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'imports',
  UNIQUE(source_file_id, target_file_id, dependency_type)
);
CREATE INDEX IF NOT EXISTS idx_filedeps_source ON file_dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_filedeps_target ON file_dependencies(target_file_id);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(scope_type, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_summaries_scope ON summaries(scope_type, scope_id);

CREATE TABLE IF NOT EXISTS index_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  file_path,
  symbol_names,
  tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
  name,
  signature,
  docstring,
  tokenize='unicode61'
);
`;

export class SqliteStore {
  private db: Database.Database;

  constructor(projectRoot: string) {
    const dbPath = getSqlitePath(projectRoot);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_SQL);

    // Insert schema version if not exists
    const existing = this.db
      .prepare("SELECT version FROM schema_version WHERE version = 1")
      .get();
    if (!existing) {
      this.db
        .prepare("INSERT OR IGNORE INTO schema_version (version) VALUES (1)")
        .run();
    }
  }

  // === Files ===

  upsertFile(file: FileRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO files (path, language, size_bytes, content_hash, line_count, summary, purpose)
      VALUES (@path, @language, @size_bytes, @content_hash, @line_count, @summary, @purpose)
      ON CONFLICT(path) DO UPDATE SET
        language = @language,
        size_bytes = @size_bytes,
        content_hash = @content_hash,
        last_indexed_at = datetime('now'),
        line_count = @line_count,
        summary = @summary,
        purpose = @purpose
    `);
    const result = stmt.run(file);
    return Number(result.lastInsertRowid);
  }

  getFileByPath(filePath: string): FileRecord | undefined {
    return this.db
      .prepare("SELECT * FROM files WHERE path = ?")
      .get(filePath) as FileRecord | undefined;
  }

  getFileById(id: number): FileRecord | undefined {
    return this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as
      | FileRecord
      | undefined;
  }

  getAllFiles(): FileRecord[] {
    return this.db.prepare("SELECT * FROM files ORDER BY path").all() as FileRecord[];
  }

  getAllFilePaths(): string[] {
    const rows = this.db
      .prepare("SELECT path FROM files ORDER BY path")
      .all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  getFileHashes(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT path, content_hash FROM files")
      .all() as Array<{ path: string; content_hash: string }>;
    return new Map(rows.map((r) => [r.path, r.content_hash]));
  }

  deleteFile(filePath: string): void {
    this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
  }

  deleteFilesByPaths(paths: string[]): void {
    if (paths.length === 0) return;
    const del = this.db.prepare("DELETE FROM files WHERE path = ?");
    const tx = this.db.transaction((ps: string[]) => {
      for (const p of ps) del.run(p);
    });
    tx(paths);
  }

  // === Symbols ===

  insertSymbol(symbol: SymbolRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO symbols (file_id, name, kind, signature, start_line, end_line, start_col, end_col,
                           parent_symbol_id, docstring, exported, importance_score)
      VALUES (@file_id, @name, @kind, @signature, @start_line, @end_line, @start_col, @end_col,
              @parent_symbol_id, @docstring, @exported, @importance_score)
    `);
    const result = stmt.run(symbol);

    // Update FTS
    this.db
      .prepare(
        "INSERT INTO symbols_fts (rowid, name, signature, docstring) VALUES (?, ?, ?, ?)",
      )
      .run(
        result.lastInsertRowid,
        symbol.name,
        symbol.signature ?? "",
        symbol.docstring ?? "",
      );

    return Number(result.lastInsertRowid);
  }

  insertSymbols(symbols: SymbolRecord[]): number[] {
    const ids: number[] = [];
    const tx = this.db.transaction((syms: SymbolRecord[]) => {
      for (const s of syms) {
        ids.push(this.insertSymbol(s));
      }
    });
    tx(symbols);
    return ids;
  }

  getSymbolsByFile(fileId: number): SymbolRecord[] {
    return this.db
      .prepare("SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line")
      .all(fileId) as SymbolRecord[];
  }

  getSymbolByName(
    name: string,
    kind?: string,
  ): SymbolRecord | undefined {
    if (kind && kind !== "any") {
      return this.db
        .prepare("SELECT * FROM symbols WHERE name = ? AND kind = ? LIMIT 1")
        .get(name, kind) as SymbolRecord | undefined;
    }
    return this.db
      .prepare("SELECT * FROM symbols WHERE name = ? LIMIT 1")
      .get(name) as SymbolRecord | undefined;
  }

  searchSymbols(query: string, limit: number = 20): SymbolRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM symbols_fts fts
         JOIN symbols s ON s.id = fts.rowid
         WHERE symbols_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, limit) as SymbolRecord[];
    return rows;
  }

  getTopSymbols(limit: number = 20): SymbolRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM symbols WHERE exported = 1 ORDER BY importance_score DESC LIMIT ?",
      )
      .all(limit) as SymbolRecord[];
  }

  deleteSymbolsByFile(fileId: number): void {
    // Delete FTS entries first
    const symbolIds = this.db
      .prepare("SELECT id FROM symbols WHERE file_id = ?")
      .all(fileId) as Array<{ id: number }>;
    const delFts = this.db.prepare(
      "INSERT INTO symbols_fts (symbols_fts, rowid, name, signature, docstring) VALUES('delete', ?, '', '', '')",
    );
    for (const { id } of symbolIds) {
      // We need the actual values for FTS delete
      const sym = this.db
        .prepare("SELECT name, signature, docstring FROM symbols WHERE id = ?")
        .get(id) as { name: string; signature: string | null; docstring: string | null } | undefined;
      if (sym) {
        this.db
          .prepare(
            "INSERT INTO symbols_fts (symbols_fts, rowid, name, signature, docstring) VALUES('delete', ?, ?, ?, ?)",
          )
          .run(id, sym.name, sym.signature ?? "", sym.docstring ?? "");
      }
    }
    this.db.prepare("DELETE FROM symbols WHERE file_id = ?").run(fileId);
  }

  // === Chunks ===

  insertChunk(chunk: ChunkRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, content, content_hash, start_line, end_line,
                          symbol_ids, token_count, embedding_model, embedded_at, lance_row_id)
      VALUES (@file_id, @chunk_index, @content, @content_hash, @start_line, @end_line,
              @symbol_ids, @token_count, @embedding_model, @embedded_at, @lance_row_id)
    `);
    const result = stmt.run(chunk);
    const chunkId = Number(result.lastInsertRowid);

    // Update FTS
    const file = this.getFileById(chunk.file_id);
    this.db
      .prepare(
        "INSERT INTO chunks_fts (rowid, content, file_path, symbol_names) VALUES (?, ?, ?, ?)",
      )
      .run(
        chunkId,
        chunk.content,
        file?.path ?? "",
        chunk.symbol_ids ?? "",
      );

    return chunkId;
  }

  insertChunks(chunks: ChunkRecord[]): number[] {
    const ids: number[] = [];
    const tx = this.db.transaction((chs: ChunkRecord[]) => {
      for (const c of chs) {
        ids.push(this.insertChunk(c));
      }
    });
    tx(chunks);
    return ids;
  }

  getChunksByFile(fileId: number): ChunkRecord[] {
    return this.db
      .prepare("SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index")
      .all(fileId) as ChunkRecord[];
  }

  searchChunks(query: string, limit: number = 20): Array<ChunkRecord & { rank: number }> {
    return this.db
      .prepare(
        `SELECT c.*, fts.rank FROM chunks_fts fts
         JOIN chunks c ON c.id = fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(query, limit) as Array<ChunkRecord & { rank: number }>;
  }

  getExistingChunkHashes(): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT content_hash FROM chunks WHERE embedding_model IS NOT NULL")
      .all() as Array<{ content_hash: string }>;
    return new Set(rows.map((r) => r.content_hash));
  }

  deleteChunksByFile(fileId: number): void {
    // Delete FTS entries first
    const chunks = this.db
      .prepare("SELECT id, content FROM chunks WHERE file_id = ?")
      .all(fileId) as Array<{ id: number; content: string }>;
    const file = this.getFileById(fileId);
    for (const chunk of chunks) {
      this.db
        .prepare(
          "INSERT INTO chunks_fts (chunks_fts, rowid, content, file_path, symbol_names) VALUES('delete', ?, ?, ?, ?)",
        )
        .run(chunk.id, chunk.content, file?.path ?? "", "");
    }
    this.db.prepare("DELETE FROM chunks WHERE file_id = ?").run(fileId);
  }

  // === Graph Edges ===

  insertEdge(edge: GraphEdgeRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO graph_edges (source_symbol_id, target_symbol_id, edge_type, weight, source_file_id, target_file_id)
         VALUES (@source_symbol_id, @target_symbol_id, @edge_type, @weight, @source_file_id, @target_file_id)`,
      )
      .run(edge);
  }

  insertEdges(edges: GraphEdgeRecord[]): void {
    const tx = this.db.transaction((es: GraphEdgeRecord[]) => {
      for (const e of es) this.insertEdge(e);
    });
    tx(edges);
  }

  getEdgesFrom(symbolId: number, edgeTypes?: string[]): GraphEdgeRecord[] {
    if (edgeTypes && edgeTypes.length > 0) {
      const placeholders = edgeTypes.map(() => "?").join(",");
      return this.db
        .prepare(
          `SELECT * FROM graph_edges WHERE source_symbol_id = ? AND edge_type IN (${placeholders})`,
        )
        .all(symbolId, ...edgeTypes) as GraphEdgeRecord[];
    }
    return this.db
      .prepare("SELECT * FROM graph_edges WHERE source_symbol_id = ?")
      .all(symbolId) as GraphEdgeRecord[];
  }

  getEdgesTo(symbolId: number, edgeTypes?: string[]): GraphEdgeRecord[] {
    if (edgeTypes && edgeTypes.length > 0) {
      const placeholders = edgeTypes.map(() => "?").join(",");
      return this.db
        .prepare(
          `SELECT * FROM graph_edges WHERE target_symbol_id = ? AND edge_type IN (${placeholders})`,
        )
        .all(symbolId, ...edgeTypes) as GraphEdgeRecord[];
    }
    return this.db
      .prepare("SELECT * FROM graph_edges WHERE target_symbol_id = ?")
      .all(symbolId) as GraphEdgeRecord[];
  }

  getAllEdges(): GraphEdgeRecord[] {
    return this.db
      .prepare("SELECT * FROM graph_edges")
      .all() as GraphEdgeRecord[];
  }

  deleteEdgesByFile(fileId: number): void {
    this.db
      .prepare(
        "DELETE FROM graph_edges WHERE source_file_id = ? OR target_file_id = ?",
      )
      .run(fileId, fileId);
  }

  // === File Dependencies ===

  insertFileDependency(dep: FileDependencyRecord): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO file_dependencies (source_file_id, target_file_id, dependency_type)
         VALUES (@source_file_id, @target_file_id, @dependency_type)`,
      )
      .run(dep);
  }

  getFileDependencies(fileId: number): FileDependencyRecord[] {
    return this.db
      .prepare("SELECT * FROM file_dependencies WHERE source_file_id = ?")
      .all(fileId) as FileDependencyRecord[];
  }

  getFileDependents(fileId: number): FileDependencyRecord[] {
    return this.db
      .prepare("SELECT * FROM file_dependencies WHERE target_file_id = ?")
      .all(fileId) as FileDependencyRecord[];
  }

  deleteFileDependenciesByFile(fileId: number): void {
    this.db
      .prepare(
        "DELETE FROM file_dependencies WHERE source_file_id = ? OR target_file_id = ?",
      )
      .run(fileId, fileId);
  }

  // === Summaries ===

  upsertSummary(summary: SummaryRecord): void {
    this.db
      .prepare(
        `INSERT INTO summaries (scope_type, scope_id, content, token_count)
         VALUES (@scope_type, @scope_id, @content, @token_count)
         ON CONFLICT(scope_type, scope_id) DO UPDATE SET
           content = @content,
           token_count = @token_count,
           generated_at = datetime('now')`,
      )
      .run(summary);
  }

  getSummary(scopeType: string, scopeId: string): SummaryRecord | undefined {
    return this.db
      .prepare(
        "SELECT * FROM summaries WHERE scope_type = ? AND scope_id = ?",
      )
      .get(scopeType, scopeId) as SummaryRecord | undefined;
  }

  // === Index State ===

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO index_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`,
      )
      .run(key, value, value);
  }

  getState(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM index_state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  // === Stats ===

  getStats(): {
    totalFiles: number;
    totalSymbols: number;
    totalChunks: number;
    totalEdges: number;
    languages: Record<string, number>;
  } {
    const totalFiles = (
      this.db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }
    ).c;
    const totalSymbols = (
      this.db.prepare("SELECT COUNT(*) as c FROM symbols").get() as {
        c: number;
      }
    ).c;
    const totalChunks = (
      this.db.prepare("SELECT COUNT(*) as c FROM chunks").get() as {
        c: number;
      }
    ).c;
    const totalEdges = (
      this.db.prepare("SELECT COUNT(*) as c FROM graph_edges").get() as {
        c: number;
      }
    ).c;

    const langRows = this.db
      .prepare(
        "SELECT language, COUNT(*) as c FROM files WHERE language IS NOT NULL GROUP BY language",
      )
      .all() as Array<{ language: string; c: number }>;
    const languages: Record<string, number> = {};
    for (const row of langRows) {
      languages[row.language] = row.c;
    }

    return { totalFiles, totalSymbols, totalChunks, totalEdges, languages };
  }

  // === Bulk operations ===

  clearAllData(): void {
    this.db.exec("DELETE FROM chunks_fts");
    this.db.exec("DELETE FROM symbols_fts");
    this.db.exec("DELETE FROM graph_edges");
    this.db.exec("DELETE FROM file_dependencies");
    this.db.exec("DELETE FROM summaries");
    this.db.exec("DELETE FROM chunks");
    this.db.exec("DELETE FROM symbols");
    this.db.exec("DELETE FROM files");
    this.db.exec("DELETE FROM index_state");
  }

  updateSymbolImportance(symbolId: number, score: number): void {
    this.db
      .prepare("UPDATE symbols SET importance_score = ? WHERE id = ?")
      .run(score, symbolId);
  }

  updateSymbolImportanceBatch(
    updates: Array<{ id: number; score: number }>,
  ): void {
    const stmt = this.db.prepare(
      "UPDATE symbols SET importance_score = ? WHERE id = ?",
    );
    const tx = this.db.transaction(
      (ups: Array<{ id: number; score: number }>) => {
        for (const u of ups) stmt.run(u.score, u.id);
      },
    );
    tx(updates);
  }

  close(): void {
    this.db.close();
  }

  // Expose for transactions in pipeline
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

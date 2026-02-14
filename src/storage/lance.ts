import * as lancedb from "@lancedb/lancedb";
import { getVectorsDir } from "../core/config.js";

export interface ChunkEmbeddingRecord {
  [key: string]: unknown;
  vector: number[] | Float32Array;
  chunk_id: number;
  file_id: number;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  symbol_names: string;
  content: string;
}

export class LanceStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  async connect(projectRoot: string): Promise<void> {
    const vectorsDir = getVectorsDir(projectRoot);
    this.db = await lancedb.connect(vectorsDir);
  }

  async ensureTable(): Promise<lancedb.Table | null> {
    if (!this.db) throw new Error("Not connected");
    const tables = await this.db.tableNames();
    if (tables.includes("chunks")) {
      this.table = await this.db.openTable("chunks");
      return this.table;
    }
    return null;
  }

  async createTable(records: ChunkEmbeddingRecord[]): Promise<lancedb.Table> {
    if (!this.db) throw new Error("Not connected");

    // Drop existing table if it exists
    const tables = await this.db.tableNames();
    if (tables.includes("chunks")) {
      await this.db.dropTable("chunks");
    }

    this.table = await this.db.createTable("chunks", records);
    return this.table;
  }

  async addRecords(records: ChunkEmbeddingRecord[]): Promise<void> {
    if (!this.table) {
      await this.createTable(records);
      return;
    }
    await this.table.add(records);
  }

  async vectorSearch(
    queryVector: Float32Array,
    options: {
      limit?: number;
      filter?: string;
    } = {},
  ): Promise<Array<ChunkEmbeddingRecord & { _distance: number }>> {
    if (!this.table) {
      const t = await this.ensureTable();
      if (!t) return [];
    }

    let query = this.table!.search(queryVector).limit(options.limit ?? 20);

    if (options.filter) {
      query = query.where(options.filter);
    }

    const results = await query.toArray();
    return results as Array<ChunkEmbeddingRecord & { _distance: number }>;
  }

  async close(): Promise<void> {
    this.db = null;
    this.table = null;
  }
}

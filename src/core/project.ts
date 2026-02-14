import {
  type ProjectConfig,
  type InitOptions,
  initProject,
  loadConfig,
  isInitialized,
} from "./config.js";
import { NotInitializedError } from "./errors.js";
import { SqliteStore } from "../storage/sqlite.js";
import { LanceStore } from "../storage/lance.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

export class Project {
  readonly config: ProjectConfig;
  readonly sqlite: SqliteStore;
  private _embeddings: EmbeddingProvider | null = null;
  private _embeddingInitPromise: Promise<void> | null = null;
  private _lance: LanceStore | null = null;
  private _closed = false;

  private constructor(config: ProjectConfig, sqlite: SqliteStore) {
    this.config = config;
    this.sqlite = sqlite;
  }

  get embeddings(): EmbeddingProvider {
    if (!this._embeddings) {
      throw new Error(
        "Embedding provider not initialized. Call project.initEmbeddings() first.",
      );
    }
    return this._embeddings;
  }

  get hasEmbeddings(): boolean {
    return this._embeddings !== null;
  }

  /** Get or create a long-lived LanceStore connection. */
  async getLance(): Promise<LanceStore> {
    if (this._lance) return this._lance;
    const lance = new LanceStore();
    await lance.connect(this.config.dataDir);
    this._lance = lance;
    return lance;
  }

  async initEmbeddings(provider?: EmbeddingProvider): Promise<void> {
    // Re-entrancy guard: if already initializing, wait for that to finish
    if (this._embeddingInitPromise) {
      await this._embeddingInitPromise;
      return;
    }

    if (this._embeddings) return;

    this._embeddingInitPromise = (async () => {
      try {
        if (provider) {
          this._embeddings = provider;
          await provider.initialize();
          return;
        }

        // Lazy import to avoid loading transformers when not needed
        const { TransformersEmbeddingProvider } = await import(
          "../embeddings/transformers-provider.js"
        );
        const ep = new TransformersEmbeddingProvider(
          this.config.embeddingModel,
          this.config.embeddingDimensions,
        );
        await ep.initialize();
        this._embeddings = ep;
      } finally {
        this._embeddingInitPromise = null;
      }
    })();

    await this._embeddingInitPromise;
  }

  static async init(
    projectRoot: string,
    options?: InitOptions,
  ): Promise<Project> {
    const config = initProject(projectRoot, options);
    let sqlite: SqliteStore;
    try {
      sqlite = new SqliteStore(config.dataDir);
    } catch (err) {
      throw new Error(
        `Failed to open database at ${config.dataDir}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return new Project(config, sqlite);
  }

  static async open(projectRoot: string, dataDir?: string): Promise<Project> {
    if (!isInitialized(projectRoot, dataDir)) {
      throw new NotInitializedError(projectRoot);
    }
    const config = loadConfig(projectRoot, dataDir);
    let sqlite: SqliteStore;
    try {
      sqlite = new SqliteStore(config.dataDir);
    } catch (err) {
      throw new Error(
        `Failed to open database at ${config.dataDir}: ${err instanceof Error ? err.message : err}`,
      );
    }
    return new Project(config, sqlite);
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;

    if (this._embeddings) {
      await this._embeddings.dispose();
      this._embeddings = null;
    }
    if (this._lance) {
      await this._lance.close();
      this._lance = null;
    }
    try {
      this.sqlite.close();
    } catch {
      // Already closed -- ignore
    }
  }
}

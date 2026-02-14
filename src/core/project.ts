import {
  type ProjectConfig,
  type InitOptions,
  initProject,
  loadConfig,
  isInitialized,
} from "./config.js";
import { NotInitializedError } from "./errors.js";
import { SqliteStore } from "../storage/sqlite.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";

export class Project {
  readonly config: ProjectConfig;
  readonly sqlite: SqliteStore;
  private _embeddings: EmbeddingProvider | null = null;

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

  async initEmbeddings(provider?: EmbeddingProvider): Promise<void> {
    if (provider) {
      this._embeddings = provider;
      await provider.initialize();
      return;
    }

    // Lazy import to avoid loading transformers when not needed
    const { TransformersEmbeddingProvider } = await import(
      "../embeddings/transformers-provider.js"
    );
    this._embeddings = new TransformersEmbeddingProvider(
      this.config.embeddingModel,
      this.config.embeddingDimensions,
    );
    await this._embeddings!.initialize();
  }

  static async init(
    projectRoot: string,
    options?: InitOptions,
  ): Promise<Project> {
    const config = initProject(projectRoot, options);
    const sqlite = new SqliteStore(projectRoot);
    return new Project(config, sqlite);
  }

  static async open(projectRoot: string): Promise<Project> {
    if (!isInitialized(projectRoot)) {
      throw new NotInitializedError(projectRoot);
    }
    const config = loadConfig(projectRoot);
    const sqlite = new SqliteStore(projectRoot);
    return new Project(config, sqlite);
  }

  async close(): Promise<void> {
    if (this._embeddings) {
      await this._embeddings.dispose();
      this._embeddings = null;
    }
    this.sqlite.close();
  }
}

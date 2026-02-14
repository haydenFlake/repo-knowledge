import * as fs from "node:fs";
import * as path from "node:path";
import { AlreadyInitializedError, NotInitializedError } from "./errors.js";

export interface ProjectConfig {
  projectRoot: string;
  dataDir: string;
  embeddingModel: string;
  embeddingDimensions: number;
  chunkMaxTokens: number;
  ignorePatterns: string[];
  version: number;
}

const CONFIG_DIR_NAME = ".repo-knowledge";
const CONFIG_FILE_NAME = "config.json";
const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_EMBEDDING_DIMENSIONS = 384;
const DEFAULT_CHUNK_MAX_TOKENS = 512;
const SCHEMA_VERSION = 1;

const DEFAULT_IGNORE_PATTERNS = [
  "node_modules",
  "dist",
  "build",
  ".git",
  ".repo-knowledge",
  "__pycache__",
  ".next",
  ".nuxt",
  "vendor",
  "target",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

export function getDataDir(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_DIR_NAME);
}

export function getConfigPath(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), CONFIG_FILE_NAME);
}

export function getSqlitePath(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), "metadata.db");
}

export function getVectorsDir(projectRoot: string): string {
  return path.join(getDataDir(projectRoot), "vectors");
}

export function isInitialized(projectRoot: string): boolean {
  return fs.existsSync(getConfigPath(projectRoot));
}

export interface InitOptions {
  embeddingModel?: string;
  embeddingDimensions?: number;
  chunkMaxTokens?: number;
  ignorePatterns?: string[];
  force?: boolean;
}

export function initProject(
  projectRoot: string,
  options: InitOptions = {},
): ProjectConfig {
  const dataDir = getDataDir(projectRoot);

  if (isInitialized(projectRoot) && !options.force) {
    throw new AlreadyInitializedError(projectRoot);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(getVectorsDir(projectRoot), { recursive: true });

  const config: ProjectConfig = {
    projectRoot,
    dataDir,
    embeddingModel: options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions:
      options.embeddingDimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
    chunkMaxTokens: options.chunkMaxTokens ?? DEFAULT_CHUNK_MAX_TOKENS,
    ignorePatterns: [
      ...DEFAULT_IGNORE_PATTERNS,
      ...(options.ignorePatterns ?? []),
    ],
    version: SCHEMA_VERSION,
  };

  const configPath = getConfigPath(projectRoot);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  return config;
}

export function loadConfig(projectRoot: string): ProjectConfig {
  if (!isInitialized(projectRoot)) {
    throw new NotInitializedError(projectRoot);
  }

  const configPath = getConfigPath(projectRoot);
  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as ProjectConfig;

  // Ensure absolute paths
  config.projectRoot = projectRoot;
  config.dataDir = getDataDir(projectRoot);

  return config;
}

export function saveConfig(config: ProjectConfig): void {
  const configPath = getConfigPath(config.projectRoot);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

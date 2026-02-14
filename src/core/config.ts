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

export function getDataDir(projectRoot: string, customDataDir?: string): string {
  if (customDataDir) {
    return path.isAbsolute(customDataDir)
      ? customDataDir
      : path.resolve(projectRoot, customDataDir);
  }
  return path.join(projectRoot, CONFIG_DIR_NAME);
}

export function getConfigPath(projectRoot: string, dataDir?: string): string {
  return path.join(getDataDir(projectRoot, dataDir), CONFIG_FILE_NAME);
}

export function getSqlitePath(projectRoot: string, dataDir?: string): string {
  return path.join(getDataDir(projectRoot, dataDir), "metadata.db");
}

export function getVectorsDir(projectRoot: string, dataDir?: string): string {
  return path.join(getDataDir(projectRoot, dataDir), "vectors");
}

export function isInitialized(projectRoot: string, dataDir?: string): boolean {
  return fs.existsSync(getConfigPath(projectRoot, dataDir));
}

export interface InitOptions {
  embeddingModel?: string;
  embeddingDimensions?: number;
  chunkMaxTokens?: number;
  ignorePatterns?: string[];
  dataDir?: string;
  force?: boolean;
}

export function initProject(
  projectRoot: string,
  options: InitOptions = {},
): ProjectConfig {
  const dataDir = getDataDir(projectRoot, options.dataDir);

  if (isInitialized(projectRoot, options.dataDir) && !options.force) {
    throw new AlreadyInitializedError(projectRoot);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(getVectorsDir(projectRoot, options.dataDir), { recursive: true });

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

  const configPath = getConfigPath(projectRoot, options.dataDir);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

  return config;
}

export function loadConfig(projectRoot: string, dataDir?: string): ProjectConfig {
  if (!isInitialized(projectRoot, dataDir)) {
    throw new NotInitializedError(projectRoot);
  }

  const configPath = getConfigPath(projectRoot, dataDir);
  const raw = fs.readFileSync(configPath, "utf-8");
  let config: ProjectConfig;
  try {
    config = JSON.parse(raw) as ProjectConfig;
  } catch (err) {
    throw new Error(
      `Failed to parse config at ${configPath}: ${err instanceof Error ? err.message : err}`,
    );
  }

  // Validate required fields
  if (!config.embeddingModel || !config.version) {
    throw new Error(
      `Invalid config at ${configPath}: missing required fields (embeddingModel, version)`,
    );
  }

  // Ensure absolute paths
  config.projectRoot = projectRoot;
  // Preserve custom dataDir if set, otherwise use default
  if (!config.dataDir || !path.isAbsolute(config.dataDir)) {
    config.dataDir = getDataDir(projectRoot, config.dataDir || undefined);
  }

  return config;
}

export function saveConfig(config: ProjectConfig): void {
  const configPath = path.join(config.dataDir, CONFIG_FILE_NAME);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

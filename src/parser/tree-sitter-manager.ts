import Parser from "web-tree-sitter";
import * as path from "node:path";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { getLanguageConfig } from "./languages.js";
import { logger } from "../utils/logger.js";

const require = createRequire(import.meta.url);

let initialized = false;

export class TreeSitterManager {
  private languages: Map<string, Parser.Language> = new Map();

  async initialize(): Promise<void> {
    if (!initialized) {
      await Parser.init();
      initialized = true;
    }
  }

  async getLanguage(languageId: string): Promise<Parser.Language | null> {
    const cached = this.languages.get(languageId);
    if (cached) return cached;

    const config = getLanguageConfig(languageId);
    if (!config) return null;

    const wasmPath = this.findWasmFile(languageId);
    if (!wasmPath) {
      logger.warn(`No WASM grammar found for ${languageId}. Skipping.`);
      return null;
    }

    try {
      const language = await Parser.Language.load(wasmPath);
      this.languages.set(languageId, language);
      return language;
    } catch (err) {
      logger.warn(
        `Failed to load grammar for ${languageId}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  }

  createParser(language: Parser.Language): Parser {
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  }

  async parse(
    source: string,
    languageId: string,
  ): Promise<Parser.Tree | null> {
    const language = await this.getLanguage(languageId);
    if (!language) return null;

    const parser = this.createParser(language);
    return parser.parse(source);
  }

  private findWasmFile(languageId: string): string | null {
    // Use require.resolve to find the tree-sitter-wasms package
    try {
      const wasmsDir = path.dirname(
        require.resolve("tree-sitter-wasms/package.json"),
      );
      const wasmPath = path.join(
        wasmsDir,
        "out",
        `tree-sitter-${languageId}.wasm`,
      );
      if (fs.existsSync(wasmPath)) return wasmPath;
    } catch {
      // Package not installed
    }

    return null;
  }
}

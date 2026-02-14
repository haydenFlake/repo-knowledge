export interface LanguageConfig {
  id: string;
  extensions: string[];
  treeSitterPackage: string;
  wasmFile: string;
}

export const LANGUAGES: Record<string, LanguageConfig> = {
  typescript: {
    id: "typescript",
    extensions: [".ts"],
    treeSitterPackage: "tree-sitter-typescript",
    wasmFile: "tree-sitter-typescript.wasm",
  },
  tsx: {
    id: "tsx",
    extensions: [".tsx"],
    treeSitterPackage: "tree-sitter-tsx",
    wasmFile: "tree-sitter-tsx.wasm",
  },
  javascript: {
    id: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    treeSitterPackage: "tree-sitter-javascript",
    wasmFile: "tree-sitter-javascript.wasm",
  },
  python: {
    id: "python",
    extensions: [".py", ".pyw"],
    treeSitterPackage: "tree-sitter-python",
    wasmFile: "tree-sitter-python.wasm",
  },
  rust: {
    id: "rust",
    extensions: [".rs"],
    treeSitterPackage: "tree-sitter-rust",
    wasmFile: "tree-sitter-rust.wasm",
  },
  go: {
    id: "go",
    extensions: [".go"],
    treeSitterPackage: "tree-sitter-go",
    wasmFile: "tree-sitter-go.wasm",
  },
  java: {
    id: "java",
    extensions: [".java"],
    treeSitterPackage: "tree-sitter-java",
    wasmFile: "tree-sitter-java.wasm",
  },
  css: {
    id: "css",
    extensions: [".css"],
    treeSitterPackage: "tree-sitter-css",
    wasmFile: "tree-sitter-css.wasm",
  },
  json: {
    id: "json",
    extensions: [".json"],
    treeSitterPackage: "tree-sitter-json",
    wasmFile: "tree-sitter-json.wasm",
  },
  html: {
    id: "html",
    extensions: [".html", ".htm"],
    treeSitterPackage: "tree-sitter-html",
    wasmFile: "tree-sitter-html.wasm",
  },
  yaml: {
    id: "yaml",
    extensions: [".yml", ".yaml"],
    treeSitterPackage: "tree-sitter-yaml",
    wasmFile: "tree-sitter-yaml.wasm",
  },
  markdown: {
    id: "markdown",
    extensions: [".md"],
    treeSitterPackage: "tree-sitter-markdown",
    wasmFile: "tree-sitter-markdown.wasm",
  },
};

const extensionMap = new Map<string, LanguageConfig>();
for (const lang of Object.values(LANGUAGES)) {
  for (const ext of lang.extensions) {
    extensionMap.set(ext, lang);
  }
}

export function detectLanguage(filePath: string): string | null {
  const basename = filePath.split("/").pop() ?? filePath;
  const dotIndex = basename.lastIndexOf(".");
  // No extension, or dotfile without a further extension (e.g., ".gitignore")
  if (dotIndex <= 0) return null;
  const ext = basename.substring(dotIndex).toLowerCase();
  const lang = extensionMap.get(ext);
  return lang?.id ?? null;
}

export function getLanguageConfig(
  languageId: string,
): LanguageConfig | undefined {
  return LANGUAGES[languageId];
}

/**
 * Languages that have meaningful symbol extraction (functions, classes, etc.)
 * Configs like JSON, YAML, CSS don't have the same kind of symbols.
 */
export const CODE_LANGUAGES = new Set([
  "typescript",
  "tsx",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
]);

export function getSupportedExtensions(): string[] {
  return [...extensionMap.keys()];
}

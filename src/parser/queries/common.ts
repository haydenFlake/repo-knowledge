/**
 * Common types for extracted symbols across all languages.
 */
export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "method"
  | "property"
  | "variable"
  | "enum"
  | "module";

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  signature: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
  parentName?: string;
  docstring?: string;
  exported: boolean;
  bodyText: string;
}

export interface ImportDeclaration {
  source: string;
  names: string[];
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface ParsedFileResult {
  symbols: ExtractedSymbol[];
  imports: ImportDeclaration[];
}

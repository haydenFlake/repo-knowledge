import { estimateTokens } from "../utils/token-counter.js";
import type { ExtractedSymbol } from "../parser/queries/common.js";

export interface CodeChunk {
  chunkIndex: number;
  content: string;
  startLine: number;
  endLine: number;
  containedSymbolNames: string[];
  tokenCount: number;
}

interface ChunkRegion {
  startLine: number;
  endLine: number;
  text: string;
  symbolNames: string[];
  isSymbol: boolean;
}

/**
 * Chunk a file into AST-aware code chunks.
 * Each top-level symbol (function, class, interface) becomes a natural chunk boundary.
 * Chunks include a context header for better embedding quality.
 */
export function chunkFile(
  source: string,
  filePath: string,
  symbols: ExtractedSymbol[],
  maxTokens: number = 512,
): CodeChunk[] {
  const lines = source.split("\n");

  if (lines.length === 0) return [];

  // If the whole file fits in one chunk, use it as-is
  const fileTokens = estimateTokens(source);
  if (fileTokens <= maxTokens) {
    const symbolNames = symbols.map((s) => s.name);
    const content = buildChunkContent(filePath, source, 1, lines.length, symbolNames);
    return [
      {
        chunkIndex: 0,
        content,
        startLine: 1,
        endLine: lines.length,
        containedSymbolNames: symbolNames,
        tokenCount: estimateTokens(content),
      },
    ];
  }

  // Get top-level symbols (not methods/properties inside classes)
  const topLevelSymbols = symbols.filter(
    (s) => !s.parentName || s.kind === "class",
  );

  // Sort by start line
  topLevelSymbols.sort((a, b) => a.startLine - b.startLine);

  // Build regions: alternate between inter-symbol gaps and symbol bodies
  const regions: ChunkRegion[] = [];
  let currentLine = 1;

  for (const sym of topLevelSymbols) {
    // Skip symbols that overlap with previous ones (already covered)
    if (sym.startLine < currentLine) continue;

    // Gap before this symbol
    if (sym.startLine > currentLine) {
      const gapText = lines.slice(currentLine - 1, sym.startLine - 1).join("\n");
      if (gapText.trim().length > 0) {
        regions.push({
          startLine: currentLine,
          endLine: sym.startLine - 1,
          text: gapText,
          symbolNames: [],
          isSymbol: false,
        });
      }
    }

    // The symbol itself
    const symText = lines.slice(sym.startLine - 1, sym.endLine).join("\n");
    const childNames = symbols
      .filter((s) => s.parentName === sym.name)
      .map((s) => s.name);
    regions.push({
      startLine: sym.startLine,
      endLine: sym.endLine,
      text: symText,
      symbolNames: [sym.name, ...childNames],
      isSymbol: true,
    });

    currentLine = sym.endLine + 1;
  }

  // Trailing content after last symbol
  if (currentLine <= lines.length) {
    const trailingText = lines.slice(currentLine - 1).join("\n");
    if (trailingText.trim().length > 0) {
      regions.push({
        startLine: currentLine,
        endLine: lines.length,
        text: trailingText,
        symbolNames: [],
        isSymbol: false,
      });
    }
  }

  // If no regions were created (no symbols found), chunk the whole file
  if (regions.length === 0) {
    return chunkByLines(source, filePath, maxTokens);
  }

  // Convert regions to chunks, splitting large ones
  const chunks: CodeChunk[] = [];
  let chunkIndex = 0;

  // Reserve tokens for the chunk header (// File: ... | Lines: ... | Symbols: ...)
  const headerOverhead = 20;
  const effectiveMax = maxTokens - headerOverhead;

  for (const region of regions) {
    const regionTokens = estimateTokens(region.text);

    if (regionTokens <= effectiveMax) {
      // Region fits in one chunk
      const content = buildChunkContent(
        filePath,
        region.text,
        region.startLine,
        region.endLine,
        region.symbolNames,
      );
      chunks.push({
        chunkIndex: chunkIndex++,
        content,
        startLine: region.startLine,
        endLine: region.endLine,
        containedSymbolNames: region.symbolNames,
        tokenCount: estimateTokens(content),
      });
    } else {
      // Split large region by lines with overlap
      const subChunks = splitRegion(
        region,
        filePath,
        maxTokens,
        chunkIndex,
      );
      for (const sc of subChunks) {
        chunks.push(sc);
        chunkIndex++;
      }
    }
  }

  return chunks;
}

function splitRegion(
  region: ChunkRegion,
  filePath: string,
  maxTokens: number,
  startIndex: number,
): CodeChunk[] {
  const regionLines = region.text.split("\n");
  const chunks: CodeChunk[] = [];
  let chunkIndex = startIndex;
  let lineStart = 0;

  while (lineStart < regionLines.length) {
    let lineEnd = lineStart;
    let currentText = "";

    // Accumulate lines until we hit the token limit
    while (lineEnd < regionLines.length) {
      const nextText =
        currentText + (currentText ? "\n" : "") + regionLines[lineEnd];
      if (estimateTokens(nextText) > maxTokens && lineEnd > lineStart) {
        break;
      }
      currentText = nextText;
      lineEnd++;
    }

    const absStartLine = region.startLine + lineStart;
    const absEndLine = region.startLine + lineEnd - 1;

    const content = buildChunkContent(
      filePath,
      currentText,
      absStartLine,
      absEndLine,
      region.symbolNames,
    );

    chunks.push({
      chunkIndex: chunkIndex++,
      content,
      startLine: absStartLine,
      endLine: absEndLine,
      containedSymbolNames: region.symbolNames,
      tokenCount: estimateTokens(content),
    });

    lineStart = lineEnd;
  }

  return chunks;
}

function chunkByLines(
  source: string,
  filePath: string,
  maxTokens: number,
): CodeChunk[] {
  const lines = source.split("\n");
  const chunks: CodeChunk[] = [];
  let chunkIndex = 0;
  let lineStart = 0;

  while (lineStart < lines.length) {
    let lineEnd = lineStart;
    let currentText = "";

    while (lineEnd < lines.length) {
      const nextText =
        currentText + (currentText ? "\n" : "") + lines[lineEnd];
      if (estimateTokens(nextText) > maxTokens && lineEnd > lineStart) {
        break;
      }
      currentText = nextText;
      lineEnd++;
    }

    const content = buildChunkContent(
      filePath,
      currentText,
      lineStart + 1,
      lineEnd,
      [],
    );

    chunks.push({
      chunkIndex: chunkIndex++,
      content,
      startLine: lineStart + 1,
      endLine: lineEnd,
      containedSymbolNames: [],
      tokenCount: estimateTokens(content),
    });

    lineStart = lineEnd;
  }

  return chunks;
}

function buildChunkContent(
  filePath: string,
  code: string,
  startLine: number,
  endLine: number,
  symbolNames: string[],
): string {
  let header = `// File: ${filePath} | Lines: ${startLine}-${endLine}`;
  if (symbolNames.length > 0) {
    header += ` | Symbols: ${symbolNames.join(", ")}`;
  }
  return `${header}\n${code}`;
}

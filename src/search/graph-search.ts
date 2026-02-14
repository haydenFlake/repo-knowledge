import type { SqliteStore } from "../storage/sqlite.js";

export interface GraphNode {
  symbolId: number;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string | null;
  depth: number;
}

export interface GraphSearchResult {
  root: GraphNode;
  callees: GraphNode[];
  callers: GraphNode[];
}

export function getRelatedSymbols(
  sqlite: SqliteStore,
  symbolName: string,
  options: {
    depth?: number;
    edgeTypes?: string[];
    direction?: "dependencies" | "dependents" | "both";
  } = {},
): GraphSearchResult | null {
  const depth = options.depth ?? 2;
  const direction = options.direction ?? "both";

  const symbol = sqlite.getSymbolByName(symbolName);
  if (!symbol?.id) return null;

  const file = sqlite.getFileById(symbol.file_id);

  const root: GraphNode = {
    symbolId: symbol.id,
    name: symbol.name,
    kind: symbol.kind,
    filePath: file?.path ?? "unknown",
    startLine: symbol.start_line,
    signature: symbol.signature,
    depth: 0,
  };

  const callees: GraphNode[] = [];
  const callers: GraphNode[] = [];

  if (direction === "dependencies" || direction === "both") {
    collectEdges(sqlite, symbol.id, "outgoing", depth, callees, new Set(), options.edgeTypes);
  }

  if (direction === "dependents" || direction === "both") {
    collectEdges(sqlite, symbol.id, "incoming", depth, callers, new Set(), options.edgeTypes);
  }

  return { root, callees, callers };
}

function collectEdges(
  sqlite: SqliteStore,
  symbolId: number,
  direction: "outgoing" | "incoming",
  maxDepth: number,
  results: GraphNode[],
  visited: Set<number>,
  edgeTypes?: string[],
  currentDepth: number = 1,
): void {
  if (currentDepth > maxDepth) return;
  if (visited.has(symbolId)) return;
  visited.add(symbolId);

  const edges =
    direction === "outgoing"
      ? sqlite.getEdgesFrom(symbolId, edgeTypes)
      : sqlite.getEdgesTo(symbolId, edgeTypes);

  for (const edge of edges) {
    const targetId =
      direction === "outgoing"
        ? edge.target_symbol_id
        : edge.source_symbol_id;

    if (visited.has(targetId)) continue;

    // Look up the symbol
    const targetSym = sqlite
      .getSymbolsByFile(edge.target_file_id ?? 0)
      .find((s) => s.id === targetId);

    if (!targetSym) continue;

    const targetFile = sqlite.getFileById(targetSym.file_id);

    results.push({
      symbolId: targetId,
      name: targetSym.name,
      kind: targetSym.kind,
      filePath: targetFile?.path ?? "unknown",
      startLine: targetSym.start_line,
      signature: targetSym.signature,
      depth: currentDepth,
    });

    // Recurse
    collectEdges(
      sqlite,
      targetId,
      direction,
      maxDepth,
      results,
      visited,
      edgeTypes,
      currentDepth + 1,
    );
  }
}

import type { SqliteStore } from "../storage/sqlite.js";
import { logger } from "../utils/logger.js";

/**
 * Run PageRank on the symbol graph to compute importance scores.
 */
export function rankSymbols(sqlite: SqliteStore): void {
  const edges = sqlite.getAllEdges();
  if (edges.length === 0) return;

  // Collect all unique symbol IDs
  const symbolIds = new Set<number>();
  for (const e of edges) {
    symbolIds.add(e.source_symbol_id);
    symbolIds.add(e.target_symbol_id);
  }

  const N = symbolIds.size;
  if (N === 0) return;

  // Build adjacency lists
  const outLinks = new Map<number, number[]>();
  const inLinks = new Map<number, number[]>();

  for (const id of symbolIds) {
    outLinks.set(id, []);
    inLinks.set(id, []);
  }

  for (const e of edges) {
    const outList = outLinks.get(e.source_symbol_id);
    if (outList) outList.push(e.target_symbol_id);
    const inList = inLinks.get(e.target_symbol_id);
    if (inList) inList.push(e.source_symbol_id);
  }

  // Initialize scores
  const scores = new Map<number, number>();
  for (const id of symbolIds) {
    scores.set(id, 1.0 / N);
  }

  // Iterate PageRank (with dangling node redistribution)
  const dampingFactor = 0.85;
  const iterations = 20;

  // Identify dangling nodes (no outgoing edges) -- they leak rank mass
  const danglingNodes: number[] = [];
  for (const id of symbolIds) {
    if ((outLinks.get(id) ?? []).length === 0) {
      danglingNodes.push(id);
    }
  }

  for (let iter = 0; iter < iterations; iter++) {
    // Collect rank mass from dangling nodes and redistribute evenly
    let danglingMass = 0;
    for (const id of danglingNodes) {
      danglingMass += scores.get(id) ?? 0;
    }

    const newScores = new Map<number, number>();

    for (const id of symbolIds) {
      let inScore = 0;
      const incoming = inLinks.get(id) ?? [];
      for (const inId of incoming) {
        const outDegree = (outLinks.get(inId) ?? []).length;
        if (outDegree > 0) {
          inScore += (scores.get(inId) ?? 0) / outDegree;
        }
      }
      // Add dangling node contribution (evenly distributed to all nodes)
      newScores.set(
        id,
        (1 - dampingFactor) / N + dampingFactor * (inScore + danglingMass / N),
      );
    }

    // Update scores
    for (const [id, score] of newScores) {
      scores.set(id, score);
    }
  }

  // Normalize to [0, 1]
  let maxScore = 0;
  for (const score of scores.values()) {
    if (score > maxScore) maxScore = score;
  }

  if (maxScore > 0) {
    const updates: Array<{ id: number; score: number }> = [];
    for (const [id, score] of scores) {
      updates.push({ id, score: score / maxScore });
    }
    sqlite.updateSymbolImportanceBatch(updates);
    logger.info(`  Ranked ${updates.length} symbols by importance`);
  }
}

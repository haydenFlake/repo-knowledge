import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { DiscoveredFile } from "./file-discovery.js";

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export interface FileDiff {
  added: DiscoveredFile[];
  modified: DiscoveredFile[];
  removed: string[];
  unchanged: string[];
}

/**
 * Compute diff between discovered files and existing indexed hashes.
 * Caches file content + hashes to avoid reading files twice.
 * Uses file size + mtime as a fast pre-check before hashing.
 */
export function computeDiff(
  discovered: DiscoveredFile[],
  existingHashes: Map<string, string>,
  contentCache: Map<string, { content: string; hash: string }>,
  existingSizes?: Map<string, number>,
): FileDiff {
  const added: DiscoveredFile[] = [];
  const modified: DiscoveredFile[] = [];
  const unchanged: string[] = [];
  const seenPaths = new Set<string>();

  for (const file of discovered) {
    seenPaths.add(file.relativePath);
    const existingHash = existingHashes.get(file.relativePath);

    if (!existingHash) {
      added.push(file);
      continue;
    }

    // Fast check: if file size changed, it's definitely modified (skip reading + hashing)
    if (existingSizes) {
      const existingSize = existingSizes.get(file.relativePath);
      if (existingSize !== undefined && existingSize !== file.sizeBytes) {
        modified.push(file);
        continue;
      }
    }

    // Read and hash the file, cache the result
    const content = fs.readFileSync(file.absolutePath, "utf-8");
    const currentHash = hashContent(content);
    contentCache.set(file.relativePath, { content, hash: currentHash });

    if (currentHash !== existingHash) {
      modified.push(file);
    } else {
      unchanged.push(file.relativePath);
    }
  }

  // Files that were in the index but no longer on disk
  const removed: string[] = [];
  for (const [existingPath] of existingHashes) {
    if (!seenPaths.has(existingPath)) {
      removed.push(existingPath);
    }
  }

  return { added, modified, removed, unchanged };
}

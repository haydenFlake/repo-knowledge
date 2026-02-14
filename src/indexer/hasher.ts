import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { DiscoveredFile } from "./file-discovery.js";

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function hashFile(absolutePath: string): string {
  const content = fs.readFileSync(absolutePath, "utf-8");
  return hashContent(content);
}

export interface FileDiff {
  added: DiscoveredFile[];
  modified: DiscoveredFile[];
  removed: string[];
  unchanged: string[];
}

export function computeDiff(
  discovered: DiscoveredFile[],
  existingHashes: Map<string, string>,
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

    const currentHash = hashFile(file.absolutePath);
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

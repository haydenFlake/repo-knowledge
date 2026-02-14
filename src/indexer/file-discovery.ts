import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import { type ProjectConfig } from "../core/config.js";
import { detectLanguage, getSupportedExtensions } from "../parser/languages.js";

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  language: string | null;
  sizeBytes: number;
}

const MAX_FILE_SIZE = 1024 * 1024; // 1MB

export async function discoverFiles(
  config: ProjectConfig,
  filePatterns?: string[],
): Promise<DiscoveredFile[]> {
  const { projectRoot, ignorePatterns } = config;

  // Build ignore filter from .gitignore + config patterns
  const ig = ignore();
  const gitignorePath = path.join(projectRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    ig.add(gitignoreContent);
  }
  ig.add(ignorePatterns);

  // Build glob patterns for supported file types
  const extensions = getSupportedExtensions();
  const extPattern =
    extensions.length === 1
      ? `*${extensions[0]}`
      : `*{${extensions.join(",")}}`;

  const patterns = filePatterns ?? [`**/${extPattern}`];

  const filePaths = await fg(patterns, {
    cwd: projectRoot,
    absolute: false,
    dot: false,
    onlyFiles: true,
    ignore: ignorePatterns,
  });

  const discovered: DiscoveredFile[] = [];

  for (const relativePath of filePaths) {
    // Check gitignore
    if (ig.ignores(relativePath)) continue;

    const absolutePath = path.join(projectRoot, relativePath);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch {
      continue;
    }

    // Skip files that are too large
    if (stat.size > MAX_FILE_SIZE) continue;

    // Skip empty files
    if (stat.size === 0) continue;

    const language = detectLanguage(relativePath);

    discovered.push({
      absolutePath,
      relativePath,
      language,
      sizeBytes: stat.size,
    });
  }

  // Sort by path for deterministic ordering
  discovered.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return discovered;
}

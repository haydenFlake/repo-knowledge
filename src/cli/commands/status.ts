import { Project } from "../../core/project.js";
import { isInitialized } from "../../core/config.js";
import { logger } from "../../utils/logger.js";

export async function statusCommand(): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    logger.error("Not initialized. Run 'repo-knowledge init' first.");
    process.exit(1);
  }

  const project = await Project.open(projectRoot);

  try {
    const stats = project.sqlite.getStats();
    const lastIndex = project.sqlite.getState("last_full_index");
    const lastIncremental = project.sqlite.getState("last_incremental_index");
    const embeddingModel = project.sqlite.getState("embedding_model");

    logger.info("repo-knowledge status");
    logger.info("─".repeat(40));
    logger.info(`  Files indexed:   ${stats.totalFiles}`);
    logger.info(`  Symbols:         ${stats.totalSymbols}`);
    logger.info(`  Code chunks:     ${stats.totalChunks}`);
    logger.info(`  Graph edges:     ${stats.totalEdges}`);
    logger.info("");

    if (Object.keys(stats.languages).length > 0) {
      logger.info("  Languages:");
      for (const [lang, count] of Object.entries(stats.languages)) {
        logger.info(`    ${lang}: ${count} files`);
      }
      logger.info("");
    }

    if (embeddingModel) {
      logger.info(`  Embedding model: ${embeddingModel}`);
    }
    if (lastIndex) {
      logger.info(`  Last full index: ${lastIndex}`);
    }
    if (lastIncremental) {
      logger.info(`  Last incremental: ${lastIncremental}`);
    }

    if (stats.totalFiles === 0) {
      logger.info("");
      logger.info("  No files indexed. Run 'repo-knowledge index' to get started.");
    }
  } finally {
    await project.close();
  }
}

import { Project } from "../../core/project.js";
import { isInitialized } from "../../core/config.js";
import { runIndexingPipeline } from "../../indexer/pipeline.js";
import { logger } from "../../utils/logger.js";

interface IndexArgs {
  full?: boolean;
  files?: string[];
  summarize?: boolean;
  dryRun?: boolean;
}

export async function indexCommand(args: IndexArgs): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    logger.error("Not initialized. Run 'repo-knowledge init' first.");
    process.exit(1);
  }

  const project = await Project.open(projectRoot);

  try {
    const result = await runIndexingPipeline(project, {
      full: args.full,
      filePatterns: args.files,
      generateSummaries: args.summarize,
      dryRun: args.dryRun,
    });

    if (!args.dryRun) {
      logger.info("");
      logger.info("Summary:");
      logger.info(`  Files processed: ${result.filesAdded + result.filesModified}`);
      if (result.filesRemoved > 0)
        logger.info(`  Files removed: ${result.filesRemoved}`);
      if (result.filesUnchanged > 0)
        logger.info(`  Files unchanged: ${result.filesUnchanged}`);
      logger.info(`  Symbols: ${result.totalSymbols}`);
      logger.info(`  Chunks: ${result.totalChunks}`);
      logger.info(`  Embeddings: ${result.totalEmbeddings}`);
    }
  } finally {
    await project.close();
  }
}

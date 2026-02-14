import * as path from "node:path";
import { Project } from "../../core/project.js";
import { logger } from "../../utils/logger.js";

interface InitArgs {
  model: string;
  dataDir: string;
  force?: boolean;
}

export async function initCommand(args: InitArgs): Promise<void> {
  const projectRoot = process.cwd();

  try {
    const project = await Project.init(projectRoot, {
      embeddingModel: args.model,
      dataDir: args.dataDir,
      force: args.force,
    });

    logger.info(`Initialized repo-knowledge at ${path.relative(process.cwd(), project.config.dataDir) || "."}`);
    logger.info(`  Embedding model: ${project.config.embeddingModel}`);
    logger.info(`  Chunk max tokens: ${project.config.chunkMaxTokens}`);
    logger.info("");
    logger.info("Next steps:");
    logger.info("  1. Run 'repo-knowledge index' to index your codebase");
    logger.info("  2. Run 'repo-knowledge search <query>' to search");
    logger.info("  3. Run 'repo-knowledge serve' to start the MCP server");

    await project.close();
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "AlreadyInitializedError"
    ) {
      logger.error(err.message);
      logger.info("Use --force to overwrite existing configuration.");
      process.exit(1);
    }
    throw err;
  }
}

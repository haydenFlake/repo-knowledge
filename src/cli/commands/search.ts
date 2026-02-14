import { Project } from "../../core/project.js";
import { isInitialized } from "../../core/config.js";
import { hybridSearch } from "../../search/hybrid.js";
import {
  formatSearchResultsCLI,
  formatSearchResults,
} from "../../output/formatter.js";
import { logger } from "../../utils/logger.js";

interface SearchArgs {
  limit: string;
  mode: string;
  language?: string;
  file?: string;
  json?: boolean;
  tokens: string;
  dataDir?: string;
}

export async function searchCommand(
  query: string,
  args: SearchArgs,
): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot, args.dataDir)) {
    logger.error("Not initialized. Run 'repo-knowledge init' first.");
    process.exit(1);
  }

  const project = await Project.open(projectRoot, args.dataDir);

  try {
    const validModes = ["hybrid", "vector", "keyword", "symbol"] as const;
    const mode = validModes.includes(args.mode as typeof validModes[number])
      ? (args.mode as typeof validModes[number])
      : "hybrid";
    if (args.mode && !validModes.includes(args.mode as typeof validModes[number])) {
      logger.info(`Unknown search mode '${args.mode}', falling back to 'hybrid'`);
    }

    const limit = parseInt(args.limit, 10);
    const tokenBudget = parseInt(args.tokens, 10);
    if (isNaN(limit) || limit < 1) {
      logger.error("Invalid --limit value. Must be a positive number.");
      process.exit(1);
    }
    if (isNaN(tokenBudget) || tokenBudget < 1) {
      logger.error("Invalid --tokens value. Must be a positive number.");
      process.exit(1);
    }

    const results = await hybridSearch(project, {
      query,
      limit,
      tokenBudget,
      languageFilter: args.language,
      fileFilter: args.file,
      searchMode: mode,
    });

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      const formatted = formatSearchResultsCLI(results);
      console.log(formatted);
    }
  } finally {
    await project.close();
  }
}

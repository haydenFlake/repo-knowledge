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
}

export async function searchCommand(
  query: string,
  args: SearchArgs,
): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    logger.error("Not initialized. Run 'repo-knowledge init' first.");
    process.exit(1);
  }

  const project = await Project.open(projectRoot);

  try {
    const results = await hybridSearch(project, {
      query,
      limit: parseInt(args.limit, 10),
      tokenBudget: parseInt(args.tokens, 10),
      languageFilter: args.language,
      fileFilter: args.file,
      searchMode: args.mode as "hybrid" | "vector" | "keyword" | "symbol",
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

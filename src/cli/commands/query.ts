import { Project } from "../../core/project.js";
import { isInitialized } from "../../core/config.js";
import { hybridSearch } from "../../search/hybrid.js";
import { formatSearchResults } from "../../output/formatter.js";
import { logger } from "../../utils/logger.js";

interface QueryArgs {
  focus?: string[];
  depth?: string;
  tokens: string;
  json?: boolean;
}

export async function queryCommand(
  description: string,
  args: QueryArgs,
): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot)) {
    logger.error("Not initialized. Run 'repo-knowledge init' first.");
    process.exit(1);
  }

  const project = await Project.open(projectRoot);

  try {
    const tokenBudget = parseInt(args.tokens ?? "8000", 10);

    const results = await hybridSearch(project, {
      query: description,
      limit: 15,
      tokenBudget,
    });

    const formatted = formatSearchResults(results, tokenBudget);
    console.log(formatted);
  } finally {
    await project.close();
  }
}

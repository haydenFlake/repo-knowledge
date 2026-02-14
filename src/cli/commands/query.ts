import { Project } from "../../core/project.js";
import { isInitialized } from "../../core/config.js";
import { hybridSearch } from "../../search/hybrid.js";
import {
  formatSearchResults,
  formatFileSummary,
  escapeXmlAttr,
} from "../../output/formatter.js";
import { logger } from "../../utils/logger.js";

interface QueryArgs {
  focus?: string[];
  depth?: string;
  tokens: string;
  json?: boolean;
  dataDir?: string;
}

export async function queryCommand(
  description: string,
  args: QueryArgs,
): Promise<void> {
  const projectRoot = process.cwd();

  if (!isInitialized(projectRoot, args.dataDir)) {
    logger.error("Not initialized. Run 'repo-knowledge init' first.");
    process.exit(1);
  }

  const project = await Project.open(projectRoot, args.dataDir);

  try {
    const tokenBudget = parseInt(args.tokens ?? "8000", 10);
    if (isNaN(tokenBudget) || tokenBudget < 1) {
      logger.error("Invalid --tokens value. Must be a positive number.");
      process.exit(1);
    }

    let output = `<context task="${escapeXmlAttr(description)}" budget="${tokenBudget}">\n`;

    // Search for relevant code
    const searchBudget = Math.floor(tokenBudget * 0.6);
    const results = await hybridSearch(project, {
      query: description,
      limit: 15,
      tokenBudget: searchBudget,
    });

    if (results.length > 0) {
      output += formatSearchResults(results, searchBudget) + "\n";
    }

    // Add focus file summaries
    if (args.focus && args.focus.length > 0) {
      output += "  <focus_files>\n";
      for (const fp of args.focus) {
        const file = project.sqlite.getFileByPath(fp);
        if (file?.id) {
          const symbols = project.sqlite.getSymbolsByFile(file.id);
          output +=
            formatFileSummary(
              file.path,
              file.language,
              file.line_count,
              symbols,
              file.purpose,
            ) + "\n";
        }
      }
      output += "  </focus_files>\n";
    }

    output += "</context>";
    console.log(output);
  } finally {
    await project.close();
  }
}

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { indexCommand } from "./commands/index-cmd.js";
import { searchCommand } from "./commands/search.js";
import { serveCommand } from "./commands/serve.js";

export function run(argv: string[]): void {
  const program = new Command()
    .name("repo-knowledge")
    .description(
      "Index codebases and provide hyper-efficient context to AI coding agents",
    )
    .version("0.1.0");

  program
    .command("init")
    .description("Initialize repo-knowledge for the current project")
    .option(
      "--model <model>",
      "Embedding model",
      "Xenova/all-MiniLM-L6-v2",
    )
    .option("--data-dir <dir>", "Data directory", ".repo-knowledge")
    .option("--force", "Overwrite existing configuration")
    .action(initCommand);

  program
    .command("index")
    .description("Index or re-index the codebase")
    .option("--full", "Force full re-index")
    .option("--files <patterns...>", "Only index specific file patterns")
    .option("--summarize", "Generate hierarchical summaries")
    .option("--dry-run", "Show what would be indexed without doing it")
    .action(indexCommand);

  program
    .command("search <query>")
    .description("Search the indexed codebase")
    .option("-n, --limit <n>", "Number of results", "10")
    .option(
      "-m, --mode <mode>",
      "Search mode: hybrid|vector|keyword|symbol",
      "hybrid",
    )
    .option("-l, --language <lang>", "Filter by language")
    .option("-f, --file <pattern>", "Filter by file glob pattern")
    .option("--json", "Output as JSON")
    .option("--tokens <n>", "Token budget for output", "4000")
    .action(searchCommand);

  program
    .command("status")
    .description("Show index status and statistics")
    .action(statusCommand);

  program
    .command("serve")
    .description("Start the MCP server (stdio transport)")
    .option("--project <dir>", "Project root directory")
    .action(serveCommand);

  program.parse(argv);
}

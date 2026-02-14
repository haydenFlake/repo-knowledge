import * as path from "node:path";
import { isInitialized } from "../../core/config.js";
import { logger, setLoggerStderr } from "../../utils/logger.js";

interface ServeArgs {
  project?: string;
}

export async function serveCommand(args: ServeArgs): Promise<void> {
  // MCP uses stdout for JSON-RPC; all logging must go to stderr
  setLoggerStderr(true);

  const projectRoot = args.project
    ? path.resolve(args.project)
    : process.cwd();

  if (!isInitialized(projectRoot)) {
    logger.error(
      `Not initialized at ${projectRoot}. Run 'repo-knowledge init' first.`,
    );
    process.exit(1);
  }

  const { startMcpServer } = await import("../../mcp/server.js");
  await startMcpServer(projectRoot);
}

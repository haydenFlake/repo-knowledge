import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Project } from "../core/project.js";
import { hybridSearch } from "../search/hybrid.js";
import { getRelatedSymbols } from "../search/graph-search.js";
import {
  formatSearchResults,
  formatFileSummary,
  formatRepoOverview,
  escapeXmlAttr,
  escapeXmlContent,
} from "../output/formatter.js";
import { logger } from "../utils/logger.js";

export async function startMcpServer(projectRoot: string): Promise<void> {
  const project = await Project.open(projectRoot);

  const server = new McpServer({
    name: "repo-knowledge",
    version: "0.1.0",
  });

  // Tool 1: search_code
  server.tool(
    "search_code",
    "Search the indexed codebase using hybrid search (semantic + keyword + symbol). Returns the most relevant code chunks with file paths, line numbers, and context.",
    {
      query: z.string().max(2000).describe("Natural language query or code snippet to search for"),
      limit: z.number().int().min(1).max(100).optional().default(10).describe("Maximum number of results"),
      token_budget: z.number().int().min(100).max(100000).optional().default(4000).describe("Maximum tokens in response"),
      language: z.string().max(50).optional().describe("Filter by language (e.g., 'typescript')"),
      search_mode: z
        .enum(["hybrid", "vector", "keyword", "symbol"])
        .optional()
        .default("hybrid"),
    },
    async (args) => {
      const results = await hybridSearch(project, {
        query: args.query,
        limit: args.limit,
        tokenBudget: args.token_budget,
        languageFilter: args.language,
        searchMode: args.search_mode,
      });
      const formatted = formatSearchResults(results, args.token_budget);
      return { content: [{ type: "text" as const, text: formatted }] };
    },
  );

  // Tool 2: get_file_summary
  server.tool(
    "get_file_summary",
    "Get a structured summary of a file including its purpose, exports, imports, key symbols with signatures, and line count. Much more token-efficient than reading the full file.",
    {
      file_path: z.string().max(1000).describe("Relative file path from project root"),
    },
    async (args) => {
      const file = project.sqlite.getFileByPath(args.file_path);
      if (!file?.id) {
        return {
          content: [
            { type: "text" as const, text: `File not found in index: ${args.file_path}` },
          ],
        };
      }
      const symbols = project.sqlite.getSymbolsByFile(file.id);
      const formatted = formatFileSummary(
        file.path,
        file.language,
        file.line_count,
        symbols,
        file.purpose,
      );
      return { content: [{ type: "text" as const, text: formatted }] };
    },
  );

  // Tool 3: get_symbol
  server.tool(
    "get_symbol",
    "Look up a specific symbol (function, class, interface, type) by name. Returns its full definition, signature, docstring, location, and relationships.",
    {
      name: z.string().max(500).describe("Symbol name to look up"),
      kind: z
        .enum(["function", "class", "interface", "type", "method", "enum", "any"])
        .optional()
        .default("any"),
    },
    async (args) => {
      const symbol = project.sqlite.getSymbolByName(
        args.name,
        args.kind === "any" ? undefined : args.kind,
      );
      if (!symbol) {
        return {
          content: [
            { type: "text" as const, text: `Symbol not found: ${args.name}` },
          ],
        };
      }
      const file = project.sqlite.getFileById(symbol.file_id);
      let output = `<symbol name="${escapeXmlAttr(symbol.name)}" kind="${symbol.kind}" file="${escapeXmlAttr(file?.path ?? "?")}" lines="${symbol.start_line}-${symbol.end_line}">\n`;
      if (symbol.docstring) {
        output += `  <docstring>${escapeXmlContent(symbol.docstring)}</docstring>\n`;
      }
      output += `  <signature>${escapeXmlContent(symbol.signature ?? symbol.name)}</signature>\n`;
      output += `  <importance>${symbol.importance_score.toFixed(2)}</importance>\n`;

      // Show callers/callees if graph edges exist
      if (symbol.id) {
        const outEdges = project.sqlite.getEdgesFrom(symbol.id);
        const inEdges = project.sqlite.getEdgesTo(symbol.id);

        // Batch-load all referenced symbols and files to avoid N+1
        const allSymbolIds = new Set<number>();
        for (const e of outEdges.slice(0, 10)) allSymbolIds.add(e.target_symbol_id);
        for (const e of inEdges.slice(0, 10)) allSymbolIds.add(e.source_symbol_id);
        const symCache = new Map<number, { name: string; file_id: number; start_line: number }>();
        const fileCache = new Map<number, string>();
        for (const sid of allSymbolIds) {
          const s = project.sqlite.getSymbolById(sid);
          if (s) {
            symCache.set(sid, { name: s.name, file_id: s.file_id, start_line: s.start_line });
            if (!fileCache.has(s.file_id)) {
              const f = project.sqlite.getFileById(s.file_id);
              if (f) fileCache.set(s.file_id, f.path);
            }
          }
        }

        if (outEdges.length > 0) {
          output += "  <calls>\n";
          for (const e of outEdges.slice(0, 10)) {
            const target = symCache.get(e.target_symbol_id);
            if (target) {
              output += `    ${target.name} [${fileCache.get(target.file_id) ?? "?"}:${target.start_line}] (${e.edge_type})\n`;
            }
          }
          output += "  </calls>\n";
        }
        if (inEdges.length > 0) {
          output += "  <called_by>\n";
          for (const e of inEdges.slice(0, 10)) {
            const source = symCache.get(e.source_symbol_id);
            if (source) {
              output += `    ${source.name} [${fileCache.get(source.file_id) ?? "?"}:${source.start_line}] (${e.edge_type})\n`;
            }
          }
          output += "  </called_by>\n";
        }
      }

      output += "</symbol>";
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // Tool 4: get_dependencies
  server.tool(
    "get_dependencies",
    "Explore the dependency graph starting from a symbol. Shows what this code depends on and what depends on it. Essential for understanding impact of changes.",
    {
      symbol_name: z.string().max(500).describe("Symbol name to analyze"),
      direction: z
        .enum(["dependencies", "dependents", "both"])
        .optional()
        .default("both"),
      depth: z.number().int().min(1).max(5).optional().default(2).describe("How many hops to traverse (1-5)"),
    },
    async (args) => {
      const result = getRelatedSymbols(project.sqlite, args.symbol_name, {
        depth: args.depth,
        direction: args.direction,
      });

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Symbol not found: ${args.symbol_name}`,
            },
          ],
        };
      }

      let output = `<dependencies root="${escapeXmlAttr(result.root.name)}" kind="${result.root.kind}" file="${escapeXmlAttr(result.root.filePath)}:${result.root.startLine}">\n`;

      if (result.callees.length > 0) {
        output += "  <depends_on>\n";
        for (const c of result.callees) {
          output += `    ${escapeXmlContent(c.name)} (${c.kind}) [${escapeXmlContent(c.filePath)}:${c.startLine}] depth=${c.depth}\n`;
        }
        output += "  </depends_on>\n";
      }

      if (result.callers.length > 0) {
        output += "  <depended_on_by>\n";
        for (const c of result.callers) {
          output += `    ${escapeXmlContent(c.name)} (${c.kind}) [${escapeXmlContent(c.filePath)}:${c.startLine}] depth=${c.depth}\n`;
        }
        output += "  </depended_on_by>\n";
      }

      output += "</dependencies>";
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // Tool 5: get_repo_overview
  server.tool(
    "get_repo_overview",
    "Get a high-level overview of the entire repository: structure, key modules, entry points, and most important symbols. Extremely token-efficient (~1K-5K tokens). Use this first to orient yourself.",
    {
      token_budget: z.number().int().min(100).max(100000).optional().default(2000),
    },
    async (args) => {
      const stats = project.sqlite.getStats();
      const topSymbols = project.sqlite.getTopSymbols(50);
      const formatted = formatRepoOverview(
        stats,
        topSymbols,
        project.sqlite,
        args.token_budget,
      );
      return { content: [{ type: "text" as const, text: formatted }] };
    },
  );

  // Tool 6: get_context
  server.tool(
    "get_context",
    "Assemble comprehensive context for a coding task. Combines search results, related symbols, and file summaries into a single token-efficient context package. Use this when you need to understand a feature area.",
    {
      task_description: z
        .string()
        .max(2000)
        .describe("What you are trying to accomplish"),
      focus_files: z
        .array(z.string().max(1000))
        .max(20)
        .optional()
        .describe("Files you are currently editing"),
      token_budget: z.number().int().min(100).max(100000).optional().default(8000),
    },
    async (args) => {
      let output = `<context task="${escapeXmlAttr(args.task_description)}" budget="${args.token_budget}">\n`;

      // Search for relevant code
      const searchBudget = Math.floor(args.token_budget * 0.6);
      const results = await hybridSearch(project, {
        query: args.task_description,
        limit: 15,
        tokenBudget: searchBudget,
      });

      if (results.length > 0) {
        output += formatSearchResults(results, searchBudget) + "\n";
      }

      // Add focus file summaries
      if (args.focus_files) {
        output += "  <focus_files>\n";
        for (const fp of args.focus_files) {
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
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // Tool 7: index_status
  server.tool(
    "index_status",
    "Check the status of the code index: when it was last updated, how many files/symbols are indexed, and whether a re-index is needed.",
    {},
    async () => {
      const stats = project.sqlite.getStats();
      const lastFullIndex = project.sqlite.getState("last_full_index");
      const lastIndexed = project.sqlite.getState("last_indexed");
      const model = project.sqlite.getState("embedding_model");

      let output = `<index_status>\n`;
      output += `  <files>${stats.totalFiles}</files>\n`;
      output += `  <symbols>${stats.totalSymbols}</symbols>\n`;
      output += `  <chunks>${stats.totalChunks}</chunks>\n`;
      output += `  <edges>${stats.totalEdges}</edges>\n`;
      output += `  <last_indexed>${lastIndexed ?? lastFullIndex ?? "never"}</last_indexed>\n`;
      if (lastFullIndex) {
        output += `  <last_full_index>${lastFullIndex}</last_full_index>\n`;
      }
      output += `  <embedding_model>${model ?? "none"}</embedding_model>\n`;
      output += `  <languages>${Object.entries(stats.languages).map(([l, c]) => `${l}:${c}`).join(", ")}</languages>\n`;
      output += `  <note>The index may be stale if files have changed since last indexing. Run 'repo-knowledge index' to update.</note>\n`;
      output += `</index_status>`;
      return { content: [{ type: "text" as const, text: output }] };
    },
  );

  // Cleanup on exit
  let isCleaningUp = false;
  const cleanup = () => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    // Close SQLite synchronously (the critical resource)
    try {
      project.sqlite.close();
    } catch {
      // Best-effort cleanup
    }
    // Dispose embedding model (async but best-effort, process is exiting)
    if (project.hasEmbeddings) {
      project.embeddings.dispose().catch(() => {});
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Start the server
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

# repo-knowledge

Index codebases and provide hyper-efficient context to AI coding agents via MCP server + CLI.

Instead of reading 50 files to understand a codebase, an agent queries for exactly the 20 lines it needs.

## How It Works

1. **Index** a repo: tree-sitter parses code into ASTs, extracts symbols, chunks at function boundaries, embeds locally on CPU, builds a call/import graph, ranks symbols by PageRank importance
2. **Query** via MCP: 7 tools let agents search semantically, look up symbols, traverse dependency graphs, get token-efficient repo overviews — all within configurable token budgets
3. **Storage**: SQLite (structured data + FTS5 keyword search) + LanceDB (vector embeddings) — everything local, single directory, no servers

## Quick Start

```bash
npm install
npm run build

# Initialize in any project
cd /path/to/your/project
repo-knowledge init

# Index the codebase
repo-knowledge index

# Search
repo-knowledge search "authentication middleware"

# Check status
repo-knowledge status
```

## MCP Server (for AI Agents)

Start the MCP server for use with Claude Code, Cursor, or any MCP-compatible client:

```bash
repo-knowledge serve --project /path/to/your/project
```

### Add to Claude Code

```bash
claude mcp add repo-knowledge -- node /path/to/repo-knowledge/dist/bin/repo-knowledge.js serve --project /path/to/target/repo
```

Or add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "repo-knowledge": {
      "command": "node",
      "args": [
        "/path/to/repo-knowledge/dist/bin/repo-knowledge.js",
        "serve",
        "--project",
        "/path/to/target/repo"
      ]
    }
  }
}
```

## MCP Tools

| Tool | Description | Token Cost |
|------|-------------|------------|
| `search_code` | Hybrid search (vector + keyword + symbol). Primary search tool. | ~500-4000 |
| `get_context` | Smart context assembly for a task. Combines search + graph + summaries. | ~2000-8000 |
| `get_file_summary` | File overview: purpose, exports, imports, key symbols with signatures. | ~100-500 |
| `get_symbol` | Look up a specific function/class by name. Full definition + relationships. | ~100-1000 |
| `get_dependencies` | Graph traversal: what calls/imports this, what it calls/imports. | ~200-2000 |
| `get_repo_overview` | Aider-style ranked repo map. Entry points + most important symbols. | ~1000-5000 |
| `index_status` | Index health: last updated, file/symbol counts, staleness check. | ~50 |

## CLI Commands

```
repo-knowledge init [--model <model>] [--force]     Initialize for current project
repo-knowledge index [--full] [--dry-run]            Index or re-index the codebase
repo-knowledge search <query> [-n limit] [-m mode]   Search the indexed codebase
repo-knowledge query <task> [--focus files...]        Assembled context for a task
repo-knowledge status                                Show index statistics
repo-knowledge serve [--project <dir>]               Start MCP server (stdio)
```

### Search Modes

- `hybrid` (default) — combines vector similarity + keyword matching + symbol lookup with Reciprocal Rank Fusion
- `vector` — pure semantic similarity search
- `keyword` — FTS5 BM25 keyword search
- `symbol` — symbol name/signature search

## Architecture

```
repo-knowledge/
├── src/
│   ├── core/          # Config, Project facade, errors
│   ├── parser/        # Tree-sitter WASM manager, language registry
│   ├── indexer/       # Pipeline, file discovery, symbol extraction,
│   │                  # AST chunking, graph builder, PageRank, summarizer
│   ├── embeddings/    # Pluggable provider interface, HuggingFace Transformers
│   ├── storage/       # SQLite (structured + FTS5) and LanceDB (vectors)
│   ├── search/        # Hybrid, vector, keyword, graph search + RRF reranker
│   ├── output/        # XML-tagged LLM output formatting, token budgets
│   ├── mcp/           # MCP server with 7 tools
│   ├── cli/           # Commander-based CLI
│   └── utils/         # Logger, git helpers, token counter
└── grammars/          # Tree-sitter WASM files (auto-loaded from tree-sitter-wasms)
```

### Data Storage

Everything lives in `.repo-knowledge/` inside the indexed project:

- `config.json` — settings (embedding model, chunk size, ignore patterns)
- `metadata.db` — SQLite database with files, symbols, chunks, graph edges, FTS5 indexes, summaries
- `vectors/` — LanceDB embedded vector store

### Indexing Pipeline

1. **File Discovery** — walk repo, respect `.gitignore`, filter by language/size
2. **Incremental Diff** — SHA-256 hash comparison, skip unchanged files
3. **Parse + Extract** — tree-sitter AST parsing, extract functions/classes/imports with signatures
4. **AST-Aware Chunking** — split at function/class boundaries with context headers
5. **Embed** — batch embed chunks locally on CPU (no API keys needed)
6. **Store** — write to SQLite + LanceDB
7. **Build Graph** — resolve imports, create call/extends/implements edges
8. **Rank** — PageRank on symbol graph for importance scoring
9. **Summarize** — heuristic file/directory/project summaries

## Tech Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript / Node.js |
| Code Parser | web-tree-sitter (WASM) |
| Vector DB | LanceDB (embedded, native TS SDK) |
| Structured DB | better-sqlite3 + FTS5 |
| Embeddings | @huggingface/transformers (local CPU) |
| Default Model | Xenova/all-MiniLM-L6-v2 (384-dim) |
| MCP SDK | @modelcontextprotocol/sdk |
| CLI | commander |

## Supported Languages

TypeScript, JavaScript, Python, Rust, Go, Java, CSS, JSON, HTML, YAML, Markdown

Symbol extraction (functions, classes, interfaces, imports) is supported for TypeScript, JavaScript, Python, Rust, and Go.

## Requirements

- Node.js >= 20.0.0
- No API keys required — embeddings run entirely on CPU

## License

MIT

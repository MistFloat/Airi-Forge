# AIRI Coding Agent MCP Server

A workdir-scoped [Model Context Protocol](https://modelcontextprotocol.io) server that exposes aider-aligned coding tools to AIRI's chat orchestration. The agent loop itself lives in AIRI; this server only executes tools against a single working directory.

The tool surface mirrors [aider-AI/aider](https://github.com/Aider-AI/aider): SEARCH/REPLACE edits, auto-commit + `/undo`, repo map (personalized PageRank), `/add`-`/drop` session scoping, `/run`-`/test`-`/lint`, and `/tokens` accounting — exposed as discrete MCP tools the host can call.

## When to use

- You are building an AIRI feature that needs the model to read, edit, search, or commit code inside a single project directory.
- You want aider-style edit semantics (fuzzy SEARCH/REPLACE with `...` elision) without bundling Python or a full aider install.
- You want the model to drive git safely (auto-commit attribution, `/undo` that refuses user commits, destructive-command denylist).

## When not to use

- You need a generic sandbox runtime (this server has no container/VM boundary; it trusts the workdir).
- You need the agent loop itself (system prompt, reflection, retry). That lives in AIRI chat orchestration; this server only answers tool calls.
- You need to edit multiple unrelated repos in one session (one server = one workdir; spin up another instance instead).

## Architecture

```
Host (AIRI chat orchestration)
  └─ MCP stdio client
       └─ McpServer (this package, node:process stdio)
            ├─ Read tools      read_file, read_file_range, list_dir, search_code, find_files
            ├─ Write tools     apply_diff, write_file, delete_file, move_file
            ├─ Git tools        git_status, git_diff, git_add, git_commit, git_push, git_undo, git_log, git_raw
            ├─ Command tools    run_command, run_tests, lint_files
            ├─ RepoMap tool     get_repo_map
            ├─ Session tools    add_file, drop_file, list_files, clear_session
            └─ Meta tools       count_tokens, read_conventions
```

Every tool runs against a single `Workdir` (see `src/lib/workdir.ts`). Path arguments are validated to stay inside the workdir; the server never writes outside it.

## Setup

1. Install workspace dependencies from the repo root:

   ```bash
   pnpm i
   ```

2. Configure the host to launch this server via MCP stdio. Typical `mcp.json` entry:

   ```json
   {
     "mcpServers": {
       "coding-agent": {
         "command": "node",
         "args": ["services/coding-agent/src/index.ts"],
         "env": {
           "CODING_AGENT_WORKDIR": "/path/to/project",
           "CODING_AGENT_ENABLE_GIT_COMMIT": "1"
         },
         "cwd": "/path/to/project"
       }
     }
   }
   ```

3. Run with the host's MCP client (AIRI stage-tamagotchi wires this through `McpStdioManager`).

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `CODING_AGENT_WORKDIR` | `process.cwd()` | Root directory all tools operate within. |
| `CODING_AGENT_ENABLE_GIT_COMMIT` | unset | Set to `1` to allow `git_commit` and `git_undo`. When unset, commit tools refuse to run (mirrors aider `--auto-commits=false`). |
| `CODING_AGENT_ENABLE_GIT_FORCE` | unset | Set to `1` to bypass the destructive-pattern denylist in `git_raw` (force-push, `clean -fdx`, `branch -D`, hard reset to a hash). |

## Tool reference

All tools return `{ content: [{ type: 'text', text }], structuredContent?, isError? }` per the MCP spec. Error results set `isError: true`; the agent's retry loop should react to them rather than re-issue the same call.

### Read

- **`read_file`** — Read a UTF-8 file with paging (`offset`, `maxChars`). Returns `isTruncated` + `totalChars`.
- **`read_file_range`** — Read an exact `[offset, offset+length)` character range (for targeted lookups in large files).
- **`list_dir`** — List directory entries (respects `.gitignore`, skips `.git`). `depth` recurses (0–5).
- **`search_code`** — Search file contents with ripgrep (JS fallback when `rg` is missing). Returns `path:line` + optional context lines.
- **`find_files`** — Find files by path substring or extension (ripgrep `--files` mode, JS walker fallback).

### Write

- **`apply_diff`** — Apply aider-style SEARCH/REPLACE blocks. All-or-nothing: if any block fails to match, nothing is written and a "did you mean" suggestion is returned. Matching chain: exact → missing-leading-whitespace → skip-blank-leading-line → `...` elision → fuzzy (bigram Jaccard).
- **`write_file`** — Create or fully overwrite a file (creates missing parent directories).
- **`delete_file`** — Delete a file or empty directory (`recursive: true` for non-empty dirs; never deletes the workdir root).
- **`move_file`** — Rename/move a file. Plain rename by default; `useGitMv: true` for `git mv` (preserves history).

### Git

- **`git_status`** — Short-form working-tree status + current branch.
- **`git_diff`** — Unstaged diff (`staged: true` for staged diff).
- **`git_add`** — Stage explicit paths, or all changes (`git add -A`) when `paths` is omitted.
- **`git_commit`** — Commit staged changes. Attributed to `airi-coding-agent (aider-mcp)` so `git_undo` can identify agent commits.
- **`git_push`** — Push the current branch (or explicit `branch`) to a remote.
- **`git_undo`** — Undo the most recent agent-made commit (soft reset by default; `hard: true` reverts the working tree). Refuses to undo commits made by anyone other than the agent; stops at the first non-agent commit.
- **`git_log`** — Commit history with format/limit/path filters.
- **`git_raw`** — Escape hatch for arbitrary git subcommands. Rejects destructive patterns (`push --force`, `clean -fdx`, `branch -D`, hard reset to a hash) unless `CODING_AGENT_ENABLE_GIT_FORCE=1`.

### Command

- **`run_command`** — Run a shell command inside the workdir (no shell expansion: `&&`, `;`, `|` are not interpreted). Output capped at 256KB each.
- **`run_tests`** — Run a test command and surface a structured `passed`/`failed` flag. Non-zero exit is not a tool error — it's a signal to the agent.
- **`lint_files`** — Structural linter (unbalanced brackets, unterminated strings). For project linters (eslint, ruff, etc.) call `run_command`.

### RepoMap

- **`get_repo_map`** — Build a ranked, token-budgeted repo map (aider `--map-tokens` equivalent). Files ranked by personalized PageRank over the symbol-reference graph; personalization biases toward `focusPaths` (or the session's editable files when omitted).

### Session

- **`add_file`** — Add a file as editable or read-only. `createIfMissing: true` pre-creates an empty file (mirrors aider `/add newfile.py`).
- **`drop_file`** — Remove a file from the session.
- **`list_files`** — List session files (editable first).
- **`clear_session`** — Clear the entire session.

### Meta

- **`count_tokens`** — Estimate token counts for text or session files. Character-based heuristic (≈3.5 chars/token code, ≈4.0 prose). For absolute prompt-fit checks, ask the host runtime's tokenizer.
- **`read_conventions`** — Read project conventions files (AGENTS.md, .cursorrules, CONVENTIONS.md, .editorconfig, etc.).

## Development

```bash
# Typecheck
pnpm -F @proj-airi/coding-agent typecheck

# Lint
pnpm -F @proj-airi/coding-agent lint
pnpm -F @proj-airi/coding-agent lint:fix

# Tests (Vitest)
pnpm -F @proj-airi/coding-agent test
pnpm -F @proj-airi/coding-agent exec vitest run src/lib/edit.test.ts  # targeted

# Dev run (stdio server)
pnpm -F @proj-airi/coding-agent dev
```

### Layout

- `src/index.ts` — MCP server entrypoint; registers all tools and wires `ServerContext`.
- `src/tools/` — Tool handlers (one file per group). Each adapts lib functions to `McpToolResult`.
- `src/lib/` — Pure library code (no MCP dependency). Tested in isolation.
  - `workdir.ts` — Workdir boundary + path resolution.
  - `edit.ts` — SEARCH/REPLACE engine (aider fuzzy chain).
  - `gitignore.ts` — `.gitignore` parsing.
  - `search.ts` — ripgrep + JS fallback search.
  - `repomap.ts` — Symbol graph + personalized PageRank.
  - `lint.ts` — Structural linter.
  - `tokens.ts` — Token estimation.
  - `session.ts` — File session (editable/read-only sets).
  - `command.ts` — Subprocess runner with output caps.
  - `conventions.ts` — Conventions file reader.
  - `progress.ts` — MCP progress sink helper.

### Design notes

- **No shell, no eval.** `run_command` spawns with `shell: false` and an argv array; the agent cannot smuggle `&&`/`;` past a token boundary. This is the primary command-injection defense.
- **Path jail.** Every path argument is resolved against the workdir and rejected if it escapes. Symlinks pointing outside are ignored.
- **Commit attribution.** Agent commits set both `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` to `airi-coding-agent (aider-mcp)`; `git_undo` checks this marker and refuses to undo user-made commits.
- **All-or-nothing edits.** `apply_diff` is atomic: if any block fails to match, nothing is written and a "did you mean" suggestion is returned for self-correction.
- **No caching of file contents.** Sessions track which files are editable, not their contents; every read goes to disk so out-of-band edits (user's editor, `run_command`) are always reflected.
- **ripgrep first.** Search uses `rg` when available (fast, respects `.gitignore`); a pure-JS walker provides identical output shape when `rg` is missing. Result paths are normalized to POSIX (`src/foo.ts`) regardless of OS separators.

## License

Same as the AIRI repository root.

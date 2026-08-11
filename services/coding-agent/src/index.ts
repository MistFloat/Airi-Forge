import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'

import type { ProgressSink } from './lib/progress'
import type { Workdir } from './lib/workdir'
import type { McpToolResult } from './tools/types'

import process from 'node:process'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import { createProgressSink } from './lib/progress'
import { FileSession } from './lib/session'
import { createWorkdir } from './lib/workdir'
import { lintFilesTool, runCommandTool, runTestsTool } from './tools/command'
import { readConventionsTool } from './tools/conventions'
import { gitAddTool, gitCommitTool, gitDiffTool, gitLogTool, gitPushTool, gitRawTool, gitStatusTool, gitUndoTool } from './tools/git'
import { listDirTool, readFileRangeTool, readFileTool } from './tools/read'
import { getRepoMapTool } from './tools/repomap'
import { findFilesTool, searchCodeTool } from './tools/search'
import { addFileTool, clearSessionTool, dropFileTool, listFilesTool } from './tools/session'
import { countTokensTool } from './tools/tokens'
import { errorMessageFromValue, errorResult } from './tools/types'
import {
  applyDiffTool,
  createWriteFileChunkState,
  deleteFileTool,
  moveFileTool,
  WRITE_FILE_CHUNK_MAX_CHARS,
  writeFileChunkTool,
  writeFileTool,
} from './tools/write'

/**
 * Coding-agent MCP server: workdir-scoped tools for AIRI.
 *
 * Call stack:
 *
 * McpStdioManager (stage-tamagotchi main, stdio child process)
 *   -> {@link McpServer} (this entrypoint, stdio transport)
 *     -> read/write/git/command/search/repomap/session tool handlers
 *       -> lib/ (workdir boundary, SEARCH/REPLACE engine, command exec,
 *              ripgrep search, symbol graph, file session)
 *
 * The agent loop lives in AIRI chat orchestration; this server only executes
 * tools. The workdir is `CODING_AGENT_WORKDIR` or the process cwd (set via
 * `cwd` in mcp.json), and every path is validated against it.
 *
 * Tool groups (aider-aligned):
 * - **Read** (aider `/add` + read-only): `read_file`, `read_file_range`,
 *   `list_dir`, `search_code`, `find_files`.
 * - **Write** (aider SEARCH/REPLACE + bounded whole-file): `apply_diff`,
 *   `write_file`, `write_file_chunk`, `delete_file`, `move_file`.
 * - **Git** (aider auto-commit + /undo + /git): `git_status`, `git_diff`,
 *   `git_add`, `git_commit`, `git_push`, `git_undo`, `git_log`, `git_raw`.
 * - **Command** (aider `/run` + `/test` + `/lint`): `run_command`, `run_tests`,
 *   `lint_files`.
 * - **RepoMap** (aider `--map-tokens` + tree-of-symbols): `get_repo_map`.
 * - **Session** (aider `/add`/`/drop`/`/files`): `add_file`, `drop_file`,
 *   `list_files`, `clear_session`.
 * - **Meta** (aider `/tokens` + `/conventions`): `count_tokens`,
 *   `read_conventions`.
 */

interface ServerContext {
  chunkState: ReturnType<typeof createWriteFileChunkState>
  enableCommit: boolean
  progress: ProgressSink | undefined
  session: FileSession
  workdir: Workdir
}

const workdirRoot = process.env.CODING_AGENT_WORKDIR ?? process.cwd()
const workdir = createWorkdir(workdirRoot)
const enableCommit = process.env.CODING_AGENT_ENABLE_GIT_COMMIT === '1'
// Staged chunk writes are owned by this MCP process and isolated by writeId.
// Restarting the server intentionally invalidates all unfinished sequences.
const chunkState = createWriteFileChunkState()
// Single per-process session. The MCP stdio connection is long-lived, so
// session state persists across tool calls until the host restarts the server.
const session = new FileSession(workdir)

const server = new McpServer({ name: 'coding-agent', version: '0.2.0' })

/** Wraps a tool handler with per-request context and uniform error reporting. */
function toolHandler<Args>(
  name: string,
  handler: (args: Args, ctx: ServerContext) => Promise<McpToolResult>,
): (args: Args, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => Promise<McpToolResult> {
  return async (args, extra) => {
    const ctx: ServerContext = {
      chunkState,
      enableCommit,
      progress: createProgressSink(extra),
      session,
      workdir,
    }
    try {
      return await handler(args, ctx)
    }
    catch (error) {
      return errorResult(`${name} failed: ${errorMessageFromValue(error)}`)
    }
  }
}

// ─── Read tools ───────────────────────────────────────────────────────────────

server.registerTool('read_file', {
  description: [
    'Read a file from the workdir as UTF-8 text.',
    'Large files are paged: pass `offset` and `maxChars` to continue reading.',
    'Returns `isTruncated` in structured content when more content remains.',
  ].join(' '),
  inputSchema: {
    maxChars: z.number().int().min(1).optional().describe('Max characters to return (default 8192).'),
    offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0).'),
    path: z.string().describe('File path relative to the workdir, or an absolute path inside it.'),
  },
}, toolHandler('read_file', readFileTool))

server.registerTool('read_file_range', {
  description: [
    'Read an exact character range of a file (for targeted lookups in large files).',
    'Clipped to the actual file bounds; use `read_file` first to learn totalChars.',
  ].join(' '),
  inputSchema: {
    length: z.number().int().min(1).describe('Number of characters to return.'),
    offset: z.number().int().min(0).describe('Character offset to start from.'),
    path: z.string().describe('File path relative to the workdir, or an absolute path inside it.'),
  },
}, toolHandler('read_file_range', readFileRangeTool))

server.registerTool('list_dir', {
  description: [
    'List entries in a directory (respects .gitignore, skips .git), optionally recursive.',
    'Set `depth` to recurse (0 = current dir only, default 1, max 5).',
  ].join(' '),
  inputSchema: {
    depth: z.number().int().min(0).max(5).optional().describe('Recursion depth (default 1).'),
    path: z.string().optional().describe('Directory path relative to the workdir (default ".").'),
  },
}, toolHandler('list_dir', listDirTool))

// ─── Write tools ──────────────────────────────────────────────────────────────

server.registerTool('apply_diff', {
  description: [
    'Apply SEARCH/REPLACE edit blocks to files inside the workdir (aider-style edits).',
    'Prefer this for targeted edits to existing files instead of rewriting the whole file.',
    'Each block has `path`, `search` (exact existing lines) and `replace`.',
    'Empty `search` creates a new file or appends to an existing one.',
    'Matching chain: exact → missing-leading-whitespace → skip-blank-leading-line → dotdotdots (`...`) → fuzzy.',
    'Applied atomically: if any block fails to match, nothing is written and failures are reported with a "did you mean" suggestion.',
  ].join(' '),
  inputSchema: {
    blocks: z.array(z.object({
      path: z.string().describe('File path relative to the workdir.'),
      replace: z.string().describe('Replacement text. Empty deletes the matched region.'),
      search: z.string().describe('Exact existing lines to match. Empty creates/appends. Use `...` on its own line to elide a chunk.'),
    })).describe('SEARCH/REPLACE blocks; all-or-nothing.'),
  },
}, toolHandler('apply_diff', applyDiffTool))

server.registerTool('write_file', {
  description: [
    `Create or fully overwrite a small file of at most ${WRITE_FILE_CHUNK_MAX_CHARS} characters.`,
    'For larger files, do not put the complete content in one tool call: use write_file_chunk with mode "start", then ordered "append" calls, and final: true on the last chunk.',
    'For targeted changes to existing files, prefer apply_diff.',
  ].join(' '),
  inputSchema: {
    content: z.string().max(WRITE_FILE_CHUNK_MAX_CHARS).describe(`Full file content, at most ${WRITE_FILE_CHUNK_MAX_CHARS} characters.`),
    path: z.string().describe('File path relative to the workdir.'),
  },
}, toolHandler('write_file', writeFileTool))

server.registerTool('write_file_chunk', {
  description: [
    `Create or fully replace a large file through ordered chunks of at most ${WRITE_FILE_CHUNK_MAX_CHARS} characters.`,
    'First call mode "start" without writeId/expectedOffset. Read writeId and nextOffset from the result.',
    'For every later call use mode "append" with that exact writeId and expectedOffset.',
    'Set final: true only on the last chunk. The destination is not replaced before final, so always finish the sequence.',
    'Never guess an offset and never issue append calls in parallel.',
  ].join(' '),
  inputSchema: {
    content: z.string().max(WRITE_FILE_CHUNK_MAX_CHARS).describe(`This chunk's content, at most ${WRITE_FILE_CHUNK_MAX_CHARS} characters.`),
    expectedOffset: z.number().int().min(0).optional().describe('Exact UTF-8 byte offset returned by the preceding call. Required only for append.'),
    final: z.boolean().optional().describe('Commit the staged file after this chunk (default false).'),
    mode: z.enum(['start', 'append']).describe('Use start for the first chunk and append for every later chunk.'),
    path: z.string().describe('Destination path relative to the workdir. Repeat the same path for every chunk.'),
    writeId: z.string().optional().describe('Server-issued writeId returned by start. Required only for append.'),
  },
}, toolHandler('write_file_chunk', writeFileChunkTool))

server.registerTool('delete_file', {
  description: [
    'Delete a file, or an empty directory, inside the workdir.',
    'Non-empty directories require `recursive: true`. The workdir root itself is never deleted.',
  ].join(' '),
  inputSchema: {
    path: z.string().describe('File or directory path relative to the workdir.'),
    recursive: z.boolean().optional().describe('Delete non-empty directories recursively (default false).'),
  },
}, toolHandler('delete_file', deleteFileTool))

server.registerTool('move_file', {
  description: [
    'Move or rename a file inside the workdir.',
    'Default uses a plain rename (preserves content, breaks git history).',
    'Set `useGitMv: true` to use `git mv` instead (preserves history, requires git repo).',
    'Refuses to overwrite an existing destination — delete it first if that is the intent.',
  ].join(' '),
  inputSchema: {
    from: z.string().describe('Source path relative to the workdir.'),
    to: z.string().describe('Destination path relative to the workdir.'),
    useGitMv: z.boolean().optional().describe('Use `git mv` (default false, uses plain rename).'),
  },
}, toolHandler('move_file', moveFileTool))

// ─── Git tools ───────────────────────────────────────────────────────────────

server.registerTool('git_status', {
  description: 'Show working-tree status (short form) and the current branch.',
  inputSchema: {
    path: z.string().optional().describe('Restrict status to a path.'),
  },
}, toolHandler('git_status', gitStatusTool))

server.registerTool('git_diff', {
  description: 'Show unstaged (or staged, with `staged`) diffs for the workdir or given paths.',
  inputSchema: {
    paths: z.array(z.string()).optional().describe('Restrict diff to these paths.'),
    staged: z.boolean().optional().describe('Show staged diff instead (default false).'),
  },
}, toolHandler('git_diff', gitDiffTool))

server.registerTool('git_add', {
  description: 'Stage file changes for the next commit. Without `paths`, stages every change including deletions (`git add -A`).',
  inputSchema: {
    paths: z.array(z.string()).optional().describe('Paths to stage (relative to the workdir). Defaults to all changes.'),
  },
}, toolHandler('git_add', gitAddTool))

server.registerTool('git_commit', {
  description: [
    'Commit currently staged changes with a message.',
    'Disabled by default; enable via CODING_AGENT_ENABLE_GIT_COMMIT=1.',
    'The commit is attributed to `airi-coding-agent (aider-mcp)` so `git_undo` can identify agent-made commits.',
  ].join(' '),
  inputSchema: {
    message: z.string().describe('Commit message (non-empty, max 200 chars).'),
  },
}, toolHandler('git_commit', gitCommitTool))

server.registerTool('git_push', {
  description: 'Push the current branch (or an explicit `branch`) to a remote.',
  inputSchema: {
    branch: z.string().optional().describe('Branch to push (default: current branch).'),
    remote: z.string().optional().describe('Remote name (default `origin`).'),
  },
}, toolHandler('git_push', gitPushTool))

server.registerTool('git_undo', {
  description: [
    'Undo the most recent agent-made commit (aider `/undo` equivalent).',
    'Default soft-resets HEAD (`git reset --soft HEAD~N`); set `hard: true` to also revert the working tree.',
    'Safety: refuses to undo commits made by anyone other than the agent (the user, CI, another tool).',
    'Stops at the first non-agent commit and only undoes up to that point.',
  ].join(' '),
  inputSchema: {
    count: z.number().int().min(1).max(20).optional().describe('Number of agent commits to undo (default 1).'),
    hard: z.boolean().optional().describe('Hard-reset the working tree to match (default false, soft reset).'),
  },
}, toolHandler('git_undo', gitUndoTool))

server.registerTool('git_log', {
  description: [
    'Show commit history. Wraps `git log` with format and limit options.',
    'Set `patch: true` to include the diff per commit (large output).',
  ].join(' '),
  inputSchema: {
    format: z.enum(['oneline', 'short', 'full', 'raw']).optional().describe('Log format (default `oneline`).'),
    limit: z.number().int().min(1).max(200).optional().describe('Number of commits to show (default 10).'),
    patch: z.boolean().optional().describe('Include the diff per commit (default false).'),
    paths: z.array(z.string()).optional().describe('Restrict to commits touching these paths.'),
    ref: z.string().optional().describe('Branch or ref (default HEAD).'),
  },
}, toolHandler('git_log', gitLogTool))

server.registerTool('git_raw', {
  description: [
    'Run an arbitrary git subcommand. Escape hatch for operations not covered by the dedicated git tools.',
    'A small denylist of destructive operations (`push --force`, `clean -fd`, `branch -D`, hard reset to a hash) is rejected unless CODING_AGENT_ENABLE_GIT_FORCE=1.',
    'For common operations prefer the dedicated tools (`git_status`, `git_diff`, etc.).',
  ].join(' '),
  inputSchema: {
    args: z.array(z.string()).describe('Git args, starting with the subcommand (e.g. `["stash", "list"]`).'),
  },
}, toolHandler('git_raw', gitRawTool))

// ─── Command tools (aider /run /test /lint equivalents) ───────────────────────

server.registerTool('run_command', {
  description: [
    'Run a shell command inside the workdir (no shell expansion: `&&`, `;`, `|` are NOT interpreted).',
    'Returns stdout/stderr (truncated to 16 KiB each), exit code, and timeout/signal flags.',
    'Never throws — failures surface as `exitCode: -1` with the message in stderr.',
    'This is the primary escape hatch for operations not covered by dedicated tools (lint, test, build, etc.).',
  ].join(' '),
  inputSchema: {
    args: z.array(z.string()).optional().describe('Argv passed to the executable (no shell expansion).'),
    command: z.string().describe('Executable name (resolved against PATH).'),
    env: z.record(z.string(), z.string()).optional().describe('Extra env vars (merged with process.env).'),
    stdin: z.string().optional().describe('Text piped to the child\'s stdin.'),
    timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Max wall-clock ms (default 60_000).'),
  },
}, toolHandler('run_command', runCommandTool))

server.registerTool('run_tests', {
  description: [
    'Run a test command and surface a structured `passed`/`failed` flag.',
    'Non-zero exit code is NOT a tool error — it is a signal to the agent that tests failed; the agent\'s own retry loop takes over.',
    'Use `filter` to restrict to a specific test path or pattern (appended to argv as-is).',
  ].join(' '),
  inputSchema: {
    args: z.array(z.string()).optional().describe('Args for the test command (e.g. `["-F", "@proj-airi/coding-agent"]` for pnpm).'),
    command: z.string().describe('Test runner executable (e.g. `pnpm`, `pytest`, `cargo`).'),
    env: z.record(z.string(), z.string()).optional().describe('Extra env vars.'),
    filter: z.string().optional().describe('Test path or pattern; appended to argv as-is.'),
    stdin: z.string().optional().describe('Stdin to pipe in.'),
    timeoutMs: z.number().int().min(1000).max(600000).optional().describe('Max runtime ms (default 120_000; tests are slower than shells).'),
  },
}, toolHandler('run_tests', runTestsTool))

server.registerTool('lint_files', {
  description: [
    'Lint files using the built-in structural linter (no setup required).',
    'Catches: unbalanced brackets, unterminated string literals, unclosed blocks.',
    'For per-language project linters (eslint, ruff, golangci-lint) call `run_command` with the appropriate tool.',
    'Returns issues with file:line:column + rule + message, structured for retry.',
  ].join(' '),
  inputSchema: {
    paths: z.array(z.string()).min(1).describe('Files to lint (relative to the workdir).'),
  },
}, toolHandler('lint_files', lintFilesTool))

// ─── Search tools ─────────────────────────────────────────────────────────────

server.registerTool('search_code', {
  description: [
    'Search file contents using ripgrep (JS fallback when `rg` is unavailable).',
    'Returns matches with `path:line` plus optional context lines.',
    'Set `regex: true` for regex; default is plain-text search.',
    'Case-insensitive by default; set `caseSensitive: true` to override.',
  ].join(' '),
  inputSchema: {
    caseSensitive: z.boolean().optional().describe('Case-sensitive match (default false).'),
    contextLines: z.number().int().min(0).max(20).optional().describe('Context lines before/after each match (default 2).'),
    globs: z.array(z.string()).optional().describe('Glob filters, e.g. `[\'*.ts\']`.'),
    includeIgnored: z.boolean().optional().describe('Include dotfiles and git-ignored entries (default false).'),
    maxMatches: z.number().int().min(1).max(500).optional().describe('Max matches to return (default 50).'),
    path: z.string().optional().describe('Directory to search (relative to workdir; default `.`).'),
    pattern: z.string().describe('Pattern to search for (plain text by default).'),
    regex: z.boolean().optional().describe('Treat `pattern` as a regex (default false).'),
  },
}, toolHandler('search_code', searchCodeTool))

server.registerTool('find_files', {
  description: [
    'Find files by path pattern or extension.',
    'Uses ripgrep\'s `--files` mode when available, JS walker fallback otherwise.',
    'Respects `.gitignore` by default; set `includeIgnored: true` to override.',
  ].join(' '),
  inputSchema: {
    extensions: z.array(z.string()).optional().describe('Restrict to these extensions (e.g. `[\'ts\', \'vue\']`).'),
    includeIgnored: z.boolean().optional().describe('Include dotfiles and git-ignored entries (default false).'),
    maxResults: z.number().int().min(1).max(2000).optional().describe('Max files to return (default 200).'),
    pattern: z.string().optional().describe('Substring or regex (with `regex: true`) matched against the path.'),
    regex: z.boolean().optional().describe('Treat `pattern` as a regex (default false, plain substring).'),
  },
}, toolHandler('find_files', findFilesTool))

// ─── RepoMap tools ────────────────────────────────────────────────────────────

server.registerTool('get_repo_map', {
  description: [
    'Build a ranked, token-budgeted repo map (aider `--map-tokens` equivalent).',
    'Files are ranked by personalized PageRank over the symbol-reference graph;',
    'the personalization vector biases toward `focusPaths` (or the session\'s editable files when omitted).',
    'Output is a tree-of-symbols string trimmed to the token budget.',
    'Call once at the start of a session for an overview; re-call when the editable set changes significantly.',
  ].join(' '),
  inputSchema: {
    focusPaths: z.array(z.string()).optional().describe('Paths to bias the ranking toward (default: session editable files).'),
    includeAll: z.boolean().optional().describe('Include all symbols regardless of rank (default false).'),
    maxFiles: z.number().int().min(1).max(500).optional().describe('Max files in the map (default 50).'),
    tokenBudget: z.number().int().min(256).max(32768).optional().describe('Approximate token budget for the output (default 2048).'),
  },
}, toolHandler('get_repo_map', getRepoMapTool))

// ─── Session tools (aider /add /drop /files equivalents) ─────────────────────

server.registerTool('add_file', {
  description: [
    'Add a file to the session. Editable files can be edited via `apply_diff`;',
    'read-only files are reference-only.',
    'When `createIfMissing: true` and the file does not exist, it is pre-created as an empty file (mirrors aider\'s `/add newfile.py` placeholder pattern).',
    'Files in the session are also used as the default focus set for `get_repo_map` and as the input set for `count_tokens`.',
  ].join(' '),
  inputSchema: {
    createIfMissing: z.boolean().optional().describe('Pre-create the file as empty if it does not exist (default false).'),
    path: z.string().describe('File path relative to the workdir.'),
    readOnly: z.boolean().optional().describe('Add as read-only (default false, editable).'),
  },
}, toolHandler('add_file', addFileTool))

server.registerTool('drop_file', {
  description: 'Remove a file from the session (either editable or read-only).',
  inputSchema: {
    path: z.string().describe('File path to remove from the session.'),
  },
}, toolHandler('drop_file', dropFileTool))

server.registerTool('list_files', {
  description: [
    'List all files in the session, editable first then read-only.',
    'Use to recall what the agent is currently working on without re-reading each file.',
  ].join(' '),
  inputSchema: {},
}, toolHandler('list_files', listFilesTool))

server.registerTool('clear_session', {
  description: 'Clear the entire session (remove all editable and read-only files).',
  inputSchema: {},
}, toolHandler('clear_session', clearSessionTool))

// ─── Meta tools ───────────────────────────────────────────────────────────────

server.registerTool('count_tokens', {
  description: [
    'Estimate token counts for explicit text or every file in the session.',
    'Uses a character-based heuristic (~3.5 chars/token for code, ~4.0 for prose);',
    'for absolute prompt-fit checks, ask the host runtime\'s tokenizer.',
    'Use this to decide when to `drop_file` to stay under the model\'s context budget.',
  ].join(' '),
  inputSchema: {
    includeSession: z.boolean().optional().describe('When `text` is omitted and a session is active, count session files (default true).'),
    path: z.string().optional().describe('Path hint for content-type detection (code vs prose ratio).'),
    text: z.string().optional().describe('When provided, count tokens for this text instead of the session files.'),
  },
}, toolHandler('count_tokens', countTokensTool))

server.registerTool('read_conventions', {
  description: [
    'Read project conventions files (AGENTS.md, .cursorrules, CONVENTIONS.md, etc.).',
    'Returns all available conventions files concatenated when `name` is omitted.',
    'Set `includeScripts: true` to also return the test/lint scripts from package.json.',
    'Call once at the start of a session to load coding standards and agent instructions.',
  ].join(' '),
  inputSchema: {
    includeScripts: z.boolean().optional().describe('Also return package.json scripts (default false).'),
    name: z.string().optional().describe('Read only this specific conventions file (e.g. `AGENTS.md`).'),
  },
}, toolHandler('read_conventions', readConventionsTool))

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error: unknown) => {
  console.error(`[coding-agent] fatal: ${errorMessageFromValue(error)}`)
  process.exit(1)
})

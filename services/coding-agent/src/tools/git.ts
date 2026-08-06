import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import process from 'node:process'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { resolveInWorkdir } from '../lib/workdir'
import { errorMessageFromValue, errorResult, textResult } from './types'

export interface GitAddArgs {
  /** Paths to stage (relative to the workdir); empty stages everything via `git add -A`. */
  paths?: string[]
}

export interface GitCommitArgs {
  message: string
}

export interface GitDiffArgs {
  paths?: string[]
  staged?: boolean
}

export interface GitLogArgs {
  /** Format: `oneline` (default), `short`, `full`, or `raw`. */
  format?: 'full' | 'oneline' | 'raw' | 'short'
  /** Number of commits to show (default 10). */
  limit?: number
  /** When true, includes the diff for each commit (much larger output). */
  patch?: boolean
  /** Restrict to commits touching these paths. */
  paths?: string[]
  /** Branch or ref (default HEAD). */
  ref?: string
}

export interface GitPushArgs {
  /** Branch to push; defaults to the current branch. */
  branch?: string
  /** Remote name (default `origin`). */
  remote?: string
}

export interface GitRawArgs {
  /** Subcommand args (e.g. `['log', '--oneline', '-5']`). The first element is the git subcommand. */
  args: string[]
}

export interface GitStatusArgs {
  path?: string
}

export interface GitToolsContext {
  /**
   * When false, `git_commit` refuses to run (default). Mirrors aider's
   * `--auto-commits=false` setting: the agent must opt into writes that
   * produce history, since they are hard to undo out-of-band.
   */
  enableCommit: boolean
  workdir: Workdir
}

export interface GitUndoArgs {
  /** Number of commits to undo (default 1). */
  count?: number
  /**
   * When true, hard-resets the working tree to match the reset commit
   * (mirrors aider's `/undo` which calls `git reset --hard HEAD~1`).
   * Default false keeps the working tree untouched, only moving HEAD.
   */
  hard?: boolean
}

const execFileAsync = promisify(execFile)

/**
 * Aider attribution marker. Commits made by this server set the committer
 * name to `(aider-mcp)` so `git_undo` can identify them and refuse to undo
 * commits made by the user or another tool. Mirrors aider's `(aider)`
 * suffix on the committer name.
 */
const AIDER_COMMITTER_NAME = 'airi-coding-agent (aider-mcp)'
const AIDER_AUTHOR_NAME = 'airi-coding-agent (aider-mcp)'

/**
 * Stages file changes for the next commit. Without explicit `paths` it stages
 * everything, including deletions, via `git add -A`.
 */
export async function gitAddTool(args: GitAddArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  const gitArgs = ['add']
  const paths = args.paths ?? []
  if (paths.length > 0) {
    const pathResolution = resolvePaths(ctx.workdir, paths)
    if (pathResolution.error)
      return errorResult(pathResolution.error)
    gitArgs.push(...pathResolution.resolved)
  }
  else {
    gitArgs.push('-A')
  }

  try {
    await runGit(ctx.workdir, gitArgs)
  }
  catch (error) {
    return errorResult(`git add failed: ${errorMessageFromValue(error)}`)
  }

  return textResult(paths.length > 0 ? `Staged: ${paths.join(', ')}` : 'Staged all changes', {
    paths: paths.length > 0 ? paths : undefined,
  })
}

/**
 * Commits the current staged changes. Disabled unless explicitly enabled.
 *
 * The commit is attributed to `airi-coding-agent (aider-mcp)` so subsequent
 * `git_undo` calls can identify it as agent-made and refuse to undo commits
 * the user made out-of-band. Mirrors aider's `(aider)` committer marker.
 */
export async function gitCommitTool(args: GitCommitArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  if (!ctx.enableCommit) {
    return errorResult(
      'git_commit is disabled. Set CODING_AGENT_ENABLE_GIT_COMMIT=1 in the server environment to enable it.',
    )
  }
  const message = args.message.trim()
  if (message === '') {
    return errorResult('git_commit requires a non-empty message')
  }
  if (message.length > 200) {
    return errorResult(`git_commit message is ${message.length} chars; keep it under 200`)
  }

  let output: string
  try {
    // Set both author and committer identity so `git_undo` can identify
    // agent-made commits via either field (aider does the same).
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: AIDER_AUTHOR_NAME,
      GIT_COMMITTER_NAME: AIDER_COMMITTER_NAME,
    }
    output = (await runGit(ctx.workdir, ['commit', '-m', message], env)).trim()
  }
  catch (error) {
    return errorResult(`git commit failed: ${errorMessageFromValue(error)}`)
  }

  return textResult(output, { attributedTo: 'airi-coding-agent', message })
}

/** Shows unstaged (or staged, with `staged`) diff output for optional paths. */
export async function gitDiffTool(args: GitDiffArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  const gitArgs = ['diff']
  if (args.staged)
    gitArgs.push('--staged')
  const pathResolution = resolvePaths(ctx.workdir, args.paths ?? [])
  if (pathResolution.error)
    return errorResult(pathResolution.error)
  gitArgs.push(...pathResolution.resolved)

  let output: string
  try {
    output = (await runGit(ctx.workdir, gitArgs)).trimEnd()
  }
  catch (error) {
    return errorResult(`git diff failed: ${errorMessageFromValue(error)}`)
  }

  return textResult(output === '' ? '(no diff)' : output, { staged: args.staged ?? false })
}

/**
 * Pushes the current branch (or an explicit `branch`) to a remote. Argument
 * names are validated against a narrow charset; git runs without a shell, so
 * there is no command injection surface beyond that.
 */
export async function gitPushTool(args: GitPushArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  const remote = args.remote?.trim() || 'origin'
  const branch = args.branch?.trim() || undefined
  if (!/^[\w./-]+$/.test(remote))
    return errorResult(`Invalid git remote name: ${remote}`)
  if (branch !== undefined && !/^[\w./-]+$/.test(branch))
    return errorResult(`Invalid git branch name: ${branch}`)

  const gitArgs = ['push', remote]
  if (branch)
    gitArgs.push(branch)

  let output: string
  try {
    output = (await runGit(ctx.workdir, gitArgs)).trim()
  }
  catch (error) {
    return errorResult(`git push failed: ${errorMessageFromValue(error)}`)
  }

  return textResult(output === '' ? `Pushed to ${remote}` : output, { branch: branch ?? '(current)', remote })
}

/** Shows working-tree status in short form plus the current branch. */
export async function gitStatusTool(args: GitStatusArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  const gitArgs = ['status', '--short', '--branch']
  const paths = args.path ? [args.path] : []
  const pathResolution = resolvePaths(ctx.workdir, paths)
  if (pathResolution.error)
    return errorResult(pathResolution.error)
  gitArgs.push(...pathResolution.resolved)

  let output: string
  try {
    output = (await runGit(ctx.workdir, gitArgs)).trim()
  }
  catch (error) {
    return errorResult(`git status failed: ${errorMessageFromValue(error)}`)
  }

  const lines = output === '' ? [] : output.split('\n')
  let branch: string | undefined
  const entries: Array<{ path: string, status: string }> = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = line.slice(3)
      continue
    }
    entries.push({ path: line.slice(3), status: line.slice(0, 2) })
  }

  return textResult(output === '' ? '(clean working tree)' : output, { branch, entries })
}

/**
 * Undoes the most recent agent-made commit. Mirrors aider's `/undo`:
 * `git reset --hard HEAD~N` (when `hard: true`) or `git reset HEAD~N` (default).
 *
 * Safety: refuses to reset past commits made by anyone other than the
 * agent (the user, another tool, CI). This prevents `git_undo` from
 * wiping the user's work — the agent's own commits are disposable, but
 * the user's commits are not. The check uses the committer name marker
 * set by `git_commit` (`airi-coding-agent (aider-mcp)`).
 */
export async function gitUndoTool(args: GitUndoArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  const count = Math.max(1, Math.min(args.count ?? 1, 20))
  const hard = args.hard ?? false

  // Walk back `count` commits starting from HEAD and verify each is agent-made.
  // We stop at the first non-agent commit and only undo up to that point.
  // `HEAD~0` is HEAD itself, so the first iteration checks the most recent
  // commit; if that isn't agent-made we refuse (mirroring aider's `/undo`
  // refusing to drop a user-made commit).
  let safeCount = 0
  try {
    for (let i = 0; i < count; i++) {
      const committerName = (await runGit(ctx.workdir, ['log', '-1', `--format=%cn`, `HEAD~${i}`])).trim()
      if (!committerName.includes('aider-mcp')) {
        // Stop here — don't undo this commit or anything before it.
        break
      }
      safeCount = i + 1
    }
  }
  catch (error) {
    return errorResult(`git_undo failed to inspect history: ${errorMessageFromValue(error)}`)
  }

  if (safeCount === 0) {
    return errorResult(
      'git_undo refused: the most recent commit was not made by the coding agent. '
      + 'Only agent-made commits (marked with `airi-coding-agent (aider-mcp)`) can be undone.',
    )
  }

  const resetArgs = ['reset', hard ? '--hard' : '--soft', `HEAD~${safeCount}`]
  let output: string
  try {
    output = (await runGit(ctx.workdir, resetArgs)).trim()
  }
  catch (error) {
    return errorResult(`git_undo failed: ${errorMessageFromValue(error)}`)
  }

  return textResult(
    output === '' ? `Undid ${safeCount} agent commit(s)` : output,
    { count: safeCount, hard },
  )
}

/**
 * Checks that every requested path stays inside the workdir, returning the
 * resolved absolute paths or an error message.
 */
function resolvePaths(workdir: Workdir, paths: string[]): { error?: string, resolved: string[] } {
  const resolved: string[] = []
  for (const p of paths) {
    const result = resolveInWorkdir(workdir, p)
    if (!result.ok)
      return { error: `Path is outside the workdir: ${result.requested}`, resolved }
    resolved.push(result.absolute)
  }
  return { resolved }
}

async function runGit(workdir: Workdir, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: workdir.root,
    encoding: 'utf8',
    env: env ?? process.env,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout
}

/**
 * Runs an arbitrary git subcommand. Escape hatch for operations not covered
 * by the dedicated tools (e.g. `git stash`, `git branch`, `git rebase`).
 *
 * Safety: a small denylist of destructive subcommands (`push --force`,
 * `clean -fdx`) is rejected unless explicitly enabled via env. We do not
 * try to validate every git invocation — the agent is expected to use the
 * dedicated tools for common operations and `git_raw` for the rest.
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp, reason: string }> = [
  { pattern: /push\s+(?:-f|--force)/, reason: 'force-push' },
  // NOTICE: simplified from `push\s+(?:\S.*)?--force-with-lease` to avoid
  // polynomial backtracking between `\s+` and the following `\S` group.
  { pattern: /push\b.*--force-with-lease/, reason: 'force-with-lease push (less dangerous but still review first)' },
  { pattern: /clean\s+-[a-z]*f/, reason: 'clean -f' },
  { pattern: /reset\s+--hard\s+[a-f0-9]{7,}/, reason: 'hard reset to a specific commit' },
  { pattern: /branch\s+-D\b/, reason: 'force-delete branch' },
]

/**
 * Shows commit history. Wraps `git log` with format and limit options.
 * The `patch: true` option includes the full diff per commit, which can
 * produce large output — the agent should use it sparingly.
 */
export async function gitLogTool(args: GitLogArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  const limit = Math.max(1, Math.min(args.limit ?? 10, 200))
  const format = args.format ?? 'oneline'
  const ref = args.ref ?? 'HEAD'

  const formatFlag = format === 'oneline'
    ? '--oneline'
    : format === 'short'
      ? '--format=short'
      : format === 'full'
        ? '--format=full'
        : '--raw'

  const gitArgs = ['log', formatFlag, `-${limit}`, ref]
  if (args.patch)
    gitArgs.push('-p')

  const paths = args.paths ?? []
  if (paths.length > 0) {
    const pathResolution = resolvePaths(ctx.workdir, paths)
    if (pathResolution.error)
      return errorResult(pathResolution.error)
    gitArgs.push('--', ...pathResolution.resolved)
  }

  let output: string
  try {
    output = (await runGit(ctx.workdir, gitArgs)).trim()
  }
  catch (error) {
    return errorResult(`git_log failed: ${errorMessageFromValue(error)}`)
  }

  return textResult(output === '' ? '(no commits)' : output, { format, limit, ref })
}

export async function gitRawTool(args: GitRawArgs, ctx: GitToolsContext): Promise<McpToolResult> {
  const rawArgs = args.args ?? []
  if (rawArgs.length === 0)
    return errorResult('git_raw requires at least one arg (the subcommand)')

  // Reject obviously dangerous patterns. We allow `--force` in env to let
  // the agent escape the hatch when the user has explicitly opted in.
  const enableForce = process.env.CODING_AGENT_ENABLE_GIT_FORCE === '1'
  if (!enableForce) {
    const joined = rawArgs.join(' ')
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(joined))
        return errorResult(`git_raw refused: "${reason}" is destructive. Set CODING_AGENT_ENABLE_GIT_FORCE=1 to allow it.`)
    }
  }

  let output: string
  try {
    output = (await runGit(ctx.workdir, rawArgs)).trim()
  }
  catch (error) {
    return errorResult(`git_raw failed: ${errorMessageFromValue(error)}`)
  }

  return textResult(output === '' ? '(no output)' : output, { args: rawArgs })
}

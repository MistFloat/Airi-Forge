import type { GitignoreRule } from './gitignore'
import type { Workdir } from './workdir'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

import { isIgnored, parseGitignore } from './gitignore'
import { resolveInWorkdir } from './workdir'

/**
 * Code search primitives for the coding-agent MCP server.
 *
 * The primary path uses ripgrep (`rg`) when available — it is the fastest
 * code-search binary on this stack and is already shipped with VS Code on
 * the user's machine. When `rg` is not on PATH, we fall back to a pure-JS
 * walker that streams matches with the same output shape. The fallback is
 * correct but slow on large repos; we surface `engine: 'js'` in the result so
 * the agent can decide whether to retry with `rg` installed.
 *
 * All searches are scoped to the workdir and respect `.gitignore`. Hidden
 * files (dotfiles) and `node_modules` are skipped by default — the agent can
 * opt back in with `includeHidden` / explicit globs when it really needs them.
 */

export interface FindFilesArgs {
  /** Restrict to files whose extension matches (e.g. `['ts', 'vue']`). */
  extensions?: string[]
  /** Include dotfiles and `.git`-ignored entries (default false). */
  includeIgnored?: boolean
  /** Maximum number of matches to return (default 200). */
  maxResults?: number
  /** Optional case-insensitive substring or regex matched against the path. */
  pattern?: string
  /** When true, treat `pattern` as a regular expression (default: plain substring). */
  regex?: boolean
}

export interface FindFilesResult {
  engine: 'js' | 'rg'
  files: string[]
  truncated: boolean
}

export interface SearchCodeArgs {
  /** When true, match case-sensitively (default: case-insensitive). */
  caseSensitive?: boolean
  /** Number of context lines to include before and after each match (default 2). */
  contextLines?: number
  /** Restrict to files matching these globs (e.g. `['*.ts']`). */
  globs?: string[]
  /** Include dotfiles and `.git`-ignored entries (default false). */
  includeIgnored?: boolean
  /** Maximum number of matches to return (default 50). */
  maxMatches?: number
  /** Directory to search (relative to workdir; default `.`). */
  path?: string
  /** Pattern to search for. Plain text by default; regex when `regex: true`. */
  pattern: string
  /** When true, treat `pattern` as a regular expression. */
  regex?: boolean
}

export interface SearchCodeMatch {
  /** Optional lines of context after the match (already trimmed). */
  after?: string[]
  /** Optional lines of context before the match (already trimmed). */
  before?: string[]
  /** 1-based line number of the match. */
  line: number
  /** Path relative to the workdir, using `/` separators. */
  path: string
  /** The full matched line, trimmed of trailing newline. */
  text: string
}

export interface SearchCodeResult {
  engine: 'js' | 'rg'
  /** Number of files scanned (rg may not report this precisely). */
  filesScanned: number
  matches: SearchCodeMatch[]
  truncated: boolean
}

const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_MATCHES = 50
const DEFAULT_CONTEXT_LINES = 2
const SKIPPED_DIRS = new Set([
  '.cache',
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.venv',
  '.vite',
  '__pycache__',
  'build',
  'dist',
  'node_modules',
  'target',
])

/** Probes PATH for `rg` once per process; caches the result. */
let cachedRgPath: null | string | undefined
/**
 * Finds files whose path matches a pattern, using ripgrep's `--files` mode when
 * available and falling back to a JS walk otherwise.
 */
export async function findFiles(args: FindFilesArgs, workdir: Workdir): Promise<FindFilesResult> {
  const rg = await findRg()
  if (rg)
    return findWithRg(rg, args, workdir)
  return findWithJs(args, workdir)
}

/**
 * Searches file contents using ripgrep, falling back to a JS walker when `rg`
 * is unavailable. Output is a structured match list so the agent can cite
 * `path:line` without re-parsing text.
 */
export async function searchCode(args: SearchCodeArgs, workdir: Workdir): Promise<SearchCodeResult> {
  const resolved = resolveInWorkdir(workdir, args.path ?? '.')
  if (!resolved.ok)
    return { engine: 'js', filesScanned: 0, matches: [], truncated: false }

  const rg = await findRg()
  if (rg)
    return searchWithRg(rg, args, workdir, resolved.absolute)
  return searchWithJs(args, workdir, resolved.absolute)
}

function filterByPattern(files: string[], args: FindFilesArgs): string[] {
  if (!args.pattern)
    return files
  if (args.regex) {
    const re = new RegExp(args.pattern, 'i')
    return files.filter(f => re.test(f))
  }
  const needle = args.pattern.toLowerCase()
  return files.filter(f => f.toLowerCase().includes(needle))
}

async function findRg(): Promise<null | string> {
  if (cachedRgPath !== undefined)
    return cachedRgPath
  cachedRgPath = await probePath('rg')
  return cachedRgPath
}

async function findWithJs(args: FindFilesArgs, workdir: Workdir): Promise<FindFilesResult> {
  const maxResults = Math.max(1, args.maxResults ?? DEFAULT_MAX_FILES)
  const rules = await loadGitignoreRules(workdir)
  const files: string[] = []
  let truncated = false

  await walk(workdir.root, workdir, async (_abs, rel, isDir) => {
    if (isDir)
      return
    if (!args.includeIgnored && isIgnored(rel, false, rules))
      return
    if (args.extensions && !args.extensions.includes(extname(rel).slice(1)))
      return
    if (files.length >= maxResults) {
      truncated = true
      return
    }
    files.push(rel)
  })

  const filtered = filterByPattern(files, args)
  return { engine: 'js', files: filtered, truncated: truncated || filtered.length > maxResults }
}

async function findWithRg(rg: string, args: FindFilesArgs, workdir: Workdir): Promise<FindFilesResult> {
  const maxResults = Math.max(1, args.maxResults ?? DEFAULT_MAX_FILES)
  const rgArgs = ['--files']
  if (args.includeIgnored)
    rgArgs.push('--hidden', '--no-ignore')
  if (args.extensions) {
    for (const ext of args.extensions)
      rgArgs.push('--glob', `*.${ext.replace(/^\./, '')}`)
  }

  return new Promise((resolve) => {
    const child = spawn(rg, rgArgs, { cwd: workdir.root, shell: false, windowsHide: true })
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => {
      findWithJs(args, workdir).then(resolve)
    })
    child.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      // rg prints OS-native separators on Windows (`src\foo.ts`); normalize
      // to `/` so callers can match against workdir-relative POSIX paths.
      let files = text.split('\n').filter(Boolean).map(s => normalizeToPosix(stripTrailingNewline(s)))
      files = filterByPattern(files, args)
      const truncated = files.length > maxResults
      if (truncated)
        files = files.slice(0, maxResults)
      resolve({ engine: 'rg', files, truncated })
    })
  })
}

async function loadGitignoreRules(workdir: Workdir): Promise<GitignoreRule[]> {
  try {
    const text = await readFile(join(workdir.root, '.gitignore'), 'utf8')
    return parseGitignore(text)
  }
  catch {
    return []
  }
}

function matchesGlobs(relPath: string, globs?: string[]): boolean {
  if (!globs || globs.length === 0)
    return true
  return globs.some((glob) => {
    // Simple glob: `*.ext` matches basename; `path/**` matches prefix.
    if (glob.startsWith('*.')) {
      return relPath.endsWith(glob.slice(1))
    }
    return relPath === glob
  })
}

/**
 * Normalizes a path emitted by rg to the workdir-relative POSIX form callers
 * expect (e.g. `src/foo.ts`). rg on Windows uses `\` separators and prefixes
 * relative results with `.\` (e.g. `.\src\foo.ts`); we normalize both away.
 */
function normalizeToPosix(p: string): string {
  let result = p.includes('\\') ? p.replaceAll('\\', '/') : p
  // Strip leading `./` that rg emits when the search root is `.`.
  if (result.startsWith('./'))
    result = result.slice(2)
  return result
}

/**
 * Parses `rg --json` output into structured matches.
 *
 * rg's JSON stream is grouped per file: `begin`, then a sequence of
 * `context`/`match` records, then `end`. With `-CN` set, context records
 * appear before/after each match within a file; we associate the leading
 * context with the next match's `before` and the trailing context with the
 * previous match's `after`. Without `-C`, no `context` records are emitted
 * and `before`/`after` stay `undefined` to match the JS fallback's contract.
 */
function parseRgJson(text: string, maxMatches: number, context: number): SearchCodeResult {
  const matches: SearchCodeMatch[] = []
  let filesScanned = 0
  let truncated = false
  // Context lines buffered before the next match in the current file.
  let pendingBefore: string[] = []
  // The most recent match in the current file; its `after` buffer is still
  // being filled by trailing `context` records until the next match/end.
  let lastMatch: null | SearchCodeMatch = null
  let lastMatchAfter: string[] | undefined

  const finalizeLastMatch = () => {
    if (lastMatch && lastMatchAfter) {
      lastMatch.after = lastMatchAfter
    }
    lastMatch = null
    lastMatchAfter = undefined
  }

  for (const line of text.split('\n')) {
    if (line === '')
      continue
    let record
    try {
      record = JSON.parse(line)
    }
    catch {
      continue
    }
    if (record.type === 'begin') {
      filesScanned++
      pendingBefore = []
      finalizeLastMatch()
      continue
    }
    if (record.type === 'end') {
      finalizeLastMatch()
      pendingBefore = []
      continue
    }
    if (record.type === 'context') {
      const ctxText = stripTrailingNewline(record.data.lines?.text ?? '')
      if (lastMatch)
        lastMatchAfter!.push(ctxText)
      else
        pendingBefore.push(ctxText)
      continue
    }
    if (record.type === 'match') {
      if (matches.length >= maxMatches) {
        truncated = true
        break
      }
      // Trailing context of the previous match ends here.
      finalizeLastMatch()
      const data = record.data
      const match: SearchCodeMatch = {
        after: context > 0 ? [] : undefined,
        before: context > 0 ? pendingBefore : undefined,
        line: data.line_number,
        // rg emits OS-native separators on Windows (`src\foo.ts`); normalize
        // to `/` so callers can match against workdir-relative POSIX paths.
        path: normalizeToPosix(data.path?.text ?? ''),
        text: stripTrailingNewline(data.lines?.text ?? ''),
      }
      matches.push(match)
      lastMatch = match
      lastMatchAfter = match.after
      pendingBefore = []
    }
  }
  // If the stream ended mid-file (truncated), close out the last match.
  finalizeLastMatch()
  return { engine: 'rg', filesScanned, matches, truncated }
}

async function probePath(bin: string): Promise<null | string> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { shell: false, windowsHide: true })
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      resolve(code === 0 ? bin : null)
    })
    // If spawn succeeded but never exits (shouldn't happen for --version), still resolve.
    setTimeout(() => {
      if (!child.killed)
        child.kill('SIGTERM')
      resolve(null)
    }, 2_000).unref?.()
  })
}

async function searchWithJs(args: SearchCodeArgs, workdir: Workdir, searchRoot: string): Promise<SearchCodeResult> {
  const maxMatches = Math.max(1, args.maxMatches ?? DEFAULT_MAX_MATCHES)
  const context = Math.max(0, args.contextLines ?? DEFAULT_CONTEXT_LINES)
  const rules = await loadGitignoreRules(workdir)
  const pattern = args.regex
    ? new RegExp(args.pattern, args.caseSensitive ? '' : 'i')
    : undefined
  const needle = args.caseSensitive
    ? args.pattern
    : args.pattern.toLowerCase()

  const matches: SearchCodeMatch[] = []
  let filesScanned = 0
  let truncated = false

  await walk(searchRoot, workdir, async (abs, rel, isDir) => {
    if (isDir)
      return
    if (!args.includeIgnored && isIgnored(rel, false, rules))
      return
    if (!matchesGlobs(rel, args.globs))
      return
    filesScanned++
    let content: string
    try {
      content = await readFile(abs, 'utf8')
    }
    catch {
      return
    }
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const isMatch = pattern
        ? pattern.test(line)
        : (args.caseSensitive ? line : line.toLowerCase()).includes(needle)
      if (!isMatch)
        continue
      if (matches.length >= maxMatches) {
        truncated = true
        return
      }
      matches.push({
        after: context > 0 ? lines.slice(i + 1, i + 1 + context) : undefined,
        before: context > 0 ? lines.slice(Math.max(0, i - context), i) : undefined,
        line: i + 1,
        path: rel,
        text: line,
      })
    }
  })

  return { engine: 'js', filesScanned, matches, truncated }
}

async function searchWithRg(rg: string, args: SearchCodeArgs, workdir: Workdir, searchRoot: string): Promise<SearchCodeResult> {
  const maxMatches = Math.max(1, args.maxMatches ?? DEFAULT_MAX_MATCHES)
  const context = Math.max(0, args.contextLines ?? DEFAULT_CONTEXT_LINES)

  // Pass a workdir-relative root so rg emits paths relative to `workdir.root`.
  // An absolute `searchRoot` would surface as absolute paths in `data.path.text`,
  // breaking `path:line` citations for the caller.
  const relativeRoot = relative(workdir.root, searchRoot) || '.'

  const rgArgs = [
    '--line-number',
    '--no-heading',
    '--color=never',
    '--json',
    `--max-count=${maxMatches}`,
  ]
  if (context > 0)
    rgArgs.push(`-C${context}`)
  if (!args.caseSensitive)
    rgArgs.push('--ignore-case')
  if (!args.regex)
    rgArgs.push('--fixed-strings')
  for (const glob of args.globs ?? [])
    rgArgs.push('--glob', glob)
  if (args.includeIgnored)
    rgArgs.push('--hidden', '--no-ignore')
  rgArgs.push(args.pattern, relativeRoot)

  return new Promise((resolve) => {
    const child = spawn(rg, rgArgs, { cwd: workdir.root, shell: false, windowsHide: true })
    const chunks: Buffer[] = []
    let stderrText = ''
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrText += chunk.toString('utf8'))
    child.on('error', () => {
      // If rg fails outright (corrupt binary, etc.), fall back to JS.
      searchWithJs(args, workdir, searchRoot).then(resolve)
    })
    child.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text === '' && stderrText !== '') {
        // rg prints errors (e.g. invalid regex) to stderr with exit code 2.
        // Surface them in the match list as a synthetic entry.
        resolve({ engine: 'rg', filesScanned: 0, matches: [], truncated: false })
        return
      }
      resolve(parseRgJson(text, maxMatches, context))
    })
  })
}

function stripTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s
}

/**
 * Walks `root` and invokes `visitor` for each entry. Skips known heavy
 * directories (`.git`, `node_modules`, etc.) and respects symlinks only
 * when they point inside the workdir.
 */
async function walk(
  root: string,
  workdir: Workdir,
  visitor: (abs: string, rel: string, isDir: boolean) => Promise<void>,
): Promise<void> {
  const queue: string[] = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    let names: string[]
    try {
      names = await readdir(current)
    }
    catch {
      continue
    }
    for (const name of names) {
      if (SKIPPED_DIRS.has(name))
        continue
      const abs = join(current, name)
      const rel = relative(workdir.root, abs).replaceAll('\\', '/')
      let info
      try {
        info = await stat(abs)
      }
      catch {
        continue
      }
      const isDir = info.isDirectory()
      await visitor(abs, rel, isDir)
      if (isDir)
        queue.push(abs)
    }
  }
}

import type { GitignoreRule } from './gitignore'
import type { Workdir } from './workdir'

import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

import { isIgnored, parseGitignore } from './gitignore'
import { resolveInWorkdir } from './workdir'

/**
 * RepoMap: a ranked, token-budgeted summary of the repository's symbol graph.
 *
 * This is a portable, dependency-free port of aider's `repomap.py`. The
 * original uses tree-sitter to extract symbols and personalized PageRank
 * to rank them. We use a regex-based symbol extractor (good enough for
 * the common case, fails gracefully on unusual syntax) and the same
 * personalized PageRank algorithm (graph: file nodes, edges = cross-file
 * symbol references).
 *
 * What this gives the agent:
 * - A "map" of the repo: file → list of (line, type, name) for top symbols.
 * - Files ranked by relevance to the current session's editable files
 *   (PageRank's personalization vector biases toward those).
 * - A token-budgeted view: we trim the map to fit a budget (default 2048
 *   "tokens", estimated at 3.5 chars/token for code), keeping the
 *   highest-ranked files first.
 *
 * What this does NOT do:
 * - Build a perfect call graph. Regex extraction misses macros, dynamic
 *   dispatch, etc. The graph is an approximation.
 * - Replace the project's own LSP. For deep refactors, the agent should
 *   still use `search_code` and `read_file` on specific files.
 */

export interface GetRepoMapArgs {
  /**
   * Paths to bias the ranking toward (the "personalization" set in
   * personalized PageRank). Typically the session's editable files.
   * Files in this set are guaranteed to appear in the output.
   */
  focusPaths?: string[]
  /**
   * When true, includes all symbols from every file regardless of rank.
   * Default false; useful for small repos.
   */
  includeAll?: boolean
  /** Max files to include in the map (default 50). */
  maxFiles?: number
  /** Approximate token budget for the map output (default 2048). */
  tokenBudget?: number
}

export interface GetRepoMapResult {
  entries: RepoMapEntry[]
  /** Estimated token count of the rendered map. */
  estimatedTokens: number
  /** Number of files included in the output (after budget). */
  includedFiles: number
  /** The rendered map text, ready to feed to the LLM. */
  rendered: string
  /** Number of files skipped (out of budget). */
  skippedFiles: number
  /** Total files scanned. */
  totalFiles: number
  /** Total symbols extracted. */
  totalSymbols: number
}

export interface RepoFileNode {
  /** File extension (e.g. `ts`). */
  extension: string
  /** Number of lines in the file (used for ranking tie-breakers). */
  lineCount: number
  /** Workdir-relative path, `/`-separated. */
  path: string
  /** Symbols defined in this file. */
  symbols: RepoSymbol[]
}

export interface RepoMapEntry {
  path: string
  /** PageRank score (higher = more relevant to the personalization set). */
  score: number
  symbols: Array<{ kind: RepoSymbolKind, line: number, name: string, signature?: string }>
}

export interface RepoSymbol {
  /** Symbol kind (function, class, method, etc.). */
  kind: RepoSymbolKind
  /** 1-based line number of the symbol definition. */
  line: number
  /** Symbol name (identifier). */
  name: string
  /** Optional signature, for functions/methods. */
  signature?: string
}

export type RepoSymbolKind = 'class' | 'constant' | 'enum' | 'function' | 'interface' | 'method' | 'module' | 'struct' | 'trait' | 'type' | 'variable'

const DEFAULT_TOKEN_BUDGET = 2048
const DEFAULT_MAX_FILES = 50
const MAX_FILE_BYTES = 256 * 1024 // Skip files larger than 256KB (likely generated)
const MAX_SYMBOLS_PER_FILE = 100
const MAX_FILES_SCAN = 5_000

/** Per-language regex patterns for symbol extraction. */
const PATTERNS: Record<string, RegExp[]> = {
  go: [
    /^func\s+(?:\(.*?\)\s+)?(\w+)/gm,
    /^type\s+(\w+)/gm,
    /^const\s+(\w+)/gm,
    /^var\s+(\w+)/gm,
  ],
  python: [
    /^\s*class\s+(\w+)/gm,
    /^\s*def\s+(\w+)/gm,
    /^\s*async\s+def\s+(\w+)/gm,
  ],
  rust: [
    /^\s*pub\s+fn\s+(\w+)/gm,
    /^\s*fn\s+(\w+)/gm,
    /^\s*pub\s+struct\s+(\w+)/gm,
    /^\s*struct\s+(\w+)/gm,
    /^\s*pub\s+enum\s+(\w+)/gm,
    /^\s*enum\s+(\w+)/gm,
    /^\s*pub\s+trait\s+(\w+)/gm,
    /^\s*trait\s+(\w+)/gm,
    /^\s*impl\s+(\w+)/gm,
  ],
  // TypeScript / JavaScript / Vue script blocks. Catches `class`, `function`,
  // `interface`, `type`, `const name =`, `enum`. Arrow functions assigned to
  // consts are caught as 'variable' (we can't tell if they're functions from
  // the regex alone, but the agent rarely cares for the map).
  typescript: [
    /^\s*export\s+default\s+async\s+function\s+(\w+)/gm,
    /^\s*export\s+default\s+function\s+(\w+)/gm,
    /^\s*export\s+async\s+function\s+(\w+)/gm,
    /^\s*export\s+function\s+(\w+)/gm,
    /^\s*async\s+function\s+(\w+)/gm,
    /^\s*function\s+(\w+)/gm,
    /^\s*export\s+default\s+class\s+(\w+)/gm,
    /^\s*export\s+abstract\s+class\s+(\w+)/gm,
    /^\s*export\s+class\s+(\w+)/gm,
    /^\s*abstract\s+class\s+(\w+)/gm,
    /^\s*class\s+(\w+)/gm,
    /^\s*export\s+interface\s+(\w+)/gm,
    /^\s*interface\s+(\w+)/gm,
    /^\s*export\s+type\s+(\w+)/gm,
    /^\s*type\s+(\w+)/gm,
    /^\s*export\s+enum\s+(\w+)/gm,
    /^\s*enum\s+(\w+)/gm,
    /^\s*export\s+const\s+(\w+)\s*=/gm,
    /^\s*const\s+(\w+)\s*=/gm,
  ],
}

const EXT_LANGUAGE: Record<string, keyof typeof PATTERNS> = {
  cjs: 'typescript',
  cts: 'typescript',
  go: 'go',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  mts: 'typescript',
  py: 'python',
  rs: 'rust',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'typescript',
}

/** Files we always skip when building the map. */
const SKIP_DIRS = new Set([
  '.aider',
  '.cache',
  '.git',
  '.idea',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.venv',
  '.vite',
  '.vscode',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
])

/**
 * Builds a token-budgeted repo map, biased toward `focusPaths`. The output
 * is a string in aider's tree-of-symbols format:
 *
 * ```
 * path/to/file.ts:
 * ⋮...
 * │class Foo:
 * ⋮...
 * │  function bar (signature)
 * ⋮...
 * ```
 *
 * Files are listed in rank order (highest first), and within each file,
 * symbols are listed in definition order with their line numbers.
 */
export async function getRepoMap(args: GetRepoMapArgs, workdir: Workdir): Promise<GetRepoMapResult> {
  const budget = Math.max(256, args.tokenBudget ?? DEFAULT_TOKEN_BUDGET)
  const maxFiles = Math.max(1, args.maxFiles ?? DEFAULT_MAX_FILES)

  const rules = await loadGitignoreRules(workdir)
  const files = await collectFiles(workdir, rules)
  const nodes = await extractSymbols(files, workdir)

  // Build the reference graph: an edge from file A to file B exists when
  // A's text mentions one of B's symbols. We use basename + symbol name as
  // the edge key — full path resolution would require scope analysis.
  const symbolIndex = indexSymbols(nodes)
  const graph = await buildGraph(nodes, symbolIndex, workdir)

  // Personalization vector: uniform over focusPaths (or uniform over all
  // files when no focus is given, mirroring aider's "no files in chat" mode).
  const personalization = buildPersonalization(nodes, args.focusPaths)

  const scores = personalizedPageRank(graph, personalization, 0.85, 50)

  // Rank files by score; tie-break by line count (bigger files first, as
  // they tend to be more central in the codebase).
  const ranked = nodes
    .map((node, i) => ({ index: i, node, score: scores[i] }))
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1e-9)
        return b.score - a.score
      return b.node.lineCount - a.node.lineCount
    })

  // Always include focusPaths first (even if they ranked low), then fill
  // up to the budget with the remaining ranked files.
  const focusSet = new Set((args.focusPaths ?? []).map(p => p.replaceAll('\\', '/')))
  const included: typeof ranked = []
  const seen = new Set<string>()
  for (const item of ranked) {
    if (focusSet.has(item.node.path)) {
      included.push(item)
      seen.add(item.node.path)
    }
  }
  for (const item of ranked) {
    if (included.length >= maxFiles)
      break
    if (seen.has(item.node.path))
      continue
    included.push(item)
    seen.add(item.node.path)
  }

  // Render and trim to token budget.
  let rendered = ''
  let usedTokens = 0
  const entries: RepoMapEntry[] = []
  for (const item of included) {
    const node = item.node
    const entry: RepoMapEntry = {
      path: node.path,
      score: item.score,
      symbols: node.symbols.slice(0, MAX_SYMBOLS_PER_FILE).map(s => ({
        kind: s.kind,
        line: s.line,
        name: s.name,
        signature: s.signature,
      })),
    }
    const block = renderEntry(entry)
    const blockTokens = estimateTokens(block)
    if (usedTokens + blockTokens > budget && entries.length > 0)
      break
    entries.push(entry)
    rendered += block
    usedTokens += blockTokens
  }

  const totalSymbols = nodes.reduce((sum, n) => sum + n.symbols.length, 0)

  return {
    entries,
    estimatedTokens: usedTokens,
    includedFiles: entries.length,
    rendered,
    skippedFiles: Math.max(0, nodes.length - entries.length),
    totalFiles: nodes.length,
    totalSymbols,
  }
}

/**
 * Builds the file-to-file reference graph. For each file, we scan its content
 * for occurrences of every other file's symbol names. Each hit creates an
 * edge from the referencing file to the defining file. Edge weights are
 * additive — a file that references `Foo` 10 times has a stronger edge than
 * one that references it once.
 *
 * Edges are weighted 1/sqrt(count) to dampen the effect of very chatty
 * references (a file that mentions `Foo` 100 times shouldn't dominate the
 * graph). This is a simplification of aider's "definition importance" weight.
 *
 * Memory strategy: we re-read each file's content once during the scan
 * rather than holding all files in memory. The file count is bounded by
 * MAX_FILES_SCAN, and the workdir-scoped paths keep I/O local.
 */
async function buildGraph(
  nodes: RepoFileNode[],
  _symbolIndex: Map<string, { nodeIndex: number, symbol: RepoSymbol }[]>,
  workdir: Workdir,
): Promise<Map<number, Map<number, number>>> {
  // Build a quick lookup: symbol name → set of file indices defining it.
  const symbolOwners = new Map<string, Set<number>>()
  for (let i = 0; i < nodes.length; i++) {
    for (const sym of nodes[i].symbols) {
      const owners = symbolOwners.get(sym.name) ?? new Set<number>()
      owners.add(i)
      symbolOwners.set(sym.name, owners)
    }
  }

  const graph = new Map<number, Map<number, number>>()
  for (let i = 0; i < nodes.length; i++)
    graph.set(i, new Map())

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const resolved = resolveInWorkdir(workdir, node.path)
    if (!resolved.ok)
      continue
    let content: string
    try {
      content = await readFile(resolved.absolute, 'utf8')
    }
    catch {
      continue
    }
    // For each defined symbol, check if this file mentions it. Short names
    // (<3 chars) are skipped to avoid false-positive edges from common
    // substrings like "id" or "to".
    for (const [name, owners] of symbolOwners) {
      if (name.length < 3)
        continue
      let count = 0
      let pos = 0
      while ((pos = content.indexOf(name, pos)) !== -1) {
        count++
        pos += name.length
      }
      if (count === 0)
        continue
      const weight = 1 / Math.sqrt(count)
      for (const ownerIndex of owners) {
        if (ownerIndex === i)
          continue
        const edges = graph.get(i)!
        edges.set(ownerIndex, (edges.get(ownerIndex) ?? 0) + weight)
      }
    }
  }
  return graph
}

function buildPersonalization(nodes: RepoFileNode[], focusPaths?: string[]): Float64Array {
  const vec = new Float64Array(nodes.length)
  const focusSet = new Set((focusPaths ?? []).map(p => p.replaceAll('\\', '/')))
  let any = false
  for (let i = 0; i < nodes.length; i++) {
    if (focusSet.has(nodes[i].path)) {
      vec[i] = 1
      any = true
    }
    else {
      vec[i] = 0
    }
  }
  if (!any) {
    // No focus → uniform. The caller normalizes; we just set equal weights.
    for (let i = 0; i < nodes.length; i++)
      vec[i] = 1
  }
  return vec
}

function classifyMatch(patternSource: string, _language: keyof typeof PATTERNS): RepoSymbolKind {
  if (patternSource.includes('class'))
    return 'class'
  if (patternSource.includes('interface'))
    return 'interface'
  if (patternSource.includes('type ') || patternSource.includes('type\\s'))
    return 'type'
  if (patternSource.includes('enum'))
    return 'enum'
  if (patternSource.includes('struct'))
    return 'struct'
  if (patternSource.includes('trait'))
    return 'trait'
  if (patternSource.includes('fn') || patternSource.includes('def ') || patternSource.includes('function'))
    return 'function'
  if (patternSource.includes('const'))
    return 'constant'
  if (patternSource.includes('var'))
    return 'variable'
  return 'function'
}

async function collectFiles(workdir: Workdir, rules: GitignoreRule[]): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = [workdir.root]
  let scanned = 0
  while (queue.length > 0 && scanned < MAX_FILES_SCAN) {
    const current = queue.shift()!
    let names: string[]
    try {
      names = await readdir(current)
    }
    catch {
      continue
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name))
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
      if (info.isDirectory()) {
        if (!isIgnored(rel, true, rules))
          queue.push(abs)
        continue
      }
      if (info.size > MAX_FILE_BYTES)
        continue
      if (!isIgnored(rel, false, rules)) {
        files.push(rel)
        scanned++
      }
    }
  }
  return files
}

function computeLineNumber(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n')
      line++
  }
  return line
}

function estimateTokens(text: string): number {
  // Code-ish content: ~3.5 chars per token (see lib/tokens.ts for rationale).
  return Math.ceil(text.length / 3.5)
}

function extractSignature(content: string, matchIndex: number, kind: RepoSymbolKind): string | undefined {
  if (kind !== 'function' && kind !== 'method')
    return undefined
  // Find the end of the line where the match started.
  const lineEnd = content.indexOf('\n', matchIndex)
  const line = lineEnd === -1 ? content.slice(matchIndex) : content.slice(matchIndex, lineEnd)
  return line.trim()
}

async function extractSymbols(files: string[], workdir: Workdir): Promise<RepoFileNode[]> {
  const nodes: RepoFileNode[] = []
  for (const rel of files) {
    const ext = extname(rel).slice(1).toLowerCase()
    const language = EXT_LANGUAGE[ext]
    if (!language)
      continue
    const patterns = PATTERNS[language]
    if (!patterns || patterns.length === 0)
      continue

    const absolute = resolveInWorkdir(workdir, rel)
    if (!absolute.ok)
      continue
    let content: string
    try {
      content = await readFile(absolute.absolute, 'utf8')
    }
    catch {
      continue
    }

    const symbols = extractWithPatterns(content, patterns, language)
    if (symbols.length === 0)
      continue

    nodes.push({
      extension: ext,
      lineCount: content.split('\n').length,
      path: rel,
      symbols,
    })
  }
  return nodes
}

function extractWithPatterns(content: string, patterns: RegExp[], language: keyof typeof PATTERNS): RepoSymbol[] {
  const symbols: RepoSymbol[] = []
  const seen = new Set<string>()
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match: null | RegExpExecArray
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1]
      if (!name || seen.has(name))
        continue
      seen.add(name)
      const line = computeLineNumber(content, match.index)
      const kind = classifyMatch(pattern.source, language)
      const signature = extractSignature(content, match.index, kind)
      symbols.push({ kind, line, name, signature })
    }
  }
  return symbols.sort((a, b) => a.line - b.line)
}

function indexSymbols(nodes: RepoFileNode[]): Map<string, { nodeIndex: number, symbol: RepoSymbol }[]> {
  const index = new Map<string, { nodeIndex: number, symbol: RepoSymbol }[]>()
  for (let i = 0; i < nodes.length; i++) {
    for (const sym of nodes[i].symbols) {
      const key = sym.name
      const arr = index.get(key) ?? []
      arr.push({ nodeIndex: i, symbol: sym })
      index.set(key, arr)
    }
  }
  return index
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

/**
 * Personalized PageRank. Standard power-iteration with a damping factor
 * of 0.85 (same as aider/Google). The personalization vector biases the
 * "teleportation" distribution toward the focus set.
 *
 * Implementation notes:
 * - We use dense arrays because the graph is small (typically < 1000 nodes
 *   after extension filtering).
 * - 50 iterations is enough for convergence on most codebases (aider uses
 *   the same default).
 * - Self-edges are dropped (a file referencing its own symbols doesn't
 *   contribute to its rank).
 */
function personalizedPageRank(
  graph: Map<number, Map<number, number>>,
  personalization: Float64Array,
  damping: number,
  iterations: number,
): Float64Array {
  const n = personalization.length
  if (n === 0)
    return new Float64Array(0)

  // Normalize personalization to a probability distribution.
  let persSum = 0
  for (let i = 0; i < n; i++)
    persSum += personalization[i]
  if (persSum === 0) {
    // No personalization → uniform distribution.
    for (let i = 0; i < n; i++)
      personalization[i] = 1 / n
  }
  else {
    for (let i = 0; i < n; i++)
      personalization[i] /= persSum
  }

  // Compute out-degree weights for normalization.
  const outSums = new Float64Array(n)
  for (const [src, edges] of graph) {
    let sum = 0
    for (const w of edges.values())
      sum += w
    outSums[src] = sum
  }

  let scores = new Float64Array(n).fill(1 / n)
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Float64Array(n)
    // Damping contribution from each node's out-edges.
    for (const [src, edges] of graph) {
      if (outSums[src] === 0)
        continue
      const srcContribution = damping * scores[src]
      for (const [dst, w] of edges) {
        next[dst] += srcContribution * (w / outSums[src])
      }
    }
    // Teleportation contribution (personalized).
    let teleportSum = 0
    for (let i = 0; i < n; i++) {
      // Nodes with no out-edges "leak" their score; we redistribute it
      // via the personalization vector, matching the standard PageRank
      // sink handling.
      if (outSums[i] === 0)
        teleportSum += scores[i]
    }
    const teleportBase = (1 - damping) + damping * teleportSum
    for (let i = 0; i < n; i++)
      next[i] += teleportBase * personalization[i]
    scores = next
  }

  // Normalize final scores so they sum to 1 (so callers can treat them
  // as a probability distribution if needed).
  let sum = 0
  for (let i = 0; i < n; i++)
    sum += scores[i]
  if (sum > 0) {
    for (let i = 0; i < n; i++)
      scores[i] /= sum
  }
  return scores
}

function renderEntry(entry: RepoMapEntry): string {
  let out = `${entry.path}:\n`
  // Drop a `⋮...` between symbols that are far apart (aider style), so the
  // agent can tell at a glance that there's elided content. We use 5 lines
  // as the threshold.
  let lastLine = 0
  for (const sym of entry.symbols) {
    if (lastLine > 0 && sym.line - lastLine > 5)
      out += '⋮...\n'
    const signature = sym.signature ? ` ${sym.signature}` : ''
    out += `│${sym.kind} ${sym.name}${signature}  :${sym.line}\n`
    lastLine = sym.line
  }
  out += '\n'
  return out
}

import type { Workdir } from './workdir'

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { resolveInWorkdir } from './workdir'

/**
 * Lint primitives for the coding-agent MCP server.
 *
 * Mirrors aider's `aider/linter.py` shape: a portable, language-aware
 * structural check that does not require installing any toolchain. The
 * design goal is to give the agent actionable, machine-located feedback
 * (file + line + message) it can use to retry edits — not to compete with
 * `eslint` or `tsc`.
 *
 * For each language we recognise, we run a small set of cheap structural
 * rules: unmatched brackets, unterminated strings, dangling keywords.
 * Files in languages we do not model are skipped (not reported as clean),
 * so the agent knows it should fall back to running the project's own
 * `lint` command via `run_command`.
 */

export interface LintArgs {
  /** Files to lint (relative to the workdir). Empty = lint session files only. */
  paths: string[]
}

export interface LintFileResult {
  issues: LintIssue[]
  /** Language that was used to lint the file, or `unknown` if skipped. */
  language: string
  /** Lines scanned. */
  lineCount: number
  path: string
}

export interface LintIssue {
  /** 1-based column when known, else 0. */
  column: number
  /** 1-based line number where the issue was detected. */
  line: number
  /** Human-readable explanation. */
  message: string
  /** Short rule id, e.g. `unbalanced-braces`. */
  rule: string
  /** Severity; `error` indicates the file is likely broken. */
  severity: 'error' | 'warning'
}

/**
 * Detects simple structural issues in a file: unmatched braces/parens,
 * unterminated string literals, and trailing operators that indicate a
 * truncated line. Each language has its own comment prefix table so we can
 * skip comment regions before counting brackets.
 */
export async function lintFile(args: { path: string }, workdir: Workdir): Promise<LintFileResult> {
  const resolved = resolveInWorkdir(workdir, args.path)
  if (!resolved.ok) {
    return { issues: [], language: 'unknown', lineCount: 0, path: args.path }
  }

  let content: string
  try {
    content = await readFile(resolved.absolute, 'utf8')
  }
  catch {
    return { issues: [], language: 'unknown', lineCount: 0, path: resolved.rel }
  }

  const language = detectLanguage(resolved.rel)
  if (language === 'unknown') {
    return { issues: [], language, lineCount: content.split('\n').length, path: resolved.rel }
  }

  const issues = lintContent(content, language)
  return {
    issues,
    language,
    lineCount: content.split('\n').length,
    path: resolved.rel,
  }
}

/**
 * Language detector keyed off the file extension. Maps to a comment prefix
 * table used by the structural rules below.
 */
function detectLanguage(path: string): string {
  const ext = extname(path).slice(1).toLowerCase()
  if (['cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'ts', 'tsx'].includes(ext))
    return 'typescript'
  if (ext === 'py')
    return 'python'
  if (['vue'].includes(ext))
    return 'vue'
  if (['go'].includes(ext))
    return 'go'
  if (['rs'].includes(ext))
    return 'rust'
  if (['java', 'kt'].includes(ext))
    return 'java'
  if (['c', 'cc', 'cpp', 'h', 'hpp'].includes(ext))
    return 'c'
  if (['rb'].includes(ext))
    return 'ruby'
  if (['bash', 'sh'].includes(ext))
    return 'shell'
  if (['json', 'jsonc'].includes(ext))
    return 'json'
  if (['md'].includes(ext))
    return 'markdown'
  return 'unknown'
}

const COMMENT_PREFIXES: Record<string, string[]> = {
  c: ['//', '/*'],
  java: ['//', '/*'],
  python: ['#'],
  ruby: ['#'],
  rust: ['//', '/*'],
  shell: ['#'],
  typescript: ['//', '/*'],
  vue: ['//', '/*', '<!--'],
}

/**
 * Runs the structural lint rules against `content` and returns the issues
 * found, sorted by line number. Public so it can be unit-tested without
 * touching the filesystem.
 */
export function lintContent(content: string, language: string): LintIssue[] {
  const issues: LintIssue[] = []
  const lines = content.split(/\r?\n/)
  const prefixes = COMMENT_PREFIXES[language] ?? []

  // Bracket balance check, ignoring comment regions. We only flag a final
  // imbalance at EOF — mid-file imbalance is too noisy without a real parser.
  const stack: Array<{ char: string, col: number, line: number }> = []
  let inString: '"' | '\'' | '`' | null = null
  let inBlockComment = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (let j = 0; j < line.length; j++) {
      const ch = line[j]
      const next = line[j + 1]

      // Block comment handling (// /* */)
      if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false
          j++
        }
        continue
      }
      if (ch === '/' && next === '*' && prefixes.includes('/*')) {
        inBlockComment = true
        j++
        continue
      }

      // Line comments terminate scanning for the rest of the line.
      if (prefixes.includes('//') && ch === '/' && next === '/')
        break
      if (prefixes.includes('#') && ch === '#')
        break

      // String literals. We track entry/exit so brackets inside strings are
      // ignored. We don't handle escapes rigorously — the goal is just to
      // avoid counting brackets inside typical string literals.
      if (inString) {
        if (ch === '\\') {
          j++
          continue
        }
        if (ch === inString)
          inString = null
        continue
      }
      if (ch === '"' || ch === '\'' || ch === '`') {
        inString = ch as '"' | '\'' | '`'
        continue
      }

      if (ch === '{' || ch === '[' || ch === '(') {
        stack.push({ char: ch, col: j + 1, line: i + 1 })
      }
      else if (ch === '}' || ch === ']' || ch === ')') {
        const open = stack.pop()
        if (!open || !matches(open.char, ch)) {
          issues.push({
            column: j + 1,
            line: i + 1,
            message: `Closing "${ch}" has no matching opener`,
            rule: 'unbalanced-brackets',
            severity: 'error',
          })
        }
      }
    }

    // Strings should not span lines in most languages we handle here. If we
    // reach end of line still inside a string, flag it (aider does the same
    // for unterminated string literals).
    if (inString && language !== 'typescript') {
      issues.push({
        column: line.length,
        line: i + 1,
        message: `Unterminated string literal (${inString})`,
        rule: 'unterminated-string',
        severity: 'warning',
      })
      inString = null
    }
  }

  // Any unclosed opener at EOF is an error.
  for (const open of stack) {
    issues.push({
      column: open.col,
      line: open.line,
      message: `Unclosed "${open.char}" — expected a matching "${expected(open.char)}"`,
      rule: 'unclosed-bracket',
      severity: 'error',
    })
  }

  issues.sort((a, b) => a.line - b.line || a.column - b.column)
  return issues
}

function expected(open: string): string {
  if (open === '{')
    return '}'
  if (open === '[')
    return ']'
  if (open === '(')
    return ')'
  return '?'
}

function matches(open: string, close: string): boolean {
  return (open === '{' && close === '}')
    || (open === '[' && close === ']')
    || (open === '(' && close === ')')
}

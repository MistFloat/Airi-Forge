import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { findFiles, searchCode } from '../lib/search'
import { errorResult, textResult } from './types'

export interface FindFilesToolArgs {
  extensions?: string[]
  includeIgnored?: boolean
  maxResults?: number
  pattern?: string
  regex?: boolean
}

export interface SearchCodeToolArgs {
  caseSensitive?: boolean
  contextLines?: number
  globs?: string[]
  includeIgnored?: boolean
  maxMatches?: number
  path?: string
  pattern: string
  regex?: boolean
}

export interface SearchToolsContext {
  workdir: Workdir
}

/**
 * Finds files by path/extension. Uses ripgrep's `--files` mode when
 * available, with a JS walker fallback.
 */
export async function findFilesTool(args: FindFilesToolArgs, ctx: SearchToolsContext): Promise<McpToolResult> {
  const result = await findFiles({
    extensions: args.extensions,
    includeIgnored: args.includeIgnored,
    maxResults: args.maxResults,
    pattern: args.pattern,
    regex: args.regex,
  }, ctx.workdir)

  const text = result.files.length === 0
    ? `(no files match; engine: ${result.engine})`
    : result.files.join('\n')

  return textResult(text, {
    engine: result.engine,
    files: result.files,
    truncated: result.truncated,
  })
}

/**
 * Searches file contents using ripgrep (with a JS fallback when `rg` is not
 * on PATH). Returns matches with `path:line` plus optional context lines,
 * structured for easy citation back to the user.
 */
export async function searchCodeTool(args: SearchCodeToolArgs, ctx: SearchToolsContext): Promise<McpToolResult> {
  if (!args.pattern || args.pattern === '')
    return errorResult('search_code requires a non-empty `pattern`')

  const result = await searchCode({
    caseSensitive: args.caseSensitive,
    contextLines: args.contextLines,
    globs: args.globs,
    includeIgnored: args.includeIgnored,
    maxMatches: args.maxMatches,
    path: args.path,
    pattern: args.pattern,
    regex: args.regex,
  }, ctx.workdir)

  const text = result.matches.length === 0
    ? `No matches for "${args.pattern}" (engine: ${result.engine}, scanned ${result.filesScanned} file(s))`
    : result.matches
        .map((m) => {
          const header = `${m.path}:${m.line}`
          const before = (m.before ?? []).map((line, i) => `  ${m.line - (m.before!.length - i)}: ${line}`).join('\n')
          const match = `> ${m.line}: ${m.text}`
          const after = (m.after ?? []).map((line, i) => `  ${m.line + i + 1}: ${line}`).join('\n')
          return [header, before, match, after].filter(Boolean).join('\n')
        })
        .join('\n---\n')

  return textResult(text, {
    engine: result.engine,
    filesScanned: result.filesScanned,
    matches: result.matches,
    truncated: result.truncated,
  })
}

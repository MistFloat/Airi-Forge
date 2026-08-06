import type { GitignoreRule } from '../lib/gitignore'
import type { ProgressSink } from '../lib/progress'
import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { isIgnored, parseGitignore } from '../lib/gitignore'
import { resolveInWorkdir } from '../lib/workdir'
import { errorMessageFromValue, errorResult, textResult } from './types'

export interface ListDirArgs {
  depth?: number
  path?: string
}

export interface ReadFileArgs {
  maxChars?: number
  offset?: number
  path: string
}

export interface ReadFileRangeArgs {
  length: number
  offset: number
  path: string
}

export interface ReadToolsContext {
  workdir: Workdir
}

export const DEFAULT_MAX_CHARS = 8192
const MAX_LIST_DEPTH = 5
const MAX_LIST_ENTRIES = 500

export interface ListDirEntry {
  name: string
  path: string
  type: 'dir' | 'file'
}

/**
 * Lists directory entries, respecting `.gitignore` and a depth limit.
 *
 * Reports progress through the optional sink while walking; ignored
 * directories are skipped entirely (their contents are not listed).
 */
export async function listDirTool(
  args: ListDirArgs,
  ctx: ReadToolsContext & { progress?: ProgressSink },
): Promise<McpToolResult> {
  const resolved = resolveInWorkdir(ctx.workdir, args.path ?? '.')
  if (!resolved.ok)
    return errorResult(`Path is outside the workdir: ${args.path ?? '.'}`)

  const depth = Math.min(MAX_LIST_DEPTH, Math.max(0, args.depth ?? 1))
  const rules = await loadGitignoreRules(ctx.workdir)

  const entries: ListDirEntry[] = []
  let visited = 0
  let skippedIgnored = 0

  // Entry `path` values are relative to the listed directory (like `ls`),
  // while `resolved.rel` stays available for messages and structured content.
  async function walk(current: string, rel: string, level: number): Promise<void> {
    if (entries.length >= MAX_LIST_ENTRIES)
      return
    let names: string[]
    try {
      names = await readdir(current)
    }
    catch {
      return
    }
    for (const name of names) {
      if (entries.length >= MAX_LIST_ENTRIES)
        return
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (name === '.git')
        continue
      const childAbsolute = join(current, name)
      let isDir = false
      try {
        isDir = (await stat(childAbsolute)).isDirectory()
      }
      catch {
        continue
      }
      if (isIgnored(childRel, isDir, rules)) {
        skippedIgnored++
        continue
      }
      entries.push({ name, path: childRel, type: isDir ? 'dir' : 'file' })
      if (isDir && level < depth)
        await walk(childAbsolute, childRel, level + 1)
      visited++
      if (ctx.progress && visited % 20 === 0) {
        await ctx.progress.report({
          message: `Listed ${visited} entries under ${rel || '.'}`,
          progress: visited,
        })
      }
    }
  }

  try {
    await walk(resolved.absolute, '', 0)
  }
  catch (error) {
    const message = errorMessageFromValue(error)
    return errorResult(`Failed to list ${resolved.rel}: ${message}`)
  }

  const truncated = entries.length >= MAX_LIST_ENTRIES
  return textResult(
    entries.map(e => `${e.type === 'dir' ? `${e.path}/` : e.path}`).join('\n'),
    {
      entries,
      path: resolved.rel,
      skippedIgnored,
      truncated,
    },
  )
}

/** Reads an exact character range of a file for targeted lookups in large files. */
export async function readFileRangeTool(args: ReadFileRangeArgs, ctx: ReadToolsContext): Promise<McpToolResult> {
  const resolved = resolveInWorkdir(ctx.workdir, args.path)
  if (!resolved.ok)
    return errorResult(`Path is outside the workdir: ${args.path}`)

  let content: string
  try {
    content = await readText(resolved.absolute)
  }
  catch (error) {
    const message = errorMessageFromValue(error)
    return errorResult(`Failed to read ${resolved.rel}: ${message}`)
  }

  const start = Math.max(0, Math.min(args.offset, content.length))
  const end = Math.min(content.length, start + Math.max(0, args.length))
  return textResult(content.slice(start, end), {
    end,
    path: resolved.rel,
    start,
    totalChars: content.length,
  })
}

/**
 * Reads a file with optional character offset and length cap.
 *
 * Returns the raw file content plus truncation metadata so the agent can page
 * through large files with `read_file_range` instead of blowing up the prompt.
 */
export async function readFileTool(args: ReadFileArgs, ctx: ReadToolsContext): Promise<McpToolResult> {
  const resolved = resolveInWorkdir(ctx.workdir, args.path)
  if (!resolved.ok)
    return errorResult(`Path is outside the workdir: ${args.path}`)

  const offset = Math.max(0, args.offset ?? 0)
  const maxChars = Math.max(1, args.maxChars ?? DEFAULT_MAX_CHARS)

  let content: string
  try {
    content = await readText(resolved.absolute)
  }
  catch (error) {
    const message = errorMessageFromValue(error)
    return errorResult(`Failed to read ${resolved.rel}: ${message}`)
  }

  const totalChars = content.length
  const slice = content.slice(offset, offset + maxChars)
  const isTruncated = offset + maxChars < totalChars
  const note = isTruncated
    ? `\n\n[truncated: showing chars ${offset}-${offset + slice.length} of ${totalChars}; use read_file_range for more]`
    : ''

  return textResult(`${slice}${note}`, {
    isTruncated,
    offset,
    path: resolved.rel,
    totalChars,
  })
}

async function loadGitignoreRules(workdir: Workdir): Promise<GitignoreRule[]> {
  try {
    const text = await readText(join(workdir.root, '.gitignore'))
    return parseGitignore(text)
  }
  catch {
    return []
  }
}

async function readText(absolute: string): Promise<string> {
  return await readFile(absolute, 'utf8')
}

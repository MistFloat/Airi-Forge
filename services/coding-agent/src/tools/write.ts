import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'

import { replaceExact } from '../lib/edit'
import { resolveInWorkdir } from '../lib/workdir'
import { errorMessageFromValue, errorResult, textResult } from './types'

export interface ApplyDiffArgs {
  blocks: EditBlock[]
}

export interface DeleteFileArgs {
  path: string
  /** Delete non-empty directories recursively. Ignored for regular files. */
  recursive?: boolean
}

export interface EditBlock {
  path: string
  replace: string
  search: string
}

export interface MoveFileArgs {
  /** Source path (relative to the workdir). */
  from: string
  /** Destination path (relative to the workdir). */
  to: string
  /**
   * When true, uses `git mv` (preserves history, requires both paths tracked
   * or the source untracked with the destination's parent directory existing).
   * Default false — uses a plain `rename`, which preserves content but not
   * git history.
   */
  useGitMv?: boolean
}

export interface WriteFileArgs {
  content: string
  path: string
}

export interface WriteToolsContext {
  workdir: Workdir
}

const execFileAsync = promisify(execFile)

interface ApplyFailure {
  matches?: number
  path: string
  reason: 'file-missing' | 'multiple-match' | 'no-match'
  suggestion?: string
}

interface ApplySuccess { path: string, status: 'appended' | 'created' | 'replaced' }

/**
 * Applies SEARCH/REPLACE edit blocks atomically.
 *
 * Every block is validated (and folded into an in-memory working copy) before
 * any file is written. If any block fails — file missing, no exact match, or
 * ambiguous multiple matches — nothing is written and all failures are
 * reported with a "did you mean" suggestion where available, so the agent can
 * fix and retry without leaving the repo half-edited.
 */
export async function applyDiffTool(args: ApplyDiffArgs, ctx: WriteToolsContext): Promise<McpToolResult> {
  const working: Map<string, string> = new Map()
  const applied: ApplySuccess[] = []
  const failed: ApplyFailure[] = []

  for (const block of args.blocks) {
    const resolved = resolveInWorkdir(ctx.workdir, block.path)
    if (!resolved.ok) {
      failed.push({ path: block.path, reason: 'file-missing' })
      continue
    }

    const exists = await fileExists(resolved.absolute)
    if (!exists) {
      if (block.search.trim() === '') {
        working.set(resolved.absolute, block.replace)
        applied.push({ path: resolved.rel, status: 'created' })
        continue
      }
      failed.push({ path: resolved.rel, reason: 'file-missing' })
      continue
    }

    const current = working.get(resolved.absolute) ?? await readText(resolved.absolute)

    if (block.search.trim() === '') {
      // Append to an existing file, preserving the trailing newline.
      const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : ''
      working.set(resolved.absolute, `${current}${separator}${block.replace}`)
      applied.push({ path: resolved.rel, status: 'appended' })
      continue
    }

    const result = replaceExact(current, block.search, block.replace)
    if (result.ok) {
      working.set(resolved.absolute, result.content)
      applied.push({ path: resolved.rel, status: 'replaced' })
      continue
    }
    failed.push({
      matches: result.matches,
      path: resolved.rel,
      reason: result.reason,
      suggestion: result.suggestion,
    })
  }

  if (failed.length > 0) {
    const detail = failed
      .map((f) => {
        const base = `${f.path}: ${f.reason === 'multiple-match' ? `matched ${f.matches} regions, add more context` : f.reason === 'file-missing' ? 'file does not exist (or path escapes the workdir)' : 'no exact match'}`
        return f.suggestion ? `${base}\nDid you mean these lines?\n${f.suggestion}` : base
      })
      .join('\n\n')
    return errorResult(`# ${failed.length} SEARCH/REPLACE block(s) failed, no files were written\n\n${detail}`, { applied, failed })
  }

  for (const [absolute, content] of working) {
    try {
      await writeText(absolute, content)
    }
    catch (error) {
      return errorResult(`Failed to write ${absolute}: ${errorMessageFromValue(error)}`, { applied, failed })
    }
  }

  return textResult(
    applied.map(a => `${a.path} (${a.status})`).join('\n'),
    { applied },
  )
}

/**
 * Deletes a file or directory inside the workdir. Non-empty directories require
 * `recursive`; the workdir root itself can never be deleted.
 */
export async function deleteFileTool(args: DeleteFileArgs, ctx: WriteToolsContext): Promise<McpToolResult> {
  const resolved = resolveInWorkdir(ctx.workdir, args.path)
  if (!resolved.ok)
    return errorResult(`Path is outside the workdir: ${args.path}`)
  // Resolving `.` or an empty path yields the root itself; deleting it would
  // destroy the repository the agent is confined to.
  if (resolved.rel === '')
    return errorResult('Refusing to delete the workdir root')

  let info
  try {
    info = await stat(resolved.absolute)
  }
  catch {
    return errorResult(`Not found: ${resolved.rel}`)
  }

  try {
    if (info.isDirectory()) {
      if (args.recursive)
        await rm(resolved.absolute, { recursive: true })
      else
        await rmdir(resolved.absolute)
    }
    else {
      await unlink(resolved.absolute)
    }
  }
  catch (error) {
    return errorResult(`Failed to delete ${resolved.rel}: ${errorMessageFromValue(error)}`)
  }

  return textResult(`deleted ${resolved.rel}`, { path: resolved.rel, status: 'deleted' })
}

/**
 * Moves or renames a file inside the workdir. By default uses a plain
 * `rename` (preserves content but breaks git history); set `useGitMv: true`
 * to use `git mv` instead (preserves history, requires the workdir to be a
 * git repo and the source to be tracked).
 *
 * The destination's parent directory is created if missing (matching
 * `write_file`'s behavior), so the agent can move files into new
 * subdirectories in one call.
 */
export async function moveFileTool(args: MoveFileArgs, ctx: WriteToolsContext): Promise<McpToolResult> {
  const from = resolveInWorkdir(ctx.workdir, args.from)
  if (!from.ok)
    return errorResult(`Source path is outside the workdir: ${args.from}`)
  const to = resolveInWorkdir(ctx.workdir, args.to)
  if (!to.ok)
    return errorResult(`Destination path is outside the workdir: ${args.to}`)

  // Refuse to overwrite an existing destination — the agent should explicitly
  // delete it first if that's the intent. This avoids silently destroying
  // unrelated work that happened to live at the target path.
  let destExists = false
  try {
    await stat(to.absolute)
    destExists = true
  }
  catch {
    destExists = false
  }
  if (destExists)
    return errorResult(`Destination already exists: ${to.rel} (delete it first if overwrite is intended)`)

  if (args.useGitMv) {
    try {
      await execFileAsync('git', ['mv', from.rel, to.rel], {
        cwd: ctx.workdir.root,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      })
    }
    catch (error) {
      return errorResult(`git mv failed: ${errorMessageFromValue(error)}`)
    }
  }
  else {
    try {
      await mkdir(dirname(to.absolute), { recursive: true })
      await rename(from.absolute, to.absolute)
    }
    catch (error) {
      return errorResult(`move failed: ${errorMessageFromValue(error)}`)
    }
  }

  return textResult(`moved ${from.rel} → ${to.rel}${args.useGitMv ? ' (git mv)' : ''}`, {
    from: from.rel,
    to: to.rel,
    useGitMv: args.useGitMv ?? false,
  })
}

/** Creates or overwrites a file wholesale, creating missing parent directories. */
export async function writeFileTool(args: WriteFileArgs, ctx: WriteToolsContext): Promise<McpToolResult> {
  const resolved = resolveInWorkdir(ctx.workdir, args.path)
  if (!resolved.ok)
    return errorResult(`Path is outside the workdir: ${args.path}`)

  try {
    await writeText(resolved.absolute, args.content)
  }
  catch (error) {
    return errorResult(`Failed to write ${resolved.rel}: ${errorMessageFromValue(error)}`)
  }

  return textResult(`wrote ${resolved.rel}`, { path: resolved.rel, status: 'written' })
}

async function fileExists(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isFile()
  }
  catch {
    return false
  }
}

async function readText(absolute: string): Promise<string> {
  return await readFile(absolute, 'utf8')
}

async function writeText(absolute: string, content: string): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

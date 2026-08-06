import type { Workdir } from './workdir'

import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveInWorkdir } from './workdir'

/**
 * Conventions file reader for the coding-agent MCP server.
 *
 * Mirrors aider's `--conventions-file` feature: a small, stable set of
 * well-known files at the workdir root that capture project-specific
 * conventions, coding style, and agent instructions. The agent uses this
 * tool once at the start of a session to load the relevant context, then
 * re-reads individual files as needed.
 *
 * We deliberately do NOT cache the contents: conventions files change
 * out-of-band (the user edits AGENTS.md in their editor), and a stale
 * cached version would silently mislead the agent. Each call re-reads.
 */

/** Well-known conventions files, in priority order (first hit wins). */
export const CONVENTIONS_FILES = [
  'AGENTS.md',
  '.cursorrules',
  '.cursorrules.md',
  'CONVENTIONS.md',
  'CLAUDE.md',
  'COPILOT.md',
  'CODEX.md',
  '.aider.conf.yml',
  '.aider.conf.yaml',
  '.editorconfig',
] as const

export interface ReadConventionsResult {
  /** File contents (raw). */
  content: string
  /** Path of the file that was read, relative to the workdir. */
  path: string
  /** Size in bytes. */
  size: number
}

/**
 * Reads multiple conventions files at once, returning only the ones that
 * exist. Used by the `read_conventions` MCP tool to surface all available
 * convention sources in one call.
 */
export async function readAllConventions(workdir: Workdir): Promise<ReadConventionsResult[]> {
  const results: ReadConventionsResult[] = []
  for (const name of CONVENTIONS_FILES) {
    try {
      const result = await readConventionsFile(name, workdir)
      results.push(result)
    }
    catch {
      continue
    }
  }
  return results
}

/**
 * Reads a single conventions file by name, returning its raw contents.
 * Throws when the file is missing or outside the workdir; the caller is
 * expected to handle the missing case (typically by trying the next
 * well-known name).
 */
export async function readConventionsFile(name: string, workdir: Workdir): Promise<ReadConventionsResult> {
  const resolved = resolveInWorkdir(workdir, name)
  if (!resolved.ok)
    throw new Error(`Path is outside the workdir: ${name}`)
  const content = await readFile(resolved.absolute, 'utf8')
  return {
    content,
    path: resolved.rel,
    size: Buffer.byteLength(content, 'utf8'),
  }
}

/**
 * Reads the first available conventions file from the well-known list, in
 * priority order. Returns `null` when none exist — the caller should treat
 * this as "no conventions declared" rather than an error.
 */
export async function readDefaultConventions(workdir: Workdir): Promise<null | ReadConventionsResult> {
  for (const name of CONVENTIONS_FILES) {
    try {
      return await readConventionsFile(name, workdir)
    }
    catch {
      // File missing or unreadable — try the next one.
      continue
    }
  }
  return null
}

/** Reads a `package.json`-derived test/lint script hint if present. */
export async function readPackageJsonScripts(workdir: Workdir): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(workdir.root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
    return parsed.scripts ?? {}
  }
  catch {
    return {}
  }
}

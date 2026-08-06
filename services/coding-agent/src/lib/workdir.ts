import process from 'node:process'

import { isAbsolute, relative, resolve } from 'node:path'

export interface ResolvePathFailure {
  ok: false
  reason: 'outside-workdir'
  /** The user-supplied path that was rejected. */
  requested: string
}

export type ResolvePathResult = ResolvePathFailure | ResolvePathSuccess

export interface ResolvePathSuccess {
  /** Absolute path inside the workdir. */
  absolute: string
  ok: true
  /** Path relative to the workdir root, using `/` separators. */
  rel: string
}

/**
 * Workdir-scoped path resolution for the coding-agent MCP server.
 *
 * All file tools resolve user-supplied paths against a single workdir root and
 * reject any path that escapes it. This is the boundary that keeps the agent
 * confined to the repository it is asked to work on.
 */
export interface Workdir {
  root: string
}

export function createWorkdir(root: string): Workdir {
  return { root: resolve(root) }
}

/**
 * Resolves `input` inside the workdir.
 *
 * Relative paths resolve against the root; absolute paths are allowed only when
 * they stay inside the root. Paths that escape (via `..`, a different drive,
 * or an absolute path outside the root) are rejected.
 *
 * Symbolic links are not resolved, so a link pointing outside the workdir is
 * not detected here; tool callers that follow links must re-validate.
 */
export function resolveInWorkdir(workdir: Workdir, input: string): ResolvePathResult {
  const absolute = resolve(workdir.root, input)
  const rel = relative(workdir.root, absolute)
  const escaped = rel.startsWith('..') || isAbsolute(rel)

  const isWindows = process.platform === 'win32'
  const rootForCompare = isWindows ? workdir.root.toLowerCase() : workdir.root
  const absoluteForCompare = isWindows ? absolute.toLowerCase() : absolute
  const rootBase = rootForCompare.endsWith('\\') || rootForCompare.endsWith('/')
    ? rootForCompare
    : `${rootForCompare}${isWindows ? '\\' : '/'}`

  const inside = !escaped
    && (absoluteForCompare === rootForCompare || absoluteForCompare.startsWith(rootBase))

  if (!inside)
    return { ok: false, reason: 'outside-workdir', requested: input }

  return {
    absolute,
    ok: true,
    rel: rel.replaceAll('\\', '/'),
  }
}

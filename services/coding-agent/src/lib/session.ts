import type { Workdir } from './workdir'

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { resolveInWorkdir } from './workdir'

/**
 * Per-server session state for the coding-agent MCP server.
 *
 * The MCP protocol is stateful from the server's perspective: the client
 * holds a long-lived `Client` connection and dispatches tool calls over it.
 * That lets us keep an in-memory view of "the files the agent is currently
 * working on" — the editable set, plus read-only references — and use it to
 * scope operations like lint, repo map, and token accounting without the
 * agent having to redeclare the file list on every call.
 *
 * This mirrors aider's `/add` / `/drop` / `/files` workflow. We do not
 * persist the session to disk: if the server process restarts, the agent
 * rebuilds the session by re-issuing `add_file` calls, which is cheap.
 *
 * State ownership:
 * - `editablePaths` and `readOnlyPaths` are runtime session state (this process).
 * - File contents are NOT cached; we always re-read from disk to avoid
 *   drifting from real edits applied out-of-band (e.g. by the user's editor).
 */

export interface AddFileArgs {
  /**
   * When true and the file does not exist, it is created as an empty file
   * (mirrors aider's behavior of pre-creating `/add newfile.py` placeholders
   * so the LLM can subsequently write to it).
   */
  createIfMissing?: boolean
  /** Workdir-relative path to add. */
  path: string
  /** When true, the file is added as read-only (cannot be edited via apply_diff). */
  readOnly?: boolean
}

export interface DropFileArgs {
  path: string
}

export interface ListFilesResult {
  files: SessionFileEntry[]
}

export interface SessionContext {
  workdir: Workdir
}

export interface SessionFileEntry {
  /** True when the file is editable; false when read-only. */
  editable: boolean
  /** True when the file exists on disk at the time of the last add. */
  exists: boolean
  /** Workdir-relative path, `/`-separated. */
  path: string
  /** Size in bytes when last stat'd. */
  size: number
}

export interface SessionSnapshot {
  editable: SessionFileEntry[]
  readOnly: SessionFileEntry[]
}

/**
 * In-memory session store. A single instance per MCP server process; the
 * agent's calls share it across the lifetime of the stdio connection.
 */
export class FileSession {
  private editable = new Map<string, SessionFileEntry>()
  private readOnly = new Map<string, SessionFileEntry>()

  constructor(private readonly workdir: Workdir) {}

  /**
   * Adds a file to the session. If the file was previously added with a
   * different `editable` flag, the latest flag wins (matching aider's
   * `/add` semantics).
   */
  async add(args: AddFileArgs): Promise<SessionFileEntry> {
    const resolved = resolveInWorkdir(this.workdir, args.path)
    if (!resolved.ok)
      throw new Error(`Path is outside the workdir: ${args.path}`)

    const entry = await this.statEntry(resolved.rel, resolved.absolute)
    if (!entry.exists && args.createIfMissing && !args.readOnly) {
      // Pre-create the file as empty so subsequent apply_diff calls succeed.
      // We do not create read-only placeholders — the agent should declare
      // intent explicitly by adding an editable file.
      await mkdir(dirname(resolved.absolute), { recursive: true })
      await writeFile(resolved.absolute, '', 'utf8')
      const info = await stat(resolved.absolute)
      entry.exists = true
      entry.size = info.size
    }

    const finalEntry: SessionFileEntry = {
      ...entry,
      editable: !args.readOnly,
      path: resolved.rel,
    }

    if (finalEntry.editable) {
      this.editable.set(resolved.rel, finalEntry)
      this.readOnly.delete(resolved.rel)
    }
    else {
      this.readOnly.set(resolved.rel, finalEntry)
      this.editable.delete(resolved.rel)
    }

    return finalEntry
  }

  /** Clears the entire session. */
  clear(): void {
    this.editable.clear()
    this.readOnly.clear()
  }

  /** Removes a file from the session (either editable or read-only). */
  drop(args: DropFileArgs): boolean {
    const resolved = resolveInWorkdir(this.workdir, args.path)
    if (!resolved.ok)
      return false
    const fromEditable = this.editable.delete(resolved.rel)
    const fromReadOnly = this.readOnly.delete(resolved.rel)
    return fromEditable || fromReadOnly
  }

  /** Returns the editable paths (used by lint / repomap tools). */
  editablePaths(): string[] {
    return [...this.editable.keys()]
  }

  /** Returns true when `path` is in the editable session. */
  isEditable(path: string): boolean {
    return this.editable.has(path)
  }

  /** Lists all session files, editable first then read-only. */
  list(): SessionSnapshot {
    return {
      editable: [...this.editable.values()],
      readOnly: [...this.readOnly.values()],
    }
  }

  /**
   * Re-stats every session file to refresh `exists`/`size`. Use this when
   * the agent has run external commands (e.g. via `run_command`) that may
   * have changed the working tree out-of-band.
   */
  async refresh(): Promise<void> {
    await Promise.all([
      this.refreshMap(this.editable),
      this.refreshMap(this.readOnly),
    ])
  }

  private async refreshMap(map: Map<string, SessionFileEntry>): Promise<void> {
    for (const [rel, entry] of map) {
      const resolved = resolveInWorkdir(this.workdir, rel)
      if (!resolved.ok) {
        entry.exists = false
        entry.size = 0
        continue
      }
      const refreshed = await this.statEntry(rel, resolved.absolute)
      entry.exists = refreshed.exists
      entry.size = refreshed.size
    }
  }

  private async statEntry(rel: string, abs: string): Promise<SessionFileEntry> {
    try {
      const info = await stat(abs)
      return {
        editable: true,
        exists: true,
        path: rel,
        size: info.size,
      }
    }
    catch {
      return {
        editable: true,
        exists: false,
        path: rel,
        size: 0,
      }
    }
  }
}

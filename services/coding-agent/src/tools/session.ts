import type { FileSession } from '../lib/session'
import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { errorMessageFromValue, errorResult, textResult } from './types'

export interface AddFileArgs {
  createIfMissing?: boolean
  path: string
  readOnly?: boolean
}

export interface DropFileArgs {
  path: string
}

export interface SessionToolsContext {
  session: FileSession
  workdir: Workdir
}

/**
 * Adds a file to the session. Files in the editable session can be edited
 * via `apply_diff`; files in the read-only session are reference-only.
 *
 * When `createIfMissing: true` and the file does not exist, it is pre-created
 * as an empty file (mirrors aider's `/add newfile.py` placeholder pattern so
 * subsequent `apply_diff` calls with an empty `search` block succeed).
 */
export async function addFileTool(args: AddFileArgs, ctx: SessionToolsContext): Promise<McpToolResult> {
  try {
    const entry = await ctx.session.add({
      createIfMissing: args.createIfMissing,
      path: args.path,
      readOnly: args.readOnly,
    })
    return textResult(
      `added ${entry.path} (${entry.editable ? 'editable' : 'read-only'}, ${entry.exists ? `${entry.size} bytes` : 'missing'})`,
      { entry },
    )
  }
  catch (error) {
    return errorResult(`add_file failed: ${errorMessageFromValue(error)}`)
  }
}

/** Clears the entire session. */
export async function clearSessionTool(_args: unknown, ctx: SessionToolsContext): Promise<McpToolResult> {
  ctx.session.clear()
  return textResult('session cleared')
}

/** Removes a file from the session (either editable or read-only). */
export async function dropFileTool(args: DropFileArgs, ctx: SessionToolsContext): Promise<McpToolResult> {
  const removed = ctx.session.drop({ path: args.path })
  if (!removed)
    return errorResult(`drop_file: ${args.path} was not in the session`)
  return textResult(`dropped ${args.path}`, { path: args.path })
}

/**
 * Lists all files in the session, editable first then read-only. Use this
 * to recall what the agent is currently working on without re-reading each
 * file's contents.
 */
export async function listFilesTool(_args: unknown, ctx: SessionToolsContext): Promise<McpToolResult> {
  const snapshot = ctx.session.list()
  return textResult(
    [
      `editable (${snapshot.editable.length}):`,
      ...snapshot.editable.map(e => `  ${e.path} (${e.exists ? `${e.size} bytes` : 'missing'})`),
      `read-only (${snapshot.readOnly.length}):`,
      ...snapshot.readOnly.map(e => `  ${e.path} (${e.exists ? `${e.size} bytes` : 'missing'})`),
    ].join('\n'),
    { files: [...snapshot.editable, ...snapshot.readOnly] },
  )
}

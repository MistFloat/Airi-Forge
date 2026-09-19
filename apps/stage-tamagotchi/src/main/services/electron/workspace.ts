import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow, OpenDialogOptions } from 'electron'

import type { ElectronWorkspaceState } from '../../../shared/eventa'

import process from 'node:process'

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app, dialog } from 'electron'

import { electronWorkspaceChanged, electronWorkspaceGet, electronWorkspacePick, electronWorkspaceSet } from '../../../shared/eventa'
import { findMonorepoRoot } from './app'

/** Persisted workspace selection. */
export interface WorkspaceState {
  /** Absolute directory the agent may operate in; absent until one is chosen. */
  root?: string
}

const WORKSPACE_FILE_NAME = 'workspace.json'

export interface WorkspaceServiceOptions {
  context: ReturnType<typeof createContext>['context']
  window?: BrowserWindow
}

/**
 * Registers the workspace IPC surface for one renderer window.
 *
 * The chosen root is owned by the main process: the renderer can read it, ask
 * for a native folder picker, or set it explicitly, and every window receives
 * the resulting state through {@link electronWorkspaceChanged}.
 */
export function createWorkspaceService({ context, window }: WorkspaceServiceOptions) {
  let state: WorkspaceState = readWorkspaceState()
  const mcpServiceDirectory = resolveMcpServiceDirectory()

  function snapshot(): ElectronWorkspaceState {
    return {
      ...(mcpServiceDirectory ? { mcpServiceDirectory } : {}),
      ...(state.root ? { root: state.root } : {}),
    }
  }

  function publish(next: WorkspaceState) {
    state = next
    const published = snapshot()
    context.emit(electronWorkspaceChanged, published)
    return published
  }

  async function setRoot(candidate: unknown): Promise<ElectronWorkspaceState> {
    const root = normalizeWorkspaceRoot(candidate)
    if (!root)
      throw new Error('Workspace root must be an existing directory.')

    const next = { root }
    await persistWorkspaceState(next)
    return publish(next)
  }

  defineInvokeHandler(context, electronWorkspaceGet, () => snapshot())

  defineInvokeHandler(context, electronWorkspaceSet, async ({ root }) => {
    if (root === null || root === undefined)
      return publish({})

    return await setRoot(root)
  })

  defineInvokeHandler(context, electronWorkspacePick, async () => {
    const options: OpenDialogOptions = {
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose the agent workspace',
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    const picked = result.canceled ? undefined : result.filePaths[0]
    if (!picked)
      return snapshot()

    return await setRoot(picked)
  })

  return {
    /** Current selection, for main-process diagnostics. */
    getState: () => snapshot(),
  }
}

/**
 * Reads the persisted workspace selection.
 *
 * A missing or unreadable file means "no workspace yet", so a corrupt file
 * degrades to the unconfigured state instead of blocking every window.
 */
export function readWorkspaceState(path = workspaceFilePath()): WorkspaceState {
  if (!existsSync(path))
    return {}

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed !== null && typeof parsed === 'object' && typeof (parsed as WorkspaceState).root === 'string')
      return { root: (parsed as WorkspaceState).root }
  }
  catch (error) {
    console.warn('[Workspace] Failed to read the persisted workspace:', error)
  }

  return {}
}

/**
 * Accepts only directories that exist.
 *
 * The workspace is the boundary every filesystem tool validates against, so a
 * stale or hand-edited path must be rejected at the door rather than failing
 * later inside a tool call.
 */
function normalizeWorkspaceRoot(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string')
    return undefined

  const trimmed = candidate.trim()
  if (trimmed.length === 0 || !existsSync(trimmed))
    return undefined

  try {
    return statSync(trimmed).isDirectory() ? trimmed : undefined
  }
  catch {
    return undefined
  }
}

async function persistWorkspaceState(state: WorkspaceState, path = workspaceFilePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
}

/**
 * Absolute path of the coding-agent service in this checkout.
 *
 * The renderer needs it to launch that MCP server from the service directory
 * while its workdir points at the workspace. Development checkouts only: a
 * packaged build resolves no monorepo root and reports nothing.
 */
function resolveMcpServiceDirectory(): string | undefined {
  const root = findMonorepoRoot(process.cwd())
  const serviceDirectory = join(root, 'services', 'coding-agent')
  return existsSync(serviceDirectory) ? serviceDirectory : undefined
}

function workspaceFilePath(): string {
  return join(app.getPath('userData'), WORKSPACE_FILE_NAME)
}

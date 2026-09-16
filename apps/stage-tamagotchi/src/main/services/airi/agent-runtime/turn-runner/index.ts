import type { Event, WebContents } from 'electron'
import type { Lifecycle } from 'injeca'

import type { ElectronAgentSessionEventService } from '../session-events'
import type { AgentTurnRunner } from './service'

import { createContext } from '@moeru/eventa/adapters/electron/main'
import { app, ipcMain, webContents } from 'electron'

import { registerAgentTurnHandlers } from './ipc'
import { createAgentTurnRunner } from './service'

/** Main-process turn runner with explicit Electron lifecycle cleanup. */
export interface ElectronAgentTurnRunnerService {
  /** Interrupts active ownership, flushes state, and removes IPC/listeners. */
  dispose: () => Promise<void>
  /** Authoritative state machine exposed for main-process diagnostics. */
  runner: AgentTurnRunner
}

/**
 * Starts the durable Agent turn control plane in Electron main.
 *
 * Call stack:
 *
 * setupAgentTurnRunnerService
 *   -> {@link createAgentTurnRunner}
 *   -> {@link registerAgentTurnHandlers}
 *   -> renderer WebContents lifecycle repair
 */
export async function setupAgentTurnRunnerService(
  lifecycle: Lifecycle,
  sessionEvents: ElectronAgentSessionEventService,
): Promise<ElectronAgentTurnRunnerService> {
  // Session startup reconciliation runs before renderer handlers are exposed.
  // This makes orphaned tool uncertainty durable even when no active turn
  // exists for the turn runner to repair and flush on its own.
  await sessionEvents.service.flush()
  const runner = await createAgentTurnRunner({ eventStore: sessionEvents.service })
  const { context, dispose: disposeContext } = createContext(ipcMain)
  const disposeHandlers = registerAgentTurnHandlers(
    context,
    runner,
    options => String(options?.raw.ipcMainEvent.sender.id ?? ''),
  )
  const rendererCleanups = new Map<number, () => void>()
  let disposed = false

  const attachRenderer = (contents: WebContents) => {
    if (disposed || rendererCleanups.has(contents.id))
      return

    const ownerId = String(contents.id)
    const interrupt = () => {
      void runner.interruptOwner(ownerId, 'renderer-detached').catch((error) => {
        console.error(`Failed to repair Agent turns for renderer ${ownerId}`, error)
      })
    }
    const detach = () => {
      interrupt()
      contents.off('did-start-loading', interrupt)
      contents.off('render-process-gone', interrupt)
      rendererCleanups.delete(contents.id)
    }
    const cleanup = () => {
      contents.off('did-start-loading', interrupt)
      contents.off('destroyed', detach)
      contents.off('render-process-gone', interrupt)
      rendererCleanups.delete(contents.id)
    }

    contents.on('did-start-loading', interrupt)
    contents.once('destroyed', detach)
    contents.on('render-process-gone', interrupt)
    rendererCleanups.set(contents.id, cleanup)
  }

  const onWebContentsCreated = (_event: Event, contents: WebContents) => attachRenderer(contents)
  for (const contents of webContents.getAllWebContents())
    attachRenderer(contents)
  app.on('web-contents-created', onWebContentsCreated)

  const dispose = async () => {
    if (disposed)
      return
    disposed = true

    // Injeca awaits this hook before Electron exits, making terminal repair a
    // real durability barrier rather than a best-effort before-quit callback.
    const activeOwners = new Set(runner.list({ statuses: ['cancelling', 'running'] }).map(record => record.ownerId))
    for (const ownerId of activeOwners)
      await runner.interruptOwner(ownerId, 'host-restarted')

    app.off('web-contents-created', onWebContentsCreated)
    for (const cleanup of [...rendererCleanups.values()])
      cleanup()
    disposeHandlers()
    disposeContext()
  }

  lifecycle.appHooks.onStop(dispose)
  return { dispose, runner }
}

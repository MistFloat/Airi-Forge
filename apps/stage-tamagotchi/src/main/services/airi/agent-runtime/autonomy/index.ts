import type { Event, WebContents } from 'electron'
import type { Lifecycle } from 'injeca'

import type { ElectronAgentSessionEventService } from '../session-events'
import type { AgentAutonomyService } from './service'

import { createContext } from '@moeru/eventa/adapters/electron/main'
import { app, ipcMain, webContents } from 'electron'

import { registerAgentAutonomyHandlers } from './ipc'
import { createAgentAutonomyService } from './service'

const SCHEDULE_DRIVE_INTERVAL_MS = 1_000

/** Electron lifecycle owner for durable Goal and Schedule automation. */
export interface ElectronAgentAutonomyService {
  /** Stops timers, repairs claimed work, and removes IPC/listeners. */
  dispose: () => Promise<void>
  /** Main-process state machine exposed for diagnostics. */
  service: AgentAutonomyService
}

/**
 * Starts event-sourced Goal, Schedule, and background-task automation.
 *
 * Call stack:
 *
 * setupAgentAutonomyService
 *   -> {@link createAgentAutonomyService}
 *   -> {@link registerAgentAutonomyHandlers}
 *   -> {@link AgentAutonomyService.drive}
 *   -> renderer ordinary follow-up turn
 */
export async function setupAgentAutonomyService(
  lifecycle: Lifecycle,
  sessionEvents: ElectronAgentSessionEventService,
): Promise<ElectronAgentAutonomyService> {
  const service = createAgentAutonomyService({ eventStore: sessionEvents.service })
  const { context, dispose: disposeContext } = createContext(ipcMain)
  const disposeHandlers = registerAgentAutonomyHandlers(
    context,
    service,
    options => String(options?.raw.ipcMainEvent.sender.id ?? ''),
  )
  const rendererCleanups = new Map<number, () => void>()
  let disposed = false

  const release = (contents: WebContents) => {
    void service.releaseOwner(String(contents.id)).catch((error) => {
      console.error(`Failed to release Agent schedules for renderer ${contents.id}`, error)
    })
  }
  const attachRenderer = (contents: WebContents) => {
    if (disposed || rendererCleanups.has(contents.id))
      return
    const releaseOwner = () => release(contents)
    let detach: () => void
    const cleanup = () => {
      contents.off('did-start-loading', releaseOwner)
      contents.off('destroyed', detach)
      contents.off('render-process-gone', releaseOwner)
      rendererCleanups.delete(contents.id)
    }
    detach = () => {
      releaseOwner()
      cleanup()
    }

    contents.on('did-start-loading', releaseOwner)
    contents.once('destroyed', detach)
    contents.on('render-process-gone', releaseOwner)
    rendererCleanups.set(contents.id, cleanup)
  }

  const onWebContentsCreated = (_event: Event, contents: WebContents) => attachRenderer(contents)
  for (const contents of webContents.getAllWebContents())
    attachRenderer(contents)
  app.on('web-contents-created', onWebContentsCreated)

  await service.drive()
  const driveTimer = setInterval(() => {
    void service.drive().catch((error) => {
      console.error('Failed to drive Agent schedules', error)
    })
  }, SCHEDULE_DRIVE_INTERVAL_MS)

  const dispose = async () => {
    if (disposed)
      return
    disposed = true
    clearInterval(driveTimer)

    const claimedOwners = new Set<string>()
    for (const event of sessionEvents.service.listAll()) {
      if (event.type === 'schedule.changed' && event.payload.schedule.claimedBy)
        claimedOwners.add(event.payload.schedule.claimedBy)
    }
    for (const ownerId of claimedOwners)
      await service.releaseOwner(ownerId)

    app.off('web-contents-created', onWebContentsCreated)
    for (const cleanup of [...rendererCleanups.values()])
      cleanup()
    disposeHandlers()
    disposeContext()
  }

  lifecycle.appHooks.onStop(dispose)
  return { dispose, service }
}

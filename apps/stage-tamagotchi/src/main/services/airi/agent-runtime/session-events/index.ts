import type { AgentSessionEventService } from './service'

import { createContext } from '@moeru/eventa/adapters/electron/main'
import { app, ipcMain } from 'electron'

import { registerAgentSessionEventHandlers } from './ipc'
import { createAgentSessionEventRepository } from './repository'
import { createAgentSessionEventService } from './service'

/** Main-process event service with explicit Electron lifecycle cleanup. */
export interface ElectronAgentSessionEventService {
  /** Removes IPC handlers and the pending app lifecycle listener. */
  dispose: () => void
  /** Authoritative event API consumed by main-process projections. */
  service: AgentSessionEventService
}

/**
 * Starts the durable, authoritative Agent session event service.
 *
 * Call stack:
 *
 * setupAgentSessionEventService
 *   -> {@link createAgentSessionEventRepository}
 *   -> {@link createAgentSessionEventService}
 *   -> {@link registerAgentSessionEventHandlers}
 */
export function setupAgentSessionEventService(): ElectronAgentSessionEventService {
  const repository = createAgentSessionEventRepository()
  const service = createAgentSessionEventService({ repository })
  const { context, dispose: disposeContext } = createContext(ipcMain)
  const disposeHandlers = registerAgentSessionEventHandlers(context, service)
  let disposed = false

  const dispose = () => {
    if (disposed)
      return
    disposed = true
    disposeHandlers()
    disposeContext()
    app.off('before-quit', dispose)
  }

  app.once('before-quit', dispose)
  return { dispose, service }
}

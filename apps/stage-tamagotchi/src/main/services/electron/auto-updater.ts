import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { AutoUpdaterState } from '@proj-airi/electron-eventa/electron-updater'
import type { BrowserWindow } from 'electron'

import type { ElectronUpdaterChannel } from '../../../shared/eventa'

import { defineInvokeHandler } from '@moeru/eventa'

import {
  autoUpdater as autoUpdaterEventa,
  electronGetUpdaterPreferences,
  electronSetUpdaterPreferences,
} from '../../../shared/eventa'

export interface AutoUpdater {
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  getPreferredUpdateLane: () => undefined | UpdateLane
  quitAndInstall: () => Promise<void>
  setPreferredUpdateLane: (lane: undefined | UpdateLane) => Promise<void>
  state: AutoUpdaterState
  subscribe: (callback: (state: AutoUpdaterState) => void) => () => void
}
export interface AutoUpdaterOptions {
  getStoredUpdateLane?: () => undefined | UpdateLane
  setStoredUpdateLane?: (lane: undefined | UpdateLane) => void
}

type MainContext = ReturnType<typeof createContext>['context']

type UpdateLane = ElectronUpdaterChannel

/** Registers stable IPC handlers while update networking remains disabled. */
export function createAutoUpdaterService(params: { context: MainContext, service: AutoUpdater, window: BrowserWindow }) {
  const cleanups: Array<() => void> = [
    defineInvokeHandler(params.context, autoUpdaterEventa.getState, () => params.service.state),
    defineInvokeHandler(params.context, autoUpdaterEventa.checkForUpdates, async () => params.service.state),
    defineInvokeHandler(params.context, autoUpdaterEventa.downloadUpdate, async () => params.service.state),
    defineInvokeHandler(params.context, electronGetUpdaterPreferences, async () => ({
      channel: params.service.getPreferredUpdateLane(),
    })),
    defineInvokeHandler(params.context, electronSetUpdaterPreferences, async (payload) => {
      await params.service.setPreferredUpdateLane(payload?.channel)
      return { channel: params.service.getPreferredUpdateLane() }
    }),
    defineInvokeHandler(params.context, autoUpdaterEventa.quitAndInstall, async () => {}),
  ]

  const cleanup = () => {
    for (const dispose of cleanups)
      dispose()
  }

  params.window.on('closed', cleanup)
  return cleanup
}

/**
 * Provides the updater contract without enabling remote checks or installation.
 * This fork intentionally keeps its local code unchanged until updates are
 * explicitly re-enabled by replacing this boundary.
 */
export function setupAutoUpdater(options: AutoUpdaterOptions = {}): AutoUpdater {
  let preferredLane = options.getStoredUpdateLane?.()
  const state: AutoUpdaterState = { status: 'disabled' }

  return {
    checkForUpdates: async () => {},
    downloadUpdate: async () => {},
    getPreferredUpdateLane: () => preferredLane,
    quitAndInstall: async () => {},
    setPreferredUpdateLane: async (lane) => {
      preferredLane = lane
      options.setStoredUpdateLane?.(lane)
    },
    state,
    subscribe: (callback) => {
      callback(state)
      return () => {}
    },
  }
}

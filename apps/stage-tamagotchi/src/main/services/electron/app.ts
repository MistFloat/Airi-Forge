import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type { ElectronInstructionFilePayload } from '../../../shared/eventa'

import process from 'node:process'

import { existsSync, readFileSync, watch } from 'node:fs'
import { resolve } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app, shell } from 'electron'
import { isLinux, isMacOS, isWindows } from 'std-env'

import { electron, electronAppOpenUserDataFolder, electronAppQuit, electronInstructionFileChanged, electronInstructionFileGet } from '../../../shared/eventa'

export function createAppService(params: { context: ReturnType<typeof createContext>['context'], window: BrowserWindow }) {
  defineInvokeHandler(params.context, electron.app.isMacOS, () => isMacOS)
  defineInvokeHandler(params.context, electron.app.isWindows, () => isWindows)
  defineInvokeHandler(params.context, electron.app.isLinux, () => isLinux)
  defineInvokeHandler(params.context, electronAppOpenUserDataFolder, async () => {
    const path = app.getPath('userData')
    const openResult = await shell.openPath(path)
    if (openResult) {
      throw new Error(openResult)
    }
    return { path }
  })
  defineInvokeHandler(params.context, electronAppQuit, () => app.quit())

  const instructionFilePath = resolve(process.cwd(), 'instruction.md')
  function readInstructionFile(): ElectronInstructionFilePayload {
    return {
      content: existsSync(instructionFilePath) ? readFileSync(instructionFilePath, 'utf-8') : undefined,
      path: instructionFilePath,
    }
  }

  watch(instructionFilePath, { persistent: false, recursive: false }, () => {
    params.context.emit(electronInstructionFileChanged, readInstructionFile())
  })

  defineInvokeHandler(params.context, electronInstructionFileGet, () => readInstructionFile())
}

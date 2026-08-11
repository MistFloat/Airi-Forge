import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type { ElectronInstructionFilePayload } from '../../../shared/eventa'

import process from 'node:process'

import { existsSync, readFileSync, watch } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app, shell } from 'electron'
import { isLinux, isMacOS, isWindows } from 'std-env'

import { electron, electronAppOpenUserDataFolder, electronAppQuit, electronInstructionFileChanged, electronInstructionFileGet, electronProviderMaxTokensGet, electronProviderMaxTokensSet } from '../../../shared/eventa'
import { createProviderMaxTokensConfigRepository, resolveProviderMaxTokensConfigPath } from '../../configs/provider-max-tokens'

const providerMaxTokensConfigPath = resolveProviderMaxTokensConfigPath(process.cwd())
const providerMaxTokensRepository = createProviderMaxTokensConfigRepository(providerMaxTokensConfigPath)

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
  defineInvokeHandler(params.context, electronProviderMaxTokensGet, async () => ({
    config: await providerMaxTokensRepository.read(),
    path: providerMaxTokensConfigPath,
  }))
  defineInvokeHandler(params.context, electronProviderMaxTokensSet, async ({ maxTokens, providerId }) => ({
    config: await providerMaxTokensRepository.set(providerId, maxTokens),
    path: providerMaxTokensConfigPath,
  }))

  function findMonorepoRoot(start: string): string {
    let current = start
    while (current !== dirname(current)) {
      if (existsSync(resolve(current, 'pnpm-workspace.yaml')))
        return current
      current = dirname(current)
    }
    return start
  }

  const instructionFilePath = resolve(findMonorepoRoot(process.cwd()), 'instruction.md')
  function readInstructionFile(): ElectronInstructionFilePayload {
    return {
      content: existsSync(instructionFilePath) ? readFileSync(instructionFilePath, 'utf-8') : undefined,
      path: instructionFilePath,
    }
  }

  function startWatchingInstructionFile() {
    if (!existsSync(instructionFilePath)) {
      setTimeout(startWatchingInstructionFile, 2000)
      return
    }
    try {
      watch(instructionFilePath, { persistent: false, recursive: false }, () => {
        params.context.emit(electronInstructionFileChanged, readInstructionFile())
      })
    }
    catch (error) {
      console.warn('[App] Failed to watch instruction.md:', error)
    }
  }
  startWatchingInstructionFile()

  defineInvokeHandler(params.context, electronInstructionFileGet, () => readInstructionFile())
}

import type { SkillTransport } from '@proj-airi/stage-ui/stores/modules/skill-store'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { configureSkillTransport, useSkillStore } from '@proj-airi/stage-ui/stores/modules/skill-store'

import { electronSkillsChanged, electronSkillsList, electronSkillsRead } from '../../shared/eventa'

/**
 * Connects the renderer skill store to the Electron-owned skill directories.
 *
 * Call this after Pinia is installed: the bridge reads the store immediately.
 * The store only ever lists and reads through the installed transport, so the
 * skill directories stay owned by the main process, and snapshots pushed after
 * a file change keep the system-prompt advertisement current.
 */
export function initializeAgentSkillsBridge(transport: SkillTransport = createEventaTransport()): () => void {
  const context = getElectronEventaContext()
  const skillStore = useSkillStore()
  const disposeTransport = configureSkillTransport(transport)

  context.on(electronSkillsChanged, (event) => {
    if (event.body)
      skillStore.applySnapshot(event.body)
  })

  // The main process only pushes on change, so the first listing is requested
  // explicitly: an empty snapshot would hide every installed skill from the
  // system prompt until the next file edit.
  void skillStore.refresh()

  return () => {
    disposeTransport()
  }
}

function createEventaTransport(): SkillTransport {
  const context = getElectronEventaContext()

  return {
    list: defineInvoke(context, electronSkillsList),
    read: defineInvoke(context, electronSkillsRead),
  }
}

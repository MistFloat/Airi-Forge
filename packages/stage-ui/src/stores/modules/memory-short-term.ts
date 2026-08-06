import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useDuckDb } from '../../composables/use-duck-db'
import { createShortTermMemoryRepo } from '../../database/repos/short-term-memory.repo'
import { useConfiguratorByModsChannelServer } from '../configurator'

export const useMemoryShortTermStore = defineStore('memory-short-term', () => {
  const configurator = useConfiguratorByModsChannelServer()
  const enabled = useLocalStorageManualReset<boolean>('settings/memory-short-term/enabled', false)
  const maxItems = useLocalStorageManualReset<number>('settings/memory-short-term/max-items', 100)
  const contextItems = useLocalStorageManualReset<number>('settings/memory-short-term/context-items', 8)
  const contextCharacterBudget = useLocalStorageManualReset<number>('settings/memory-short-term/context-character-budget', 6000)
  const { getDb } = useDuckDb()

  async function getRepo() {
    const database = await getDb()
    if (!database.value)
      throw new Error('Short-term memory database is unavailable')
    return createShortTermMemoryRepo(database.value)
  }

  function saveSettings() {
    configurator.updateFor('memory-short-term', {
      contextCharacterBudget: contextCharacterBudget.value,
      contextItems: contextItems.value,
      enabled: enabled.value,
      maxItems: maxItems.value,
    })
  }

  const configured = computed(() => {
    return enabled.value
      && Number.isInteger(Number(maxItems.value))
      && Number(maxItems.value) > 0
      && Number.isInteger(Number(contextItems.value))
      && Number(contextItems.value) > 0
      && Number(contextItems.value) <= Number(maxItems.value)
      && Number.isInteger(Number(contextCharacterBudget.value))
      && Number(contextCharacterBudget.value) >= 500
  })

  async function rememberTurn(sessionId: string, userText: string, assistantText: string): Promise<void> {
    if (!configured.value || !userText.trim() || !assistantText.trim())
      return

    const repo = await getRepo()
    await repo.remember({
      assistantText: assistantText.trim(),
      createdAt: Date.now(),
      id: nanoid(),
      sessionId,
      userText: userText.trim(),
    }, Number(maxItems.value))
  }

  async function recallPrompt(sessionId: string): Promise<string | undefined> {
    if (!configured.value)
      return undefined

    const repo = await getRepo()
    const turns = await repo.recall(sessionId, { limit: Number(contextItems.value) })
    if (turns.length === 0)
      return undefined

    const budget = Number(contextCharacterBudget.value)
    const selected: string[] = []
    let used = 0
    for (const turn of turns.toReversed()) {
      const rendered = `User: ${turn.userText}\nAssistant: ${turn.assistantText}`
      if (selected.length > 0 && used + rendered.length > budget)
        break
      selected.unshift(rendered.slice(0, Math.max(0, budget - used)))
      used += rendered.length
    }

    return [
      '## Short-term memory',
      'Use these previous conversation turns only as background. Prefer the current user message when they conflict.',
      '',
      ...selected,
    ].join('\n')
  }

  async function clearMemory(sessionId?: string): Promise<void> {
    const repo = await getRepo()
    await repo.clear(sessionId)
  }

  function resetState() {
    enabled.reset()
    maxItems.reset()
    contextItems.reset()
    contextCharacterBudget.reset()
    saveSettings()
  }

  return {
    clearMemory,
    configured,
    contextCharacterBudget,
    contextItems,
    enabled,
    maxItems,
    recallPrompt,
    rememberTurn,
    resetState,
    saveSettings,
  }
})

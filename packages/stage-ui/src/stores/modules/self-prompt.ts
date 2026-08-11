import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useDuckDb } from '../../composables/use-duck-db'
import { createSelfPromptRepo } from '../../database/repos/self-prompt.repo'
import { useMemoryLongTermStore } from './memory-long-term'

export interface PendingSelfPrompt {
  capturedAt: string
  createdAt: number
  id: string
  prompt: string
  sessionId: string
  sourceText: string
}

/**
 * Self-prompt channel (single-slot).
 *
 * The chat orchestrator captures a trailing `//` line from AIRI's reply and
 * routes it here. The active scheduler slot stays in localStorage, while every
 * generated prompt is appended to the OPFS-backed DuckDB delivery log. A newer
 * prompt discards the older active slot, so the scheduler stays bounded without
 * losing the older prompt's sent/not-sent audit history. A semantic copy is also
 * written to long-term memory when configured.
 *
 * The "wake" step is implemented in the chat orchestrator store: after a
 * round settles, if a pending self prompt exists and the conversation stays
 * quiet, runSelfTurn() feeds it back as an internal `self` turn.
 */
export const useSelfPromptStore = defineStore('self-prompt', () => {
  const pendingPrompt = useLocalStorageManualReset<null | PendingSelfPrompt>('memory/self/pending-prompt', null)
  const pendingPersistence = new Map<string, Promise<void>>()
  const { getDb } = useDuckDb()

  const hasPending = computed(() => !!pendingPrompt.value)

  async function getRepo() {
    const database = await getDb()
    if (!database.value)
      throw new Error('Self-prompt database is unavailable')
    return createSelfPromptRepo(database.value)
  }

  async function waitForInitialPersistence(id: string): Promise<void> {
    try {
      await pendingPersistence.get(id)
    }
    catch {
      // The originating capture already logs the failure. A status update is
      // still attempted because database initialization may recover meanwhile.
    }
  }

  async function captureSelfPrompt(event: { prompt: string, sessionId: string, sourceText: string }) {
    const replacedRecord = pendingPrompt.value
    const createdAt = Date.now()
    const record: PendingSelfPrompt = {
      capturedAt: new Date(createdAt).toISOString(),
      createdAt,
      id: nanoid(),
      prompt: event.prompt,
      sessionId: event.sessionId,
      sourceText: event.sourceText,
    }
    pendingPrompt.value = record

    // The local slot remains immediately available to the scheduler while the
    // durable audit row initializes asynchronously in OPFS-backed DuckDB.
    const persistence = getRepo().then(repo => repo.save({
      ...record,
      deliveryStatus: 'pending',
    }))
    pendingPersistence.set(record.id, persistence)
    try {
      await persistence
    }
    catch (error) {
      console.warn('Failed to persist self prompt delivery state (fail-open):', error)
    }
    finally {
      if (pendingPersistence.get(record.id) === persistence)
        pendingPersistence.delete(record.id)
    }

    if (replacedRecord) {
      await waitForInitialPersistence(replacedRecord.id)
      try {
        const repo = await getRepo()
        await repo.markDiscarded(replacedRecord.id, createdAt)
      }
      catch (error) {
        console.warn('Failed to mark replaced self prompt as discarded:', error)
      }
    }

    // Keep the existing optional durable copy in semantic long-term memory.
    const longTermMemoryStore = useMemoryLongTermStore()
    if (longTermMemoryStore.configured) {
      try {
        await longTermMemoryStore.saveMemory({
          confidence: 1,
          content: event.prompt,
          importance: 0.8,
          kind: 'fact',
          status: 'active',
          tags: ['self-prompt'],
          title: `Self prompt @ ${record.capturedAt}`,
        })
      }
      catch (error) {
        console.warn('Failed to persist self prompt to long-term memory (fail-open):', error)
      }
    }

    return record
  }

  function consumePending(): null | PendingSelfPrompt {
    const record = pendingPrompt.value
    pendingPrompt.value = null
    return record
  }

  /** Discards the pending autonomous turn without sending it. */
  async function clearPending() {
    const record = pendingPrompt.value
    pendingPrompt.value = null
    if (!record)
      return

    await waitForInitialPersistence(record.id)
    try {
      const repo = await getRepo()
      await repo.markDiscarded(record.id, Date.now())
    }
    catch (error) {
      console.warn('Failed to mark self prompt as discarded:', error)
    }
  }

  /** Marks a prompt sent only after the internal chat turn completes successfully. */
  async function markSent(id: string) {
    await waitForInitialPersistence(id)
    try {
      const repo = await getRepo()
      await repo.markSent(id, Date.now())
    }
    catch (error) {
      console.warn('Failed to mark self prompt as sent:', error)
    }
  }

  /** Restores a consumed prompt after a delivery failure and records the reason. */
  async function restoreFailed(record: PendingSelfPrompt, error: string) {
    pendingPrompt.value = record
    await waitForInitialPersistence(record.id)
    try {
      const repo = await getRepo()
      await repo.markFailed(record.id, error)
    }
    catch (persistenceError) {
      console.warn('Failed to record self prompt delivery failure:', persistenceError)
    }
  }

  /** Restores a consumed prompt when a turn cannot start; no send was attempted. */
  function restorePending(record: PendingSelfPrompt) {
    pendingPrompt.value = record
  }

  return {
    captureSelfPrompt,
    clearPending,
    consumePending,
    hasPending,
    markSent,
    pendingPrompt,
    restoreFailed,
    restorePending,
  }
})

import type { useMemoryLongTermStore as UseMemoryLongTermStore } from './memory-long-term'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMemoryLongTermStore } from './memory-long-term'

const storageMock = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}))

vi.mock('@proj-airi/stage-shared/composables', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')

  return {
    useLocalStorageManualReset: <T>(key: string, initialValue: T) => {
      const value = vue.ref((storageMock.values.has(key) ? storageMock.values.get(key) : initialValue) as T)

      storageMock.values.set(key, value.value)
      vue.watch(value, (newValue) => {
        storageMock.values.set(key, newValue)
      }, { flush: 'sync' })

      return Object.assign(value, {
        reset: () => {
          value.value = initialValue
        },
      })
    },
  }
})

vi.mock('../configurator', () => ({
  useConfiguratorByModsChannelServer: () => ({
    updateFor: vi.fn(),
  }),
}))

vi.mock('../providers', () => ({
  useProvidersStore: () => ({
    getProviderConfig: vi.fn(() => ({})),
    getProviderInstance: vi.fn(),
  }),
}))

type MemoryLongTermStore = ReturnType<typeof UseMemoryLongTermStore>

function configureJina(store: MemoryLongTermStore) {
  // Pinia setup stores auto-unwrap refs on the instance, so assign values directly.
  store.enabled = true
  store.connectionString = 'postgresql://airi:pazzw0rd123@localhost:5432/airi_memory'
  store.memoryNamespace = 'default'
  store.instructionTokenBudget = 1200
  store.embeddingSource = 'jina-api'
  store.jinaApiKey = 'jina_test'
  store.jinaModel = 'jina-embeddings-v5-text-small'
  store.jinaDimensions = 1024
  store.similarityThreshold = 0.7
  store.maxResults = 5
}

describe('useMemoryLongTermStore promoteClaim', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storageMock.values.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('drains embedding jobs after a manual promotion so the promoted memory is immediately queryable', async () => {
    // ROOT CAUSE:
    //
    // promoteClaim only enqueues a build_embedding job; nothing drained it until
    // the next recall or turn, and recallMemories races its drain against a 200ms
    // budget that Jina round-trips usually exceed. That is why a manually
    // promoted memory stayed unqueryable until the user edited and re-saved it
    // (upsert computes the embedding inline).
    //
    // We fixed this by making manual promotion await a bounded drain
    // (processEmbeddingJobs raced against a sleep) so the promoted memory has a
    // vector before the governance page refreshes.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ memoryId: 'm-1', outcome: 'promoted' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ completed: 1, failed: 0, skipped: 0 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const store = useMemoryLongTermStore()
    configureJina(store)

    await store.promoteClaim('claim-1')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:6123/api/v1/memory/claims/promote', expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:6123/api/v1/memory/jobs/run', expect.any(Object))
  })

  it('keeps auto promotion fire-and-forget and does not wait on a drain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ memoryId: 'm-2', outcome: 'promoted' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const store = useMemoryLongTermStore()
    configureJina(store)

    await store.promoteClaim('claim-2', 'auto')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:6123/api/v1/memory/claims/promote', expect.any(Object))
  })
})

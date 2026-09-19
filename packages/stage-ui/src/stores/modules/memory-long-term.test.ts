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
  store.connectionString = 'postgresql://airi:test@localhost:5432/airi_memory'
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

  it('stores the user and assistant exchange as evidence without invoking an extractor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      assistantEvidenceId: 'evidence-assistant',
      ok: true,
      userEvidenceId: 'evidence-user',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const store = useMemoryLongTermStore()
    store.enabled = true
    store.connectionString = 'postgresql://airi:test@localhost:5432/airi_memory'
    store.memoryNamespace = 'default'
    store.instructionTokenBudget = 1200

    await store.rememberTurn('session-1', 'Remember the raw question.', 'Remember the raw answer.')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:6123/api/v1/memory/remember', expect.objectContaining({
      body: expect.stringContaining('Remember the raw answer.'),
    }))
  })

  it('reports a remember failure so the event projection keeps its retry cursor', async () => {
    // ROOT CAUSE:
    //
    // rememberTurn swallowed the gateway failure to keep chat fail-open. The
    // detached event projector therefore observed a fulfilled adapter promise
    // and committed memory.projected even though PostgreSQL stored nothing.
    //
    // Chat already isolates projection work from sending. The adapter must
    // reject here so the projector can leave its durable cursor unchanged.
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'PostgreSQL is unavailable' }),
      { status: 500 },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const store = useMemoryLongTermStore()
    store.enabled = true
    store.connectionString = 'postgresql://airi:test@localhost:5432/airi_memory'
    store.memoryNamespace = 'default'
    store.instructionTokenBudget = 1200

    await expect(
      store.rememberTurn('session-1', 'Question', 'Answer'),
    ).rejects.toThrow('Long-term memory remember failed: 500')
  })

  it('searches evidence and long-term memory independently without an embedding provider', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ evidence: [{ content: 'Raw blue evidence', id: 'evidence-1' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ memories: [{ content: 'Blue preference', memoryId: 'memory-1' }], total: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const store = useMemoryLongTermStore()
    store.enabled = true
    store.connectionString = 'postgresql://airi:test@localhost:5432/airi_memory'
    store.memoryNamespace = 'default'
    store.instructionTokenBudget = 1200

    const evidence = await store.searchEvidenceText('blue', { limit: 4 })
    const memories = await store.searchMemoriesText('blue', { limit: 4 })

    expect(evidence).toHaveLength(1)
    expect(memories).toHaveLength(1)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:6123/api/v1/memory/evidence/list', expect.objectContaining({
      body: expect.stringContaining('"search":"blue"'),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:6123/api/v1/memory/list', expect.objectContaining({
      body: expect.stringContaining('"search":"blue"'),
    }))
  })
})

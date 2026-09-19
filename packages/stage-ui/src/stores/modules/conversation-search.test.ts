import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configureConversationSearchTransport,
  CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE,
  useConversationSearchStore,
} from './conversation-search'

describe('conversation search store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    configureConversationSearchTransport()
    vi.restoreAllMocks()
  })

  it('reports an explicit failure when no transport is installed', async () => {
    const store = useConversationSearchStore()

    expect(store.hasTransport()).toBe(false)
    await expect(store.search({ terms: ['vector'] })).rejects.toThrow(CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE)
  })

  it('forwards the query to the installed transport', async () => {
    const search = vi.fn(async () => [])
    configureConversationSearchTransport({ search })

    const store = useConversationSearchStore()
    expect(store.hasTransport()).toBe(true)

    await store.search({ limit: 3, sessionId: 'session-a', terms: ['vector', 'memory'] })
    expect(search).toHaveBeenCalledWith({ limit: 3, sessionId: 'session-a', terms: ['vector', 'memory'] })
  })

  it('only clears the transport it installed', async () => {
    const first = { search: vi.fn(async () => []) }
    const second = { search: vi.fn(async () => []) }
    const disposeFirst = configureConversationSearchTransport(first)

    configureConversationSearchTransport(second)
    disposeFirst()

    const store = useConversationSearchStore()
    expect(store.hasTransport()).toBe(true)
    await store.search({ terms: ['vector'] })
    expect(second.search).toHaveBeenCalledTimes(1)
    expect(first.search).not.toHaveBeenCalled()
  })

  it('propagates transport failures to the caller', async () => {
    configureConversationSearchTransport({
      search: vi.fn(async () => {
        throw new Error('log unavailable')
      }),
    })

    await expect(useConversationSearchStore().search({ terms: ['vector'] })).rejects.toThrow('log unavailable')
  })
})

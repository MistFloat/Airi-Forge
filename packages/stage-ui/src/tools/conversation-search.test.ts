import type { ConversationSearchHit } from '@proj-airi/core-agent'
import type { ToolExecuteOptions } from '@xsai/shared-chat'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureConversationSearchTransport, CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE } from '../stores/modules/conversation-search'
import { conversationSearchTools } from './conversation-search'

const toolOptions = {} as ToolExecuteOptions

function createHit(overrides: Partial<ConversationSearchHit> = {}): ConversationSearchHit {
  return {
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    matchCount: 2,
    matchedTerms: ['vector'],
    matchIndex: 0,
    messageId: 'message-a',
    role: 'user',
    sequence: 1,
    sessionId: 'session-a',
    snippet: 'how does the vector store work',
    turnId: 'turn-a',
    ...overrides,
  }
}

async function searchTool() {
  const tools = await conversationSearchTools()
  const search = tools.find(tool => tool.function.name === 'built_in_conversationSearch')
  expect(search).toBeDefined()
  return search!
}

describe('conversation search tool', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    configureConversationSearchTransport()
    vi.restoreAllMocks()
  })

  it('searches through the transport and renders dated hits', async () => {
    const search = vi.fn(async () => [createHit()])
    configureConversationSearchTransport({ search })

    const output = await (await searchTool()).execute({ limit: 5, query: 'Vector  memory' }, toolOptions)

    expect(search).toHaveBeenCalledWith({ limit: 5, terms: ['vector', 'memory'] })
    expect(output).toContain('Found 1 matching message(s) for "Vector  memory"')
    expect(output).toContain('2026-01-02T03:04:05.000Z [user] session session-a (message message-a): how does the vector store work')
  })

  it('forwards the session filter only when supplied', async () => {
    const search = vi.fn(async () => [])
    configureConversationSearchTransport({ search })

    await (await searchTool()).execute({ query: 'vector' }, toolOptions)
    expect(search).toHaveBeenCalledWith({ terms: ['vector'] })

    await (await searchTool()).execute({ query: 'vector', sessionId: 'session-b' }, toolOptions)
    expect(search).toHaveBeenLastCalledWith({ sessionId: 'session-b', terms: ['vector'] })
  })

  it('reports an empty result set without inventing matches', async () => {
    configureConversationSearchTransport({ search: vi.fn(async () => []) })

    await expect((await searchTool()).execute({ query: 'nothing' }, toolOptions))
      .resolves
      .toBe('No earlier messages matched "nothing".')
  })

  it('asks for keywords when the query has no terms', async () => {
    const search = vi.fn(async () => [])
    configureConversationSearchTransport({ search })

    await expect((await searchTool()).execute({ query: '   ' }, toolOptions))
      .resolves
      .toBe('Provide at least one keyword to search for.')
    expect(search).not.toHaveBeenCalled()
  })

  it('reports that search is unavailable without a transport', async () => {
    await expect((await searchTool()).execute({ query: 'vector' }, toolOptions))
      .resolves
      .toBe(CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE)
  })

  it('reports a transport failure instead of throwing at the model', async () => {
    configureConversationSearchTransport({
      search: vi.fn(async () => {
        throw new Error('log unavailable')
      }),
    })

    await expect((await searchTool()).execute({ query: 'vector' }, toolOptions))
      .resolves
      .toBe('Conversation search failed: log unavailable')
  })
})

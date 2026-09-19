import type { AgentSessionEvent } from './events'

import { describe, expect, it } from 'vitest'

import { buildConversationSearchTerms, searchConversationMessages } from './conversation-search'

function messageEvent(input: {
  content: string
  messageId: string
  occurredAt: number
  role?: 'assistant' | 'user'
  sequence: number
  sessionId: string
  turnId?: string
}): AgentSessionEvent {
  const role = input.role ?? 'user'
  return {
    occurredAt: input.occurredAt,
    payload: {
      message: { content: input.content, role },
      messageId: input.messageId,
      role,
      status: 'complete',
      turnId: input.turnId ?? `turn-${input.sequence}`,
    },
    sequence: input.sequence,
    sessionId: input.sessionId,
    type: 'message.appended',
  } as AgentSessionEvent
}

function turnEvent(sessionId: string, sequence: number): AgentSessionEvent {
  return {
    occurredAt: 1,
    payload: { source: 'text', turnId: 'turn-a' },
    sequence,
    sessionId,
    type: 'turn.admitted',
  } as AgentSessionEvent
}

describe('buildConversationSearchTerms', () => {
  it('lowercases, trims, and de-duplicates the query', () => {
    expect(buildConversationSearchTerms('  Vector   memory\nvector ')).toEqual(['vector', 'memory'])
  })

  it('caps the term count so one query cannot scan for unbounded patterns', () => {
    expect(buildConversationSearchTerms('a b c d e f g h i j k')).toHaveLength(8)
  })

  it('returns no terms for a blank query', () => {
    expect(buildConversationSearchTerms('   ')).toEqual([])
  })
})

describe('searchConversationMessages', () => {
  const events = [
    messageEvent({ content: 'How does the vector memory store work?', messageId: 'm1', occurredAt: 100, sequence: 1, sessionId: 'session-a' }),
    messageEvent({ content: 'It keeps embeddings in Postgres.', messageId: 'm2', occurredAt: 200, role: 'assistant', sequence: 2, sessionId: 'session-a' }),
    messageEvent({ content: 'The vector store is unrelated to the memory panel.', messageId: 'm3', occurredAt: 300, sequence: 3, sessionId: 'session-b' }),
  ]

  it('requires every term to appear in the message', () => {
    const hits = searchConversationMessages(events, { terms: ['vector', 'memory'] })

    // Same match strength, so the newer message ranks first.
    expect(hits.map(hit => hit.messageId)).toEqual(['m3', 'm1'])
  })

  it('matches case-insensitively', () => {
    const hits = searchConversationMessages(events, { terms: ['POSTGRES'] })

    expect(hits.map(hit => hit.messageId)).toEqual(['m2'])
  })

  it('ranks stronger matches above newer but weaker ones', () => {
    const hits = searchConversationMessages([
      messageEvent({ content: 'memory memory memory', messageId: 'strong', occurredAt: 100, sequence: 1, sessionId: 'session-a' }),
      messageEvent({ content: 'memory', messageId: 'weak', occurredAt: 900, sequence: 2, sessionId: 'session-a' }),
    ], { terms: ['memory'] })

    expect(hits.map(hit => hit.messageId)).toEqual(['strong', 'weak'])
    expect(hits[0]?.matchCount).toBe(3)
  })

  it('breaks equal-strength ties by recency', () => {
    const hits = searchConversationMessages([
      messageEvent({ content: 'memory', messageId: 'older', occurredAt: 100, sequence: 1, sessionId: 'session-a' }),
      messageEvent({ content: 'memory', messageId: 'newer', occurredAt: 500, sequence: 2, sessionId: 'session-a' }),
    ], { terms: ['memory'] })

    expect(hits.map(hit => hit.messageId)).toEqual(['newer', 'older'])
  })

  it('filters by session and by minimum time', () => {
    expect(searchConversationMessages(events, { sessionId: 'session-b', terms: ['vector'] }).map(hit => hit.messageId))
      .toEqual(['m3'])
    expect(searchConversationMessages(events, { since: 250, terms: ['vector'] }).map(hit => hit.messageId))
      .toEqual(['m3'])
  })

  it('honours the limit after ranking', () => {
    const hits = searchConversationMessages(events, { limit: 1, terms: ['vector'] })

    expect(hits).toHaveLength(1)
  })

  it('ignores events that carry no conversation text', () => {
    const hits = searchConversationMessages([turnEvent('session-a', 1), ...events], { terms: ['vector'] })

    expect(hits.every(hit => hit.messageId !== 'turn-a')).toBe(true)
    expect(hits).toHaveLength(2)
  })

  it('returns no hits for a blank query', () => {
    expect(searchConversationMessages(events, { terms: [] })).toEqual([])
    expect(searchConversationMessages(events, { terms: ['   '] })).toEqual([])
  })

  it('reports the match offset inside the snippet for highlighting', () => {
    const content = `${'x'.repeat(400)} needle tail`
    const hits = searchConversationMessages([
      messageEvent({ content, messageId: 'long', occurredAt: 100, sequence: 1, sessionId: 'session-a' }),
    ], { terms: ['needle'] })

    const hit = hits[0]
    expect(hit?.snippet.startsWith('…')).toBe(true)
    expect(hit?.snippet.endsWith('…')).toBe(false)
    expect(hit?.snippet.slice(hit.matchIndex, hit.matchIndex + 'needle'.length)).toBe('needle')
  })

  it('keeps a short message intact', () => {
    const hits = searchConversationMessages([
      messageEvent({ content: 'short needle', messageId: 'short', occurredAt: 100, sequence: 1, sessionId: 'session-a' }),
    ], { terms: ['needle'] })

    expect(hits[0]?.snippet).toBe('short needle')
    expect(hits[0]?.matchIndex).toBe(6)
  })

  it('searches the text parts of a content array', () => {
    const event = {
      occurredAt: 100,
      payload: {
        message: { content: [{ text: 'array needle', type: 'text' }], role: 'user' },
        messageId: 'parts',
        role: 'user',
        status: 'complete',
        turnId: 'turn-parts',
      },
      sequence: 1,
      sessionId: 'session-a',
      type: 'message.appended',
    } as AgentSessionEvent

    expect(searchConversationMessages([event], { terms: ['needle'] }).map(hit => hit.messageId)).toEqual(['parts'])
  })
})

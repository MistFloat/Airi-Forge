import { describe, expect, it } from 'vitest'

import { completedMemoryTurns } from './memory-projection'

describe('session memory projection', () => {
  it('derives one idempotent memory turn from complete message and settlement events', () => {
    const turns = completedMemoryTurns([
      {
        occurredAt: 100,
        payload: { source: 'text', turnId: 'turn-a' },
        sequence: 1,
        sessionId: 'session-a',
        type: 'turn.started',
      },
      {
        occurredAt: 101,
        payload: {
          message: { content: 'What should we build?', id: 'user-a', role: 'user' },
          messageId: 'user-a',
          role: 'user',
          status: 'complete',
          turnId: 'turn-a',
        },
        sequence: 2,
        sessionId: 'session-a',
        type: 'message.appended',
      },
      {
        occurredAt: 102,
        payload: {
          message: {
            content: 'An event-sourced desktop agent.',
            id: 'assistant-a',
            role: 'assistant',
            slices: [{ text: 'An event-sourced desktop agent.', type: 'text' }],
            tool_results: [],
          },
          messageId: 'assistant-a',
          role: 'assistant',
          status: 'complete',
          turnId: 'turn-a',
        },
        sequence: 3,
        sessionId: 'session-a',
        type: 'message.appended',
      },
      {
        occurredAt: 103,
        payload: { status: 'completed', turnId: 'turn-a' },
        sequence: 4,
        sessionId: 'session-a',
        type: 'turn.closed',
      },
    ])

    expect(turns).toEqual([{
      assistantText: 'An event-sourced desktop agent.',
      completedAt: 103,
      completedSequence: 4,
      projectionId: 'session-memory:session-a:turn-a',
      sessionId: 'session-a',
      turnId: 'turn-a',
      userText: 'What should we build?',
    }])
  })

  it('does not project interrupted or incomplete turns', () => {
    expect(completedMemoryTurns([
      {
        occurredAt: 100,
        payload: {
          message: {
            content: 'partial',
            interrupted: true,
            role: 'assistant',
            slices: [{ text: 'partial', type: 'text' }],
            tool_results: [],
          },
          messageId: 'assistant-a',
          role: 'assistant',
          status: 'interrupted',
          turnId: 'turn-a',
        },
        sequence: 1,
        sessionId: 'session-a',
        type: 'message.appended',
      },
      {
        occurredAt: 101,
        payload: { status: 'failed', turnId: 'turn-a' },
        sequence: 2,
        sessionId: 'session-a',
        type: 'turn.closed',
      },
    ])).toEqual([])
  })

  it('projects paired imported history when the assistant message becomes durable', () => {
    const turns = completedMemoryTurns([
      {
        occurredAt: 100,
        payload: {
          message: { content: 'What happened yesterday?', id: 'user-a', role: 'user' },
          messageId: 'user-a',
          origin: 'cloud',
          role: 'user',
          status: 'complete',
          turnId: 'import:cloud:user-a',
        },
        sequence: 1,
        sessionId: 'session-a',
        type: 'message.appended',
      },
      {
        occurredAt: 101,
        payload: {
          message: {
            content: 'We finished the event log.',
            id: 'assistant-a',
            role: 'assistant',
            slices: [{ text: 'We finished the event log.', type: 'text' }],
            tool_results: [],
          },
          messageId: 'assistant-a',
          origin: 'cloud',
          role: 'assistant',
          status: 'complete',
          turnId: 'import:cloud:user-a',
        },
        sequence: 2,
        sessionId: 'session-a',
        type: 'message.appended',
      },
    ])

    expect(turns).toEqual([expect.objectContaining({
      assistantText: 'We finished the event log.',
      completedSequence: 2,
      turnId: 'import:cloud:user-a',
      userText: 'What happened yesterday?',
    })])
  })
})

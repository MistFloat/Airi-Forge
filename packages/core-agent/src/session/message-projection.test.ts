import type { AgentSessionEvent } from './events'

import { describe, expect, it } from 'vitest'

import { projectSessionMessages } from './message-projection'

describe('session message projection', () => {
  it('keeps append order and replaces repeated recovery snapshots by message id', () => {
    const events: AgentSessionEvent[] = [
      {
        occurredAt: 1,
        payload: {
          message: { content: 'hello', id: 'user-1', role: 'user' },
          messageId: 'user-1',
          role: 'user',
          status: 'complete',
          turnId: 'turn-1',
        },
        sequence: 1,
        sessionId: 'session-1',
        type: 'message.appended',
      },
      {
        occurredAt: 2,
        payload: {
          message: {
            content: 'partial',
            id: 'assistant-1',
            interrupted: true,
            role: 'assistant',
            slices: [{ text: 'partial', type: 'text' }],
            tool_results: [],
          },
          messageId: 'assistant-1',
          role: 'assistant',
          status: 'interrupted',
          turnId: 'turn-1',
        },
        sequence: 2,
        sessionId: 'session-1',
        type: 'message.appended',
      },
      {
        occurredAt: 3,
        payload: {
          message: {
            content: 'restored partial',
            id: 'assistant-1',
            interrupted: true,
            role: 'assistant',
            slices: [{ text: 'restored partial', type: 'text' }],
            tool_results: [],
          },
          messageId: 'assistant-1',
          role: 'assistant',
          status: 'interrupted',
          turnId: 'turn-1',
        },
        sequence: 3,
        sessionId: 'session-1',
        type: 'message.appended',
      },
    ]

    expect(projectSessionMessages(events)).toEqual([
      expect.objectContaining({ content: 'hello', id: 'user-1' }),
      expect.objectContaining({ content: 'restored partial', id: 'assistant-1' }),
    ])
  })
})

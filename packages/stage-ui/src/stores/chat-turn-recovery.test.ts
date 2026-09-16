import type { AgentTurnRecord, ChatHistoryItem } from '@proj-airi/core-agent'

import { describe, expect, it, vi } from 'vitest'

import { recoverInterruptedChatTurns } from './chat-turn-recovery'

const interruptedTurn = {
  assistantMessageId: 'assistant-a',
  checkpoint: {
    assistantMessageId: 'assistant-a',
    assistantText: 'partial answer',
    reasoningText: 'partial reasoning',
    revision: 3,
    sessionId: 'session-a',
    turnId: 'turn-a',
    updatedAt: 90,
  },
  interruptionReason: 'renderer-detached',
  ownerId: 'renderer-old',
  sessionId: 'session-a',
  settledAt: 100,
  source: 'text',
  startedAt: 80,
  status: 'interrupted',
  turnId: 'turn-a',
  updatedAt: 100,
  userMessage: { content: 'hello', createdAt: 80, id: 'user-a', role: 'user' },
  userMessageId: 'user-a',
  userText: 'hello',
} satisfies AgentTurnRecord

describe('chat turn recovery', () => {
  it('durably restores a visible interrupted assistant prefix before acknowledging it', async () => {
    const messages: ChatHistoryItem[] = []
    const order: string[] = []
    const append = vi.fn(async (_sessionId: string, message: ChatHistoryItem) => {
      order.push('append')
      messages.push(message)
    })
    const acknowledge = vi.fn(async () => {
      order.push('acknowledge')
    })

    const recovered = await recoverInterruptedChatTurns('session-a', {
      acknowledge,
      append,
      getMessages: () => messages,
      list: vi.fn(async () => [interruptedTurn]),
    })

    expect(recovered).toBe(2)
    expect(order).toEqual(['append', 'append', 'acknowledge'])
    expect(messages).toEqual([
      {
        content: 'hello',
        createdAt: 80,
        id: 'user-a',
        role: 'user',
      },
      {
        categorization: {
          reasoning: 'partial reasoning',
          speech: 'partial answer',
        },
        content: 'partial answer',
        createdAt: 90,
        id: 'assistant-a',
        interrupted: true,
        role: 'assistant',
        slices: [{ text: 'partial answer', type: 'text' }],
        tool_results: [],
      },
    ])
  })

  it('deduplicates a previously restored message and still closes recovery', async () => {
    const messages: ChatHistoryItem[] = [{
      content: 'hello',
      id: 'user-a',
      role: 'user',
    }, {
      content: 'partial answer',
      id: 'assistant-a',
      interrupted: true,
      role: 'assistant',
      slices: [],
      tool_results: [],
    }]
    const append = vi.fn()
    const acknowledge = vi.fn(async () => {})

    const recovered = await recoverInterruptedChatTurns('session-a', {
      acknowledge,
      append,
      getMessages: () => messages,
      list: vi.fn(async () => [interruptedTurn]),
    })

    expect(recovered).toBe(0)
    expect(append).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledWith({
      assistantMessage: messages[1],
      sessionId: 'session-a',
      turnId: 'turn-a',
    })
  })

  it('restores the durable user input when interruption happened before assistant output', async () => {
    const messages: ChatHistoryItem[] = []
    const append = vi.fn(async (_sessionId: string, message: ChatHistoryItem) => {
      messages.push(message)
    })
    const acknowledge = vi.fn(async () => {})

    const recovered = await recoverInterruptedChatTurns('session-a', {
      acknowledge,
      append,
      getMessages: () => messages,
      list: vi.fn(async () => [{ ...interruptedTurn, checkpoint: undefined }]),
    })

    expect(recovered).toBe(1)
    expect(messages).toEqual([{
      content: 'hello',
      createdAt: 80,
      id: 'user-a',
      role: 'user',
    }])
    expect(acknowledge).toHaveBeenCalledWith({ sessionId: 'session-a', turnId: 'turn-a' })
  })
})

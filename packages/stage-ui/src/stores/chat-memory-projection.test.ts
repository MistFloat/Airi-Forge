import { beforeEach, describe, expect, it, vi } from 'vitest'

import { projectChatMemoryFromEvents } from './chat-memory-projection'

const projectionMocks = vi.hoisted(() => ({
  commitEvent: vi.fn(),
  longRemember: vi.fn(),
  readEvents: vi.fn(),
  shortRemember: vi.fn(),
}))

vi.mock('./chat-session-events', () => ({
  commitChatSessionEvent: projectionMocks.commitEvent,
  readChatSessionEvents: projectionMocks.readEvents,
}))

vi.mock('./modules/memory-long-term', () => ({
  useMemoryLongTermStore: () => ({ rememberTurn: projectionMocks.longRemember }),
}))

vi.mock('./modules/memory-short-term', () => ({
  useMemoryShortTermStore: () => ({ rememberTurn: projectionMocks.shortRemember }),
}))

describe('chat memory event projection', () => {
  beforeEach(() => {
    projectionMocks.commitEvent.mockReset()
    projectionMocks.commitEvent.mockResolvedValue(undefined)
    projectionMocks.longRemember.mockReset()
    projectionMocks.longRemember.mockResolvedValue(undefined)
    projectionMocks.shortRemember.mockReset()
    projectionMocks.shortRemember.mockResolvedValue(undefined)
    projectionMocks.readEvents.mockReset()
    projectionMocks.readEvents.mockResolvedValue([
      {
        occurredAt: 10,
        payload: {
          message: { content: 'question', id: 'user-1', role: 'user' },
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
        occurredAt: 20,
        payload: {
          message: { content: 'answer', id: 'assistant-1', role: 'assistant' },
          messageId: 'assistant-1',
          role: 'assistant',
          status: 'complete',
          turnId: 'turn-1',
        },
        sequence: 2,
        sessionId: 'session-1',
        type: 'message.appended',
      },
      {
        occurredAt: 30,
        payload: { status: 'completed', turnId: 'turn-1' },
        sequence: 3,
        sessionId: 'session-1',
        type: 'turn.closed',
      },
    ])
  })

  it('writes deterministic disposable memory projections from completed log turns', async () => {
    await projectChatMemoryFromEvents('session-1')

    expect(projectionMocks.shortRemember).toHaveBeenCalledWith('session-1', 'question', 'answer', {
      createdAt: 30,
      id: 'session-memory:session-1:turn-1',
    })
    expect(projectionMocks.longRemember).toHaveBeenCalledWith('session-1', 'question', 'answer', {
      memoryId: 'session-memory:session-1:turn-1',
    })
    expect(projectionMocks.commitEvent).toHaveBeenCalledWith({
      payload: { throughSequence: 3 },
      sessionId: 'session-1',
      type: 'memory.projected',
    })
  })

  it('resumes strictly after the latest successful memory cursor', async () => {
    projectionMocks.readEvents.mockResolvedValue([
      ...await projectionMocks.readEvents(),
      {
        occurredAt: 31,
        payload: { throughSequence: 3 },
        sequence: 4,
        sessionId: 'session-1',
        type: 'memory.projected',
      },
      {
        occurredAt: 40,
        payload: {
          message: { content: 'next question', id: 'user-2', role: 'user' },
          messageId: 'user-2',
          role: 'user',
          status: 'complete',
          turnId: 'turn-2',
        },
        sequence: 5,
        sessionId: 'session-1',
        type: 'message.appended',
      },
      {
        occurredAt: 50,
        payload: {
          message: { content: 'next answer', id: 'assistant-2', role: 'assistant' },
          messageId: 'assistant-2',
          role: 'assistant',
          status: 'complete',
          turnId: 'turn-2',
        },
        sequence: 6,
        sessionId: 'session-1',
        type: 'message.appended',
      },
      {
        occurredAt: 60,
        payload: { status: 'completed', turnId: 'turn-2' },
        sequence: 7,
        sessionId: 'session-1',
        type: 'turn.closed',
      },
    ])

    await projectChatMemoryFromEvents('session-1')

    expect(projectionMocks.shortRemember).toHaveBeenCalledTimes(1)
    expect(projectionMocks.shortRemember).toHaveBeenCalledWith(
      'session-1',
      'next question',
      'next answer',
      expect.objectContaining({ id: 'session-memory:session-1:turn-2' }),
    )
    expect(projectionMocks.commitEvent).toHaveBeenCalledWith({
      payload: { throughSequence: 7 },
      sessionId: 'session-1',
      type: 'memory.projected',
    })
  })

  it('does not advance the cursor when either memory adapter fails', async () => {
    const error = new Error('vector store unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    projectionMocks.longRemember.mockRejectedValueOnce(error)

    await projectChatMemoryFromEvents('session-1')

    expect(projectionMocks.commitEvent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('Session memory projection failed (fail-open):', error)
  })
})

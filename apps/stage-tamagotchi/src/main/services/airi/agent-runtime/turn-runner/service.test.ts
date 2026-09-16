import type { AgentSessionEvent } from '@proj-airi/core-agent'

import { describe, expect, it, vi } from 'vitest'

import { createAgentSessionEventService } from '../session-events/service'
import { createAgentTurnRunner } from './service'

const userMessage = {
  content: 'hello',
  id: 'user-a',
  role: 'user' as const,
}

function createEventStore(initial: AgentSessionEvent[] = [], now: () => number = () => Date.now()) {
  const events = initial.map(event => structuredClone(event))
  const flush = vi.fn(async () => {})
  const service = createAgentSessionEventService({
    now,
    repository: {
      append: event => events.push(structuredClone(event)),
      compact: vi.fn(async () => events.map(event => structuredClone(event))),
      flush,
      load: () => events.map(event => structuredClone(event)),
    },
  })

  return {
    events,
    flush,
    service,
  }
}

describe('agent turn runner', () => {
  it('durably owns admission, cancellation, and terminal settlement', async () => {
    let now = 100
    const eventStore = createEventStore([], () => now++)
    const runner = await createAgentTurnRunner({
      eventStore: eventStore.service,
    })

    const started = await runner.start({
      assistantMessageId: 'assistant-a',
      sessionId: 'session-a',
      source: 'text',
      turnId: 'turn-a',
      userMessage,
      userMessageId: 'user-a',
      userText: 'hello',
    }, 'renderer-1')

    expect(started.status).toBe('running')
    expect(eventStore.flush).toHaveBeenCalledTimes(1)

    const checkpoint = runner.checkpoint({
      assistantMessageId: 'assistant-a',
      assistantText: 'partial answer',
      reasoningText: 'visible reasoning',
      sessionId: 'session-a',
      turnId: 'turn-a',
    }, 'renderer-1')
    expect(checkpoint.checkpoint?.revision).toBe(1)
    expect(eventStore.flush).toHaveBeenCalledTimes(1)

    const cancellation = await runner.requestCancellation({
      reason: 'user',
      sessionId: 'session-a',
      turnId: 'turn-a',
    })
    expect(cancellation.notices).toEqual([{
      reason: 'user',
      sessionId: 'session-a',
      turnId: 'turn-a',
    }])
    expect(cancellation.records[0]?.status).toBe('cancelling')
    expect(eventStore.flush).toHaveBeenCalledTimes(2)

    const settled = await runner.settle({
      assistantMessage: {
        content: 'partial answer',
        id: 'assistant-a',
        interrupted: true,
        role: 'assistant',
        slices: [{ text: 'partial answer', type: 'text' }],
        tool_results: [],
      },
      assistantMessageStatus: 'interrupted',
      finishReason: 'stop',
      sessionId: 'session-a',
      status: 'cancelled',
      turnId: 'turn-a',
    }, 'renderer-1')
    expect(settled.status).toBe('cancelled')
    expect(settled.finishReason).toBe('stop')
    expect(settled.checkpoint?.assistantText).toBe('partial answer')
    expect(eventStore.flush).toHaveBeenCalledTimes(3)
    expect(eventStore.events.map(event => event.type)).toEqual([
      'turn.admitted',
      'message.appended',
      'turn.checkpointed',
      'turn.cancellation-requested',
      'message.appended',
      'turn.closed',
    ])
    expect(eventStore.events.at(-1)).toMatchObject({
      payload: {
        finishReason: 'stop',
        status: 'cancelled',
        turnId: 'turn-a',
      },
      type: 'turn.closed',
    })
  })

  it('repairs open persisted turns and acknowledges recovered checkpoints', async () => {
    const eventStore = createEventStore([
      {
        occurredAt: 80,
        payload: {
          assistantMessageId: 'assistant-a',
          ownerId: 'renderer-old',
          sessionId: 'session-a',
          source: 'text',
          turnId: 'turn-a',
          userMessage,
          userMessageId: 'user-a',
          userText: 'hello',
        },
        sequence: 1,
        sessionId: 'session-a',
        type: 'turn.admitted',
      },
      {
        occurredAt: 90,
        payload: {
          checkpoint: {
            assistantMessageId: 'assistant-a',
            assistantText: 'recover me',
            revision: 2,
            sessionId: 'session-a',
            turnId: 'turn-a',
          },
        },
        sequence: 2,
        sessionId: 'session-a',
        type: 'turn.checkpointed',
      },
    ], () => 100)
    const runner = await createAgentTurnRunner({ eventStore: eventStore.service })

    expect(eventStore.flush).toHaveBeenCalledTimes(1)
    expect(runner.list({ recoverableOnly: true, sessionId: 'session-a' })).toEqual([
      expect.objectContaining({
        checkpoint: expect.objectContaining({
          assistantMessageId: 'assistant-a',
          assistantText: 'recover me',
          updatedAt: 90,
        }),
        interruptionReason: 'host-restarted',
        status: 'interrupted',
      }),
    ])

    const acknowledged = await runner.acknowledgeRecovery({
      assistantMessage: {
        content: 'recover me',
        id: 'assistant-a',
        interrupted: true,
        role: 'assistant',
        slices: [{ text: 'recover me', type: 'text' }],
        tool_results: [],
      },
      sessionId: 'session-a',
      turnId: 'turn-a',
    })
    expect(acknowledged.recoveredAt).toBe(100)
    expect(runner.list({ recoverableOnly: true, sessionId: 'session-a' })).toEqual([])
    expect(eventStore.flush).toHaveBeenCalledTimes(2)
    expect(eventStore.events.slice(-2).map(event => event.type)).toEqual([
      'message.appended',
      'turn.recovery-acknowledged',
    ])
  })

  it('isolates stale renderer updates and emits exact cancellation notices', async () => {
    const eventStore = createEventStore([], () => 100)
    const runner = await createAgentTurnRunner({ eventStore: eventStore.service })
    await runner.start({
      assistantMessageId: 'assistant-a',
      sessionId: 'session-a',
      source: 'voice',
      turnId: 'turn-a',
      userMessage,
      userMessageId: 'user-a',
      userText: 'hello',
    }, 'renderer-1')

    expect(() => runner.checkpoint({
      assistantMessageId: 'assistant-a',
      assistantText: 'stale output',
      sessionId: 'session-a',
      turnId: 'turn-a',
    }, 'renderer-old')).toThrow(/owner/i)

    await expect(runner.settle({
      sessionId: 'session-a',
      status: 'completed',
      turnId: 'turn-a',
    }, 'renderer-old')).rejects.toThrow(/owner/i)

    const cancellation = await runner.requestCancellation({ reason: 'session-reset' })
    expect(cancellation.notices).toEqual([{
      reason: 'session-reset',
      sessionId: 'session-a',
      turnId: 'turn-a',
    }])

    const interrupted = await runner.interruptOwner('renderer-1', 'renderer-detached')
    expect(interrupted).toEqual([
      expect.objectContaining({
        interruptionReason: 'renderer-detached',
        status: 'interrupted',
      }),
    ])
  })
})

import { describe, expect, it } from 'vitest'

import { AgentSessionEventLog } from './events'

describe('agentSessionEventLog', () => {
  it('hydrates persisted events and continues each session sequence', () => {
    const appended: unknown[] = []
    const initialEvents = [
      {
        occurredAt: 90,
        payload: {
          source: 'text' as const,
          turnId: 'turn-a',
        },
        sequence: 1,
        sessionId: 'session-a',
        type: 'turn.started' as const,
      },
    ]
    const log = new AgentSessionEventLog({
      initialEvents,
      now: () => 100,
      onAppend: event => appended.push(event),
    })

    initialEvents[0]!.payload.turnId = 'mutated-after-hydration'
    const event = log.append('session-a', 'turn.settled', {
      status: 'completed',
      turnId: 'turn-a',
    })

    expect(event.sequence).toBe(2)
    const restored = log.list('session-a')[0]
    expect(restored?.type).toBe('turn.started')
    if (restored?.type !== 'turn.started')
      throw new Error('Expected restored turn.started event')
    expect(restored.payload.turnId).toBe('turn-a')
    expect(appended).toEqual([event])
  })

  it('assigns independent monotonic sequences and supports cursor reads per session', () => {
    const timestamps = [100, 101, 102]
    const log = new AgentSessionEventLog({
      now: () => timestamps.shift() ?? 103,
    })

    log.append('session-a', 'turn.started', {
      source: 'text',
      turnId: 'turn-a',
    })
    log.append('session-b', 'turn.started', {
      source: 'self',
      turnId: 'turn-b',
    })
    log.append('session-a', 'message.appended', {
      message: {
        content: 'assistant response',
        id: 'assistant-a',
        role: 'assistant',
        slices: [{ text: 'assistant response', type: 'text' }],
        tool_results: [],
      },
      messageId: 'assistant-a',
      role: 'assistant',
      status: 'complete',
      turnId: 'turn-a',
    })

    expect(log.list('session-a')).toEqual([
      {
        occurredAt: 100,
        payload: {
          source: 'text',
          turnId: 'turn-a',
        },
        sequence: 1,
        sessionId: 'session-a',
        type: 'turn.started',
      },
      {
        occurredAt: 102,
        payload: {
          message: {
            content: 'assistant response',
            id: 'assistant-a',
            role: 'assistant',
            slices: [{ text: 'assistant response', type: 'text' }],
            tool_results: [],
          },
          messageId: 'assistant-a',
          role: 'assistant',
          status: 'complete',
          turnId: 'turn-a',
        },
        sequence: 2,
        sessionId: 'session-a',
        type: 'message.appended',
      },
    ])
    expect(log.list('session-a', 1)).toEqual([
      expect.objectContaining({
        sequence: 2,
        type: 'message.appended',
      }),
    ])
    expect(log.list('session-b')).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: 'turn.started',
      }),
    ])
  })

  it('returns snapshots that callers cannot use to mutate the event log', () => {
    const log = new AgentSessionEventLog()
    log.append('session-a', 'turn.settled', {
      status: 'completed',
      turnId: 'turn-a',
    })

    const snapshot = log.list('session-a')
    const event = snapshot[0]
    if (event?.type !== 'turn.settled')
      throw new Error('Expected turn.settled event')
    event.payload.turnId = 'mutated'

    const persisted = log.list('session-a')[0]
    if (persisted?.type !== 'turn.settled')
      throw new Error('Expected persisted turn.settled event')
    expect(persisted.payload.turnId).toBe('turn-a')
  })

  it('retains complete authored messages so replay does not depend on chat snapshots', () => {
    const log = new AgentSessionEventLog({ now: () => 100 })

    log.append('session-a', 'message.appended', {
      message: {
        content: 'Remember the complete visible message.',
        createdAt: 90,
        id: 'user-a',
        role: 'user',
      },
      messageId: 'user-a',
      role: 'user',
      status: 'complete',
      turnId: 'turn-a',
    })

    expect(log.list('session-a')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          message: expect.objectContaining({
            content: 'Remember the complete visible message.',
            id: 'user-a',
            role: 'user',
          }),
        }),
        type: 'message.appended',
      }),
    ])
  })

  it('keeps sequence ownership after replacing a compacted resident window', () => {
    const log = new AgentSessionEventLog({ now: () => 100 })
    log.append('session-a', 'turn.started', { source: 'text', turnId: 'turn-a' })
    log.append('session-a', 'turn.settled', { status: 'completed', turnId: 'turn-a' })
    const latest = log.append('session-a', 'memory.projected', { throughSequence: 2 })

    log.replaceSession('session-a', [latest])
    const appended = log.append('session-a', 'turn.started', { source: 'self', turnId: 'turn-b' })

    expect(log.list('session-a').map(event => event.sequence)).toEqual([3, 4])
    expect(appended.sequence).toBe(4)
  })
})

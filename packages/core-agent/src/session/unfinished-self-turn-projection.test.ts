import type { AgentSessionEvent } from './events'

import { describe, expect, it } from 'vitest'

import { projectUnfinishedSelfTurns } from './unfinished-self-turn-projection'

describe('projectUnfinishedSelfTurns', () => {
  it('retains an interrupted self turn and links an explicit continuation', () => {
    const events = [
      event(1, 'turn.admitted', {
        assistantMessageId: 'assistant-a',
        ownerId: 'renderer-a',
        sessionId: 'session-a',
        source: 'self',
        turnId: 'turn-a',
        userMessage: { content: 'Investigate the failure', id: 'user-a', role: 'user', source: 'self' },
        userMessageId: 'user-a',
        userText: 'Investigate the failure',
      }),
      event(2, 'turn.checkpointed', {
        checkpoint: {
          assistantMessageId: 'assistant-a',
          assistantText: 'I found the first clue.',
          reasoningText: 'Need to inspect the logs next.',
          revision: 1,
          sessionId: 'session-a',
          turnId: 'turn-a',
        },
      }),
      event(3, 'turn.interrupted', { reason: 'renderer-detached', turnId: 'turn-a' }),
      event(4, 'turn.admitted', {
        assistantMessageId: 'assistant-b',
        ownerId: 'renderer-b',
        resumesTurnId: 'turn-a',
        sessionId: 'session-a',
        source: 'self',
        turnId: 'turn-b',
        userMessage: { content: 'Investigate the failure', id: 'user-b', role: 'user', source: 'self' },
        userMessageId: 'user-b',
        userText: 'Investigate the failure',
      }),
    ] satisfies AgentSessionEvent[]

    expect(projectUnfinishedSelfTurns(events)).toEqual([expect.objectContaining({
      assistantText: 'I found the first clue.',
      resumedByTurnId: 'turn-b',
      state: 'resumed',
      terminalStatus: 'interrupted',
      turnId: 'turn-a',
    })])
  })

  it('does not project ordinary user turns or completed self turns', () => {
    const events = [
      event(1, 'turn.admitted', {
        assistantMessageId: 'assistant-a',
        ownerId: 'renderer-a',
        sessionId: 'session-a',
        source: 'self',
        turnId: 'turn-a',
        userMessage: { content: 'Continue', id: 'user-a', role: 'user', source: 'self' },
        userMessageId: 'user-a',
        userText: 'Continue',
      }),
      event(2, 'turn.closed', { status: 'completed', turnId: 'turn-a' }),
    ] satisfies AgentSessionEvent[]

    expect(projectUnfinishedSelfTurns(events)).toEqual([])
  })
})

function event<TType extends AgentSessionEvent['type']>(
  sequence: number,
  type: TType,
  payload: Extract<AgentSessionEvent, { type: TType }>['payload'],
): Extract<AgentSessionEvent, { type: TType }> {
  return {
    occurredAt: sequence * 100,
    payload,
    sequence,
    sessionId: 'session-a',
    type,
  } as Extract<AgentSessionEvent, { type: TType }>
}

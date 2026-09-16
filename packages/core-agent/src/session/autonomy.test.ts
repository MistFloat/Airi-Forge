import type { AgentSessionEvent } from './events'

import { describe, expect, it } from 'vitest'

import {
  foldAgentAutonomy,
  latestEveryOccurrence,
} from './autonomy'

function event<T extends AgentSessionEvent['type']>(
  sequence: number,
  type: T,
  payload: Extract<AgentSessionEvent, { type: T }>['payload'],
): Extract<AgentSessionEvent, { type: T }> {
  return {
    occurredAt: sequence * 100,
    payload,
    sequence,
    sessionId: 'session-a',
    type,
  } as Extract<AgentSessionEvent, { type: T }>
}

describe('agent autonomy projection', () => {
  it('replays a revisioned goal with rounds and a blocked reason', () => {
    const events = [
      event(1, 'goal.changed', {
        goal: {
          createdAt: 100,
          id: 'goal-a',
          maxRounds: 8,
          objective: 'Investigate why the desktop assistant loses continuity.',
          phase: 'active',
          revision: 1,
          rounds: 0,
          source: 'user',
          updatedAt: 100,
        },
        operation: 'create',
      }),
      event(2, 'goal.changed', {
        goal: {
          blockedReason: {
            code: 'provider-unavailable',
            message: 'The configured provider is unavailable.',
          },
          createdAt: 100,
          id: 'goal-a',
          maxRounds: 8,
          objective: 'Investigate why the desktop assistant loses continuity.',
          phase: 'blocked',
          revision: 2,
          rounds: 3,
          source: 'user',
          updatedAt: 200,
        },
        operation: 'block',
      }),
    ]

    expect(foldAgentAutonomy(events).goal).toEqual(expect.objectContaining({
      blockedReason: {
        code: 'provider-unavailable',
        message: 'The configured provider is unavailable.',
      },
      phase: 'blocked',
      revision: 2,
      rounds: 3,
    }))
  })

  it('replays schedule delivery from the same log', () => {
    const events = [
      event(1, 'schedule.changed', {
        operation: 'create',
        schedule: {
          createdAt: 100,
          id: 'schedule-a',
          kind: 'after',
          prompt: 'Continue the goal.',
          revision: 1,
          scheduledAt: 5_000,
          state: 'scheduled',
          updatedAt: 100,
        },
      }),
      event(2, 'schedule.changed', {
        operation: 'trigger',
        schedule: {
          createdAt: 100,
          dispatchId: 'dispatch-a',
          id: 'schedule-a',
          kind: 'after',
          occurrenceAt: 5_000,
          prompt: 'Continue the goal.',
          revision: 2,
          scheduledAt: 5_000,
          state: 'pending',
          updatedAt: 200,
        },
      }),
    ]

    const projection = foldAgentAutonomy(events)
    expect(projection.schedules).toEqual([
      expect.objectContaining({ dispatchId: 'dispatch-a', state: 'pending' }),
    ])
  })

  it('selects only the latest missed fixed-rate occurrence and preserves the creation anchor', () => {
    expect(latestEveryOccurrence({
      acceptedAt: 5_500,
      everyMs: 1_000,
      scheduledAt: 1_000,
    })).toEqual({
      nextScheduledAt: 6_000,
      occurrenceAt: 5_000,
    })
  })

  it('accepts a compacted full snapshot as the first resident revision', () => {
    const projection = foldAgentAutonomy([
      event(10, 'task.changed', {
        task: {
          id: 'task-a',
          objective: 'Continue after compaction.',
          revision: 7,
          state: 'running',
          updatedAt: 1_000,
        },
      }),
    ])

    expect(projection.tasks).toEqual([
      expect.objectContaining({ id: 'task-a', revision: 7, state: 'running' }),
    ])
  })
})

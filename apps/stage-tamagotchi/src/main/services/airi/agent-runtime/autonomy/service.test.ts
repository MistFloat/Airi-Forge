import type { AgentSessionEvent } from '@proj-airi/core-agent'

import { describe, expect, it, vi } from 'vitest'

import { createAgentSessionEventService } from '../session-events/service'
import { createAgentAutonomyService } from './service'

function createHarness(nowValue = 1_000) {
  let now = nowValue
  const events: AgentSessionEvent[] = []
  const flush = vi.fn(async () => {})
  const eventStore = createAgentSessionEventService({
    now: () => now,
    repository: {
      append: event => events.push(structuredClone(event)),
      compact: vi.fn(async () => events.map(event => structuredClone(event))),
      flush,
      load: () => events.map(event => structuredClone(event)),
    },
  })
  const service = createAgentAutonomyService({
    eventStore,
    now: () => now,
  })

  return {
    events,
    flush,
    now: {
      set(value: number) {
        now = value
      },
    },
    service,
  }
}

describe('agent autonomy service', () => {
  it('persists the complete Goal state machine with CAS revisions and rounds', async () => {
    const harness = createHarness()
    const created = await harness.service.putGoal({
      id: 'goal-a',
      maxRounds: 3,
      objective: 'Finish the durable desktop-agent migration.',
      sessionId: 'session-a',
      source: 'user',
    })
    expect(created).toEqual(expect.objectContaining({ phase: 'active', revision: 1, rounds: 0 }))

    const paused = await harness.service.transitionGoal({
      goalId: 'goal-a',
      revision: 1,
      sessionId: 'session-a',
      transition: 'pause',
    })
    expect(paused).toEqual(expect.objectContaining({ phase: 'paused', revision: 2 }))

    const resumed = await harness.service.transitionGoal({
      goalId: 'goal-a',
      revision: 2,
      sessionId: 'session-a',
      transition: 'resume',
    })
    const round = await harness.service.transitionGoal({
      goalId: 'goal-a',
      revision: resumed.revision,
      sessionId: 'session-a',
      transition: 'round',
    })
    expect(round).toEqual(expect.objectContaining({ phase: 'active', revision: 4, rounds: 1 }))

    await expect(harness.service.transitionGoal({
      goalId: 'goal-a',
      revision: 1,
      sessionId: 'session-a',
      transition: 'complete',
    })).rejects.toThrow(/revision/i)
    expect(harness.events.filter(event => event.type === 'goal.changed')).toHaveLength(4)
  })

  it('triggers after/at/every schedules as pending ordinary turns and catches up every only once', async () => {
    const harness = createHarness()
    const notices: unknown[] = []
    harness.service.subscribeDue(notice => notices.push(notice))

    await harness.service.createSchedule({
      afterMs: 5_000,
      id: 'after-a',
      kind: 'after',
      prompt: 'Continue after five seconds.',
      sessionId: 'session-a',
    })
    await harness.service.createSchedule({
      everyMs: 300_000,
      id: 'every-a',
      kind: 'every',
      prompt: 'Run the recurring check.',
      sessionId: 'session-a',
    })

    harness.now.set(1_001 + 4 * 300_000 + 10)
    await harness.service.drive()

    const projection = harness.service.get({ sessionId: 'session-a' })
    expect(projection.schedules).toEqual([
      expect.objectContaining({ id: 'after-a', occurrenceAt: 6_000, state: 'pending' }),
      expect.objectContaining({
        id: 'every-a',
        occurrenceAt: 1_201_000,
        scheduledAt: 1_501_000,
        state: 'pending',
      }),
    ])
    expect(notices).toHaveLength(2)
  })

  it('recovers claimed background delivery from events and completes its task projection', async () => {
    const harness = createHarness()
    await harness.service.createSchedule({
      afterMs: 1,
      id: 'schedule-a',
      kind: 'after',
      prompt: 'Resume in the background.',
      sessionId: 'session-a',
    })
    harness.now.set(1_001)
    await harness.service.drive()
    const pending = harness.service.get({ sessionId: 'session-a' }).schedules[0]
    if (!pending?.dispatchId)
      throw new Error('Expected pending dispatch')

    const claimed = await harness.service.claimSchedule({
      dispatchId: pending.dispatchId,
      scheduleId: pending.id,
      sessionId: 'session-a',
    }, 'renderer-a')
    expect(claimed?.state).toBe('claimed')

    await harness.service.settleSchedule({
      dispatchId: pending.dispatchId,
      scheduleId: pending.id,
      sessionId: 'session-a',
      status: 'completed',
    }, 'renderer-a')

    const projection = harness.service.get({ sessionId: 'session-a' })
    expect(projection.tasks).toEqual([
      expect.objectContaining({ id: pending.dispatchId, state: 'completed' }),
    ])
  })

  it('admits Goal rounds on claim and fails recoverably after round exhaustion', async () => {
    const harness = createHarness()
    const goal = await harness.service.putGoal({
      id: 'goal-limited',
      maxRounds: 1,
      objective: 'Run at most one autonomous continuation.',
      sessionId: 'session-a',
      source: 'self-prompt',
    })
    await harness.service.createSchedule({
      afterMs: 1,
      goal: { id: goal.id, revision: goal.revision },
      id: 'schedule-first',
      kind: 'after',
      prompt: 'First continuation.',
      sessionId: 'session-a',
    })
    harness.now.set(1_001)
    await harness.service.drive()
    const first = harness.service.get({ sessionId: 'session-a' }).schedules[0]
    if (!first?.dispatchId)
      throw new Error('Expected first dispatch')

    const claimed = await harness.service.claimSchedule({
      dispatchId: first.dispatchId,
      scheduleId: first.id,
      sessionId: 'session-a',
    }, 'renderer-a')
    expect(claimed?.goal).toEqual({ id: goal.id, revision: 2 })
    expect(harness.service.get({ sessionId: 'session-a' }).goal?.rounds).toBe(1)

    await harness.service.settleSchedule({
      dispatchId: first.dispatchId,
      scheduleId: first.id,
      sessionId: 'session-a',
      status: 'completed',
    }, 'renderer-a')
    await harness.service.createSchedule({
      afterMs: 1,
      goal: { id: goal.id, revision: 2 },
      id: 'schedule-exhausted',
      kind: 'after',
      prompt: 'This continuation exceeds the limit.',
      sessionId: 'session-a',
    })
    harness.now.set(1_002)
    await harness.service.drive()
    const exhausted = harness.service.get({ sessionId: 'session-a' }).schedules[1]
    if (!exhausted?.dispatchId)
      throw new Error('Expected exhausted dispatch')

    await expect(harness.service.claimSchedule({
      dispatchId: exhausted.dispatchId,
      scheduleId: exhausted.id,
      sessionId: 'session-a',
    }, 'renderer-a')).resolves.toBeUndefined()
    const projection = harness.service.get({ sessionId: 'session-a' })
    expect(projection.goal).toEqual(expect.objectContaining({
      blockedReason: expect.objectContaining({ code: 'round-limit-reached' }),
      phase: 'blocked',
    }))
    expect(projection.schedules[1]).toEqual(expect.objectContaining({ state: 'failed' }))
    expect(projection.tasks[1]).toEqual(expect.objectContaining({ state: 'failed' }))
  })
})

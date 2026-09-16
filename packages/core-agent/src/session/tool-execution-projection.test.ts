import type { AgentSessionEvent } from './events'

import { describe, expect, it } from 'vitest'

import { AgentSessionEventLog } from './events'
import { foldAgentToolExecutions, projectUnsettledToolExecutions } from './tool-execution-projection'

describe('tool execution projection', () => {
  it('projects a completed tool call with durable input and output', () => {
    const log = new AgentSessionEventLog({ now: () => 10 })
    log.append('session-a', 'tool.call-started', {
      callId: 'call-a',
      input: { city: 'Tokyo' },
      toolName: 'weather',
      turnId: 'turn-a',
    })
    log.append('session-a', 'tool.call-settled', {
      callId: 'call-a',
      durationMs: 25,
      output: { temperature: 22 },
      status: 'completed',
      toolName: 'weather',
      turnId: 'turn-a',
    })

    expect(foldAgentToolExecutions(log.list('session-a'))).toEqual([{
      callId: 'call-a',
      durationMs: 25,
      input: { city: 'Tokyo' },
      output: { temperature: 22 },
      sessionId: 'session-a',
      status: 'completed',
      toolName: 'weather',
      turnId: 'turn-a',
    }])
  })

  it('marks an admitted side effect uncertain when its turn is interrupted', () => {
    const log = new AgentSessionEventLog({ now: () => 10 })
    log.append('session-a', 'tool.call-started', {
      callId: 'call-a',
      input: { title: 'Meeting' },
      toolName: 'calendar_create',
      turnId: 'turn-a',
    })
    const interrupted = {
      occurredAt: 11,
      payload: { reason: 'renderer-detached', turnId: 'turn-a' },
      sequence: 2,
      sessionId: 'session-a',
      type: 'turn.interrupted',
    } satisfies AgentSessionEvent

    expect(foldAgentToolExecutions([...log.list('session-a'), interrupted])[0]?.status).toBe('uncertain')
  })

  it('projects an explicit restart reconciliation as an unsettled tool call', () => {
    const log = new AgentSessionEventLog({ now: () => 10 })
    log.append('session-a', 'tool.call-started', {
      callId: 'call-a',
      input: { title: 'Meeting' },
      toolName: 'calendar_create',
      turnId: 'turn-a',
    })
    log.append('session-a', 'tool.call-reconciled', {
      callId: 'call-a',
      reason: 'host-restarted',
      status: 'uncertain',
      toolName: 'calendar_create',
      turnId: 'turn-a',
    })

    expect(projectUnsettledToolExecutions(log.list('session-a'))).toEqual([
      expect.objectContaining({
        callId: 'call-a',
        sessionId: 'session-a',
        status: 'uncertain',
      }),
    ])
  })
})

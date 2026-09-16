import type { AgentTurnRecord } from '@proj-airi/core-agent'

import { createContext, defineInvoke } from '@moeru/eventa'
import { describe, expect, it, vi } from 'vitest'

import {
  electronAgentTurnAcknowledgeRecovery,
  electronAgentTurnCancel,
  electronAgentTurnCancellationRequested,
  electronAgentTurnCheckpoint,
  electronAgentTurnList,
  electronAgentTurnSettle,
  electronAgentTurnStart,
  electronAgentTurnStatus,
} from '../../../../../shared/eventa/agent-runtime'
import { registerAgentTurnHandlers } from './ipc'
import { parseAgentTurnStartInput } from './schemas'

const record = {
  assistantMessageId: 'assistant-a',
  ownerId: 'renderer-1',
  sessionId: 'session-a',
  source: 'text',
  startedAt: 10,
  status: 'running',
  turnId: 'turn-a',
  updatedAt: 10,
  userMessage: { content: 'hello', id: 'user-a', role: 'user' },
  userMessageId: 'user-a',
  userText: 'hello',
} satisfies AgentTurnRecord

describe('agent turn runner IPC', () => {
  it('validates commands, binds renderer ownership, and emits correlated cancellation', async () => {
    const context = createContext()
    const service = {
      acknowledgeRecovery: vi.fn(async () => ({ ...record, recoveredAt: 30, status: 'interrupted' as const })),
      checkpoint: vi.fn(() => record),
      interruptOwner: vi.fn(async () => []),
      list: vi.fn(() => [record]),
      requestCancellation: vi.fn(async () => ({
        notices: [{ reason: 'user' as const, sessionId: 'session-a', turnId: 'turn-a' }],
        records: [{ ...record, cancellationReason: 'user' as const, status: 'cancelling' as const }],
      })),
      settle: vi.fn(async () => ({ ...record, settledAt: 20, status: 'cancelled' as const })),
      start: vi.fn(async () => record),
      status: vi.fn(() => record),
    }
    const cancellationListener = vi.fn()
    const offCancellation = context.on(electronAgentTurnCancellationRequested, cancellationListener)
    const dispose = registerAgentTurnHandlers(context, service, () => 'renderer-1')

    const start = defineInvoke(context, electronAgentTurnStart)
    const checkpoint = defineInvoke(context, electronAgentTurnCheckpoint)
    const settle = defineInvoke(context, electronAgentTurnSettle)
    const cancel = defineInvoke(context, electronAgentTurnCancel)
    const status = defineInvoke(context, electronAgentTurnStatus)
    const list = defineInvoke(context, electronAgentTurnList)
    const acknowledge = defineInvoke(context, electronAgentTurnAcknowledgeRecovery)

    await expect(start({
      assistantMessageId: 'assistant-a',
      sessionId: 'session-a',
      source: 'text',
      turnId: 'turn-a',
      userMessage: { content: 'hello', id: 'user-a', role: 'user' },
      userMessageId: 'user-a',
      userText: 'hello',
    })).resolves.toEqual(record)
    expect(service.start).toHaveBeenCalledWith(expect.any(Object), 'renderer-1')

    await checkpoint({
      assistantMessageId: 'assistant-a',
      assistantText: 'partial',
      sessionId: 'session-a',
      turnId: 'turn-a',
    })
    expect(service.checkpoint).toHaveBeenCalledWith(expect.any(Object), 'renderer-1')

    await settle({ finishReason: 'length', sessionId: 'session-a', status: 'cancelled', turnId: 'turn-a' })
    expect(service.settle).toHaveBeenCalledWith({
      finishReason: 'length',
      sessionId: 'session-a',
      status: 'cancelled',
      turnId: 'turn-a',
    }, 'renderer-1')

    await expect(cancel({ reason: 'user', turnId: 'turn-a' })).resolves.toEqual([
      expect.objectContaining({ status: 'cancelling' }),
    ])
    expect(cancellationListener).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        reason: 'user',
        sessionId: 'session-a',
        turnId: 'turn-a',
      },
    }), undefined)

    await status({ sessionId: 'session-a' })
    await list({ recoverableOnly: true, sessionId: 'session-a' })
    await acknowledge({ sessionId: 'session-a', turnId: 'turn-a' })

    expect(() => parseAgentTurnStartInput({ source: 'invalid' })).toThrow()
    dispose()
    offCancellation()
  })
})

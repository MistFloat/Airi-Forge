import { createContext, defineInvoke } from '@moeru/eventa'
import { describe, expect, it, vi } from 'vitest'

import {
  electronAgentSessionEventAppend,
  electronAgentSessionEventsList,
  electronAgentToolExecutionClaim,
  electronAgentToolExecutionSettle,
} from '../../../../../shared/eventa/agent-runtime'
import { registerAgentSessionEventHandlers } from './ipc'
import { parseAgentToolExecutionClaimInput } from './schemas'

describe('agent session event IPC', () => {
  it('validates requests and routes typed Eventa invokes to the main service', async () => {
    const context = createContext()
    const event = {
      occurredAt: 100,
      payload: {
        throughSequence: 1,
      },
      sequence: 1,
      sessionId: 'session-a',
      type: 'memory.projected' as const,
    }
    const claimResult = { disposition: 'execute' as const }
    const service = {
      append: vi.fn(() => event),
      claimToolExecution: vi.fn(async () => claimResult),
      flush: vi.fn(async () => {}),
      list: vi.fn(() => [event]),
      listAll: vi.fn(() => [event]),
      settleToolExecution: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
    }
    const dispose = registerAgentSessionEventHandlers(context, service)
    const append = defineInvoke(context, electronAgentSessionEventAppend)
    const list = defineInvoke(context, electronAgentSessionEventsList)
    const claim = defineInvoke(context, electronAgentToolExecutionClaim)
    const settle = defineInvoke(context, electronAgentToolExecutionSettle)
    const toolInput = {
      callId: 'call-a',
      input: { path: 'README.md' },
      sessionId: 'session-a',
      toolName: 'read_file',
      turnId: 'turn-a',
    }

    await expect(append({
      payload: event.payload,
      sessionId: event.sessionId,
      type: event.type,
    })).resolves.toEqual(event)
    await expect(list({ afterSequence: 0, sessionId: 'session-a' })).resolves.toEqual([event])
    await expect(claim(toolInput)).resolves.toEqual(claimResult)
    await expect(settle({
      ...toolInput,
      durationMs: 5,
      output: { content: 'done' },
      status: 'completed',
    })).resolves.toBeUndefined()
    expect(service.append).toHaveBeenCalledWith({
      payload: event.payload,
      sessionId: event.sessionId,
      type: event.type,
    })
    expect(service.list).toHaveBeenCalledWith({
      afterSequence: 0,
      sessionId: 'session-a',
    })
    expect(service.claimToolExecution).toHaveBeenCalledWith(toolInput)

    expect(() => parseAgentToolExecutionClaimInput({
      callId: '',
      input: null,
      sessionId: 'session-a',
      toolName: '',
      turnId: 'turn-a',
    })).toThrow()

    dispose()
  })
})

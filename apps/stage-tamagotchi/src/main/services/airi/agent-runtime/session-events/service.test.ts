import type { AgentSessionEvent, AgentSessionEventInput } from '@proj-airi/core-agent'

import { describe, expect, it, vi } from 'vitest'

import { createAgentSessionEventService } from './service'

describe('agent session event service', () => {
  it('continues the main-process sequence when a new renderer producer connects', () => {
    const persisted = [
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
      {
        occurredAt: 91,
        payload: {
          message: {
            content: 'hello',
            id: 'user-a',
            role: 'user' as const,
          },
          messageId: 'user-a',
          role: 'user' as const,
          status: 'complete' as const,
          turnId: 'turn-a',
        },
        sequence: 2,
        sessionId: 'session-a',
        type: 'message.appended' as const,
      },
    ] satisfies AgentSessionEvent[]
    const append = vi.fn<(event: AgentSessionEvent) => void>()
    const service = createAgentSessionEventService({
      now: () => 100,
      repository: {
        append,
        compact: vi.fn(async () => persisted),
        flush: vi.fn(async () => {}),
        load: () => persisted,
      },
    })
    const next = {
      payload: {
        status: 'completed' as const,
        turnId: 'turn-a',
      },
      sessionId: 'session-a',
      type: 'turn.settled' as const,
    } satisfies AgentSessionEventInput

    const event = service.append(next)

    expect(event).toEqual({
      occurredAt: 100,
      payload: next.payload,
      sequence: 3,
      sessionId: 'session-a',
      type: 'turn.settled',
    })
    expect(append).toHaveBeenCalledWith(event)
    expect(service.list({ afterSequence: 2, sessionId: 'session-a' })).toEqual([event])
  })

  it('keeps sequences isolated between sessions', () => {
    const service = createAgentSessionEventService({
      repository: {
        append: vi.fn(),
        compact: vi.fn(async () => []),
        flush: vi.fn(async () => {}),
        load: () => [],
      },
    })

    const first = service.append({
      payload: { source: 'text', turnId: 'turn-a' },
      sessionId: 'session-a',
      type: 'turn.started',
    })
    const second = service.append({
      payload: { source: 'voice', turnId: 'turn-b' },
      sessionId: 'session-b',
      type: 'turn.started',
    })

    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(1)
  })

  it('atomically replays a completed tool call instead of executing it twice', async () => {
    const persisted: AgentSessionEvent[] = []
    const service = createAgentSessionEventService({
      now: () => 100,
      repository: {
        append: event => persisted.push(structuredClone(event)),
        compact: vi.fn(async () => persisted),
        flush: vi.fn(async () => {}),
        load: () => persisted,
      },
    })
    const input = {
      callId: 'call-a',
      input: { path: 'README.md' },
      sessionId: 'session-a',
      toolName: 'write_file',
      turnId: 'turn-a',
    }

    await expect(Promise.all([
      service.claimToolExecution(input),
      service.claimToolExecution(input),
    ])).resolves.toEqual([
      { disposition: 'execute' },
      { disposition: 'blocked', status: 'running' },
    ])

    await service.settleToolExecution({
      ...input,
      durationMs: 12,
      output: { content: 'done' },
      status: 'completed',
    })
    await expect(service.claimToolExecution(input)).resolves.toEqual({
      disposition: 'replay',
      output: { content: 'done' },
      status: 'completed',
    })
    expect(persisted.map(event => event.type)).toEqual([
      'tool.call-started',
      'tool.call-settled',
    ])
  })

  it('blocks calls whose side effects became uncertain after interruption', async () => {
    const persisted: AgentSessionEvent[] = []
    const service = createAgentSessionEventService({
      repository: {
        append: event => persisted.push(structuredClone(event)),
        compact: vi.fn(async () => persisted),
        flush: vi.fn(async () => {}),
        load: () => persisted,
      },
    })
    const input = {
      callId: 'call-a',
      input: { id: 'record-a' },
      sessionId: 'session-a',
      toolName: 'delete_record',
      turnId: 'turn-a',
    }

    await service.claimToolExecution(input)
    service.append({
      payload: { reason: 'renderer-detached', turnId: 'turn-a' },
      sessionId: 'session-a',
      type: 'turn.interrupted',
    })

    await expect(service.claimToolExecution(input)).resolves.toEqual({
      disposition: 'blocked',
      status: 'uncertain',
    })
  })

  it('reconciles a tool left running by the previous process before accepting retries', async () => {
    const persisted: AgentSessionEvent[] = [{
      occurredAt: 90,
      payload: {
        callId: 'call-a',
        input: { id: 'record-a' },
        toolName: 'create_record',
        turnId: 'turn-a',
      },
      sequence: 1,
      sessionId: 'session-a',
      type: 'tool.call-started',
    }]
    const service = createAgentSessionEventService({
      now: () => 100,
      repository: {
        append: event => persisted.push(structuredClone(event)),
        compact: vi.fn(async () => persisted),
        flush: vi.fn(async () => {}),
        load: () => persisted,
      },
    })
    const input = {
      callId: 'call-a',
      input: { id: 'record-a' },
      sessionId: 'session-a',
      toolName: 'create_record',
      turnId: 'turn-a',
    }

    await expect(service.claimToolExecution(input)).resolves.toEqual({
      disposition: 'blocked',
      status: 'uncertain',
    })
    expect(persisted.at(-1)).toEqual({
      occurredAt: 100,
      payload: {
        callId: 'call-a',
        reason: 'host-restarted',
        status: 'uncertain',
        toolName: 'create_record',
        turnId: 'turn-a',
      },
      sequence: 2,
      sessionId: 'session-a',
      type: 'tool.call-reconciled',
    })
  })

  it('evicts consumed conversation facts while retaining control state and the recent UI window', async () => {
    const persisted: AgentSessionEvent[] = []
    const compact = vi.fn(async (input: { retainedSequences: readonly number[], throughSequence: number }) => (
      persisted.filter(event => (
        event.sequence > input.throughSequence
        || input.retainedSequences.includes(event.sequence)
      ))
    ))
    const service = createAgentSessionEventService({
      now: () => 100,
      recentMessageLimit: 1,
      repository: {
        append: event => persisted.push(structuredClone(event)),
        compact,
        flush: vi.fn(async () => {}),
        load: () => persisted,
      },
    })
    service.append({
      payload: {
        assistantMessageId: 'assistant-control',
        ownerId: 'renderer-control',
        sessionId: 'session-a',
        source: 'text',
        turnId: 'control-turn',
        userMessage: {
          content: 'control',
          id: 'user-control',
          role: 'user',
        },
        userMessageId: 'user-control',
        userText: 'control',
      },
      sessionId: 'session-a',
      type: 'turn.admitted',
    })
    service.append({
      payload: {
        message: { content: 'old', id: 'user-a', role: 'user' },
        messageId: 'user-a',
        role: 'user',
        status: 'complete',
        turnId: 'turn-a',
      },
      sessionId: 'session-a',
      type: 'message.appended',
    })
    service.append({
      payload: {
        message: {
          content: 'recent',
          id: 'assistant-a',
          role: 'assistant',
          slices: [{ text: 'recent', type: 'text' }],
          tool_results: [],
        },
        messageId: 'assistant-a',
        role: 'assistant',
        status: 'complete',
        turnId: 'turn-a',
      },
      sessionId: 'session-a',
      type: 'message.appended',
    })
    service.append({
      payload: { throughSequence: 3 },
      sessionId: 'session-a',
      type: 'memory.projected',
    })

    await service.flush()

    expect(compact).toHaveBeenCalledWith({
      retainedSequences: [1, 3],
      sessionId: 'session-a',
      throughSequence: 3,
    })
    expect(service.list({ sessionId: 'session-a' }).map(event => event.sequence)).toEqual([1, 3, 4])
  })
})

import type { AgentSessionEvent } from '@proj-airi/core-agent'
import type { ChatWritableSessionEventInput } from '@proj-airi/stage-ui/stores/chat-session-events'

import {
  appendChatSessionEvent,
  configureChatSessionEventProjector,
  configureChatSessionEventReader,
  configureChatSessionEventWriter,
  configureChatSessionMessageImporter,
  createChatSessionEventPort,
  readChatSessionEvents,
} from '@proj-airi/stage-ui/stores/chat-session-events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initializeAgentSessionEventBridge } from './agent-session-events'

describe('agent session event renderer bridge', () => {
  afterEach(() => {
    configureChatSessionEventProjector()
    configureChatSessionEventReader()
    configureChatSessionEventWriter()
    configureChatSessionMessageImporter()
  })

  it('serializes projections before reading the authoritative stream', async () => {
    const inputs: ChatWritableSessionEventInput[] = []
    const authoritativeEvents: AgentSessionEvent[] = []
    const append = vi.fn(async (input: ChatWritableSessionEventInput) => {
      inputs.push(input)
      const occurredAt = 100 + authoritativeEvents.length
      const sequence = authoritativeEvents.length + 1
      let event: AgentSessionEvent
      switch (input.type) {
        case 'memory.projected':
          event = { ...input, occurredAt, sequence }
          break
        case 'message.appended':
          event = { ...input, occurredAt, sequence }
          break
        case 'prompt.composed':
          event = { ...input, occurredAt, sequence }
          break
        case 'visual.observed':
          event = { ...input, occurredAt, sequence }
          break
        default: {
          const unexpected: never = input
          throw new Error(`Unexpected renderer event ${String(unexpected)}`)
        }
      }
      authoritativeEvents.push(event)
      return event
    })
    const list = vi.fn(async () => structuredClone(authoritativeEvents))
    const importMessages = vi.fn(async (messages: ChatWritableSessionEventInput[]) => (
      await Promise.all(messages.map(message => append(message)))
    ))
    const dispose = initializeAgentSessionEventBridge({ append, importMessages, list })
    const port = createChatSessionEventPort()

    await port.append('session-a', 'prompt.composed', {
      messages: [{ content: 'hello', role: 'user' }],
      turnId: 'turn-a',
    })
    await port.append('session-a', 'memory.projected', {
      throughSequence: 1,
    })

    await expect(readChatSessionEvents(
      { sessionId: 'session-a' },
      [],
    )).resolves.toHaveLength(2)
    expect(inputs).toEqual([
      {
        payload: { messages: [{ content: 'hello', role: 'user' }], turnId: 'turn-a' },
        sessionId: 'session-a',
        type: 'prompt.composed',
      },
      {
        payload: { throughSequence: 1 },
        sessionId: 'session-a',
        type: 'memory.projected',
      },
    ])
    expect(list).toHaveBeenCalledAfter(append)

    await appendChatSessionEvent({
      payload: {
        capturedAt: 200,
        contextId: 'vision:screen',
        observationId: 'observation-1',
        summary: 'A window is open',
        workloadId: 'screen:interpret',
      },
      sessionId: 'session-a',
      type: 'visual.observed',
    })
    expect(inputs.at(-1)?.type).toBe('visual.observed')

    dispose()
  })
})

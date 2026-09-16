import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configureChatSessionEventProjector,
  configureChatSessionEventReader,
  configureChatSessionMessageImporter,
  createChatSessionEventPort,
  createImportedMessageEvents,
  readChatSessionEvents,
} from './chat-session-events'

describe('chat session events', () => {
  afterEach(() => {
    configureChatSessionEventReader()
    configureChatSessionEventProjector()
    configureChatSessionMessageImporter()
    vi.restoreAllMocks()
  })

  it('rejects an admitted runtime event when the durable projector fails', async () => {
    const projectionError = new Error('main process unavailable')
    const project = vi.fn(async () => {
      throw projectionError
    })
    configureChatSessionEventProjector(project)
    const port = createChatSessionEventPort()

    await expect(port.append('session-a', 'prompt.composed', {
      messages: [{ content: 'hello', role: 'user' }],
      turnId: 'turn-a',
    })).rejects.toBe(projectionError)
    expect(project).toHaveBeenCalledTimes(1)
    expect(port.list('session-a')).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: 'prompt.composed',
      }),
    ])
  })

  it('stops projecting after the owning desktop bridge is disposed', async () => {
    const project = vi.fn(async () => {})
    const dispose = configureChatSessionEventProjector(project)
    const port = createChatSessionEventPort()

    await port.append('session-a', 'prompt.composed', {
      messages: [{ content: 'hello', role: 'user' }],
      turnId: 'turn-a',
    })
    dispose()
    await port.append('session-a', 'visual.observed', {
      capturedAt: 100,
      contextId: 'screen',
      observationId: 'observation-a',
      summary: 'A code editor is visible.',
      workloadId: 'vision-a',
    })

    expect(project).toHaveBeenCalledTimes(1)
  })

  it('keeps synchronous local event appends for hosts without a projector', () => {
    const port = createChatSessionEventPort()

    const event = port.append('session-a', 'prompt.composed', {
      messages: [{ content: 'hello', role: 'user' }],
      turnId: 'turn-a',
    })

    expect(event).toMatchObject({ sequence: 1, type: 'prompt.composed' })
  })

  it('reads the platform-owned stream when a desktop reader is installed', async () => {
    const authoritativeEvent = {
      occurredAt: 200,
      payload: { source: 'text' as const, turnId: 'turn-main' },
      sequence: 8,
      sessionId: 'session-a',
      type: 'turn.started' as const,
    }
    const read = vi.fn(async () => [authoritativeEvent])
    configureChatSessionEventReader(read)

    await expect(readChatSessionEvents(
      { afterSequence: 7, sessionId: 'session-a' },
      [],
    )).resolves.toEqual([authoritativeEvent])
    expect(read).toHaveBeenCalledWith({ afterSequence: 7, sessionId: 'session-a' })
  })

  it('falls back to renderer events when the platform reader is unavailable', async () => {
    const localEvent = {
      occurredAt: 100,
      payload: { status: 'completed' as const, turnId: 'turn-local' },
      sequence: 1,
      sessionId: 'session-a',
      type: 'turn.settled' as const,
    }
    const readError = new Error('main process unavailable')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    configureChatSessionEventReader(async () => {
      throw readError
    })

    await expect(readChatSessionEvents(
      { sessionId: 'session-a' },
      [localEvent],
    )).resolves.toEqual([localEvent])
    expect(errorSpy).toHaveBeenCalledWith('Failed to read Agent session events:', readError)
  })

  it('pairs imported authored history into stable event-derived turns', () => {
    const events = createImportedMessageEvents('session-a', [
      { content: 'Question', id: 'user-a', role: 'user' },
      {
        content: 'Partial answer',
        id: 'assistant-a',
        interrupted: true,
        role: 'assistant',
        slices: [{ text: 'Partial answer', type: 'text' }],
        tool_results: [],
      },
      { content: 'Next question', id: 'user-b', role: 'user' },
    ], 'import')

    expect(events.map(event => ({
      messageId: event.payload.messageId,
      origin: event.payload.origin,
      status: event.payload.status,
      turnId: event.payload.turnId,
    }))).toEqual([
      { messageId: 'user-a', origin: 'import', status: 'complete', turnId: 'import:import:user-a' },
      { messageId: 'assistant-a', origin: 'import', status: 'interrupted', turnId: 'import:import:user-a' },
      { messageId: 'user-b', origin: 'import', status: 'complete', turnId: 'import:import:user-b' },
    ])
  })
})

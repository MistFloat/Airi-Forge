import type { AgentTurnCancellationNotice, AgentTurnRecord } from '@proj-airi/core-agent'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  acknowledgeChatTurnRecovery,
  configureChatTurnCancellationHandler,
  configureChatTurnTransport,
  createChatTurnControlPort,
  dispatchChatTurnCancellation,
  listChatTurns,
  requestChatTurnCancellation,
} from './chat-turn-control'

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

function createTransport() {
  return {
    acknowledgeRecovery: vi.fn(async () => ({ ...record, recoveredAt: 20, status: 'interrupted' as const })),
    cancel: vi.fn(async () => [{ ...record, status: 'cancelling' as const }]),
    checkpoint: vi.fn(async () => record),
    list: vi.fn(async () => [record]),
    settle: vi.fn(async () => ({ ...record, settledAt: 20, status: 'completed' as const })),
    start: vi.fn(async () => record),
    status: vi.fn(async () => record),
  }
}

describe('chat turn control facade', () => {
  afterEach(() => {
    configureChatTurnCancellationHandler()
    configureChatTurnTransport()
    vi.restoreAllMocks()
  })

  it('stops renderer execution when an installed durability control plane is unavailable', async () => {
    const transport = createTransport()
    const failure = new Error('main process unavailable')
    transport.start.mockRejectedValue(failure)
    configureChatTurnTransport(transport)
    const port = createChatTurnControlPort()

    await expect(port.start({
      assistantMessageId: 'assistant-a',
      sessionId: 'session-a',
      source: 'text',
      turnId: 'turn-a',
      userMessage: { content: 'hello', id: 'user-a', role: 'user' },
      userMessageId: 'user-a',
      userText: 'hello',
    })).rejects.toBe(failure)
  })

  it('uses ownership-safe transport disposal and exposes recovery commands', async () => {
    const first = createTransport()
    const second = createTransport()
    const disposeFirst = configureChatTurnTransport(first)
    configureChatTurnTransport(second)
    disposeFirst()

    await expect(listChatTurns({ recoverableOnly: true })).resolves.toEqual([record])
    await requestChatTurnCancellation({ reason: 'user', turnId: 'turn-a' })
    await acknowledgeChatTurnRecovery({ sessionId: 'session-a', turnId: 'turn-a' })

    expect(first.list).not.toHaveBeenCalled()
    expect(second.list).toHaveBeenCalledWith({ recoverableOnly: true })
    expect(second.cancel).toHaveBeenCalledWith({ reason: 'user', turnId: 'turn-a' })
    expect(second.acknowledgeRecovery).toHaveBeenCalledWith({ sessionId: 'session-a', turnId: 'turn-a' })
  })

  it('dispatches exact cancellation notices only to the active handler', () => {
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = configureChatTurnCancellationHandler(first)
    configureChatTurnCancellationHandler(second)
    disposeFirst()
    const notice = {
      reason: 'session-reset',
      sessionId: 'session-a',
      turnId: 'turn-a',
    } satisfies AgentTurnCancellationNotice

    dispatchChatTurnCancellation(notice)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(notice)
  })
})

import type { AgentTurnCancellationNotice, AgentTurnRecord } from '@proj-airi/core-agent'

import {
  configureChatTurnCancellationHandler,
  configureChatTurnTransport,
  listChatTurns,
} from '@proj-airi/stage-ui/stores/chat-turn-control'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initializeAgentTurnRunnerBridge } from './agent-turn-runner'

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

describe('agent turn runner bridge', () => {
  afterEach(() => {
    configureChatTurnCancellationHandler()
    configureChatTurnTransport()
  })

  it('connects renderer commands and exact cancellation pushes', async () => {
    let cancellationListener: ((notice: AgentTurnCancellationNotice) => void) | undefined
    const unsubscribe = vi.fn()
    const bindings = {
      acknowledgeRecovery: vi.fn(async () => record),
      cancel: vi.fn(async () => [record]),
      checkpoint: vi.fn(async () => record),
      list: vi.fn(async () => [record]),
      settle: vi.fn(async () => record),
      start: vi.fn(async () => record),
      status: vi.fn(async () => record),
      subscribeCancellation: (listener: (notice: AgentTurnCancellationNotice) => void) => {
        cancellationListener = listener
        return unsubscribe
      },
    }
    const handler = vi.fn()
    configureChatTurnCancellationHandler(handler)
    const dispose = initializeAgentTurnRunnerBridge(bindings)

    await expect(listChatTurns({ sessionId: 'session-a' })).resolves.toEqual([record])
    cancellationListener?.({ reason: 'user', sessionId: 'session-a', turnId: 'turn-a' })
    expect(handler).toHaveBeenCalledWith({ reason: 'user', sessionId: 'session-a', turnId: 'turn-a' })

    dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await expect(listChatTurns({ sessionId: 'session-a' })).resolves.toEqual([])
  })
})

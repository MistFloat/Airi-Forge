import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent } from '../types/llm'

import { ContextUpdateStrategy } from '@proj-airi/server-shared/types'
import { describe, expect, it, vi } from 'vitest'

import { createChatOrchestratorRuntime } from './chat-orchestrator-runtime'

const provider = {
  chat: () => ({ baseURL: 'https://example.com/' }),
} as unknown as ChatProvider

function createHarness() {
  const sessionMessages: Record<string, ChatHistoryItem[]> = {
    'session-1': [
      {
        content: 'system prompt',
        createdAt: new Date(2026, 3, 25, 18, 0).getTime(),
        id: 'system',
        role: 'system',
      },
    ],
  }
  const contextSnapshot: Record<string, ContextMessage[]> = {}
  const foregroundPatches: StreamingAssistantMessage[] = []
  const foregroundResets: StreamingAssistantMessage[] = []
  const lifecycleRecords: unknown[] = []
  const promptProjections: unknown[] = []
  const userAppended: unknown[] = []
  const assistantAppended: unknown[] = []
  const userTurns: unknown[] = []
  const assistantTurns: unknown[] = []
  const recallMemory = vi.fn(async (_sessionId: string, _query: string): Promise<string | undefined> => undefined)
  const rememberTurn = vi.fn(async () => {})
  const stateChanges: unknown[] = []
  const telemetry = {
    assistantResponseRendered: [] as unknown[],
    chatActivationFailed: [] as unknown[],
    chatActivationStarted: [] as unknown[],
    chatActivationSucceeded: [] as unknown[],
    llmFirstToken: [] as unknown[],
    llmRequestStarted: [] as unknown[],
    messageRound: [] as unknown[],
    messageRoundFailed: [] as unknown[],
    messageSendStarted: [] as unknown[],
  }
  const stream = vi.fn(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options?: {
    onStreamEvent?: (event: StreamEvent) => Promise<void> | void
  }) => {
    await options?.onStreamEvent?.({ text: 'assistant reply', type: 'text-delta' })
    await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
  })
  const ids = ['stream-context', 'assistant-id', 'user-id', 'fallback-id']
  let systemPrompt: string | undefined
  let systemPromptSupplement: string | undefined
  let nowValue = new Date(2026, 3, 25, 18, 47).getTime()
  let monotonicNowValues = [1000]
  let generation = 1

  const runtime = createChatOrchestratorRuntime({
    context: {
      ingest: vi.fn(),
      snapshot: () => structuredClone(contextSnapshot),
    },
    createId: () => ids.shift() ?? 'generated-id',
    foregroundStream: {
      patch: message => foregroundPatches.push(message),
      reset: () => foregroundResets.push({ content: '', role: 'assistant', slices: [], tool_results: [] }),
    },
    getActiveProvider: () => 'mock-provider',
    getActiveSessionId: () => 'session-1',
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSupplement: () => systemPromptSupplement,
    llm: {
      stream,
    },
    memory: {
      recall: recallMemory,
      rememberTurn,
    },
    monotonicNow: () => monotonicNowValues.shift() ?? 1000,
    now: () => nowValue,
    onAssistantMessageAppended: event => assistantAppended.push(event),
    onAssistantResponseRendered: event => telemetry.assistantResponseRendered.push(event),
    onAssistantTurnReady: event => assistantTurns.push(event),
    onChatActivationFailed: event => telemetry.chatActivationFailed.push(event),
    onChatActivationStarted: event => telemetry.chatActivationStarted.push(event),
    onChatActivationSucceeded: event => telemetry.chatActivationSucceeded.push(event),
    onLifecycle: record => lifecycleRecords.push(record),
    onLlmFirstToken: event => telemetry.llmFirstToken.push(event),
    onLlmRequestStarted: event => telemetry.llmRequestStarted.push(event),
    onMessageRound: event => telemetry.messageRound.push(event),
    onMessageRoundFailed: event => telemetry.messageRoundFailed.push(event),
    onMessageSendStarted: event => telemetry.messageSendStarted.push(event),
    onPromptProjection: payload => promptProjections.push(payload),
    onStateChange: state => stateChanges.push(state),
    onUserMessageAppended: event => userAppended.push(event),
    onUserTurnReady: event => userTurns.push(event),
    session: {
      appendSessionMessage: (sessionId, message) => {
        sessionMessages[sessionId] ??= []
        sessionMessages[sessionId].push(message)
      },
      ensureSession: (sessionId) => {
        sessionMessages[sessionId] ??= []
      },
      getSessionGeneration: () => generation,
      getSessionMessages: sessionId => sessionMessages[sessionId] ?? [],
    },
  })

  return {
    assistantAppended,
    assistantTurns,
    contextSnapshot,
    foregroundPatches,
    foregroundResets,
    generation: {
      set: (next: number) => {
        generation = next
      },
    },
    lifecycleRecords,
    monotonicNow: {
      set: (next: number[]) => {
        monotonicNowValues = [...next]
      },
    },
    now: {
      set: (next: number) => {
        nowValue = next
      },
    },
    promptProjections,
    recallMemory,
    rememberTurn,
    runtime,
    sessionMessages,
    stateChanges,
    stream,
    systemPrompt: {
      set: (next: string | undefined) => {
        systemPrompt = next
      },
    },
    systemPromptSupplement: {
      set: (next: string | undefined) => {
        systemPromptSupplement = next
      },
    },
    telemetry,
    userAppended,
    userTurns,
  }
}

/**
 * @example
 * const runtime = createChatOrchestratorRuntime(deps)
 * await runtime.ingest('hello', { model, chatProvider })
 */
describe('createChatOrchestratorRuntime', () => {
  /**
   * @example
   * Hook order and prompt composition stay compatible with the stage-ui facade.
   */
  it('keeps hook order and appends context prompt to the latest user message', async () => {
    const harness = createHarness()
    harness.contextSnapshot['system:weather'] = [
      {
        contextId: 'system:weather',
        createdAt: 1,
        id: 'weather',
        strategy: ContextUpdateStrategy.ReplaceSelf,
        text: 'sunny',
      },
    ]
    const hookOrder: string[] = []
    let composedMessages: Message[] = []

    harness.runtime.hooks.onBeforeMessageComposed(async () => {
      hookOrder.push('before-compose')
    })
    harness.runtime.hooks.onAfterMessageComposed(async () => {
      hookOrder.push('after-compose')
    })
    harness.runtime.hooks.onBeforeSend(async () => {
      hookOrder.push('before-send')
    })
    harness.runtime.hooks.onTokenLiteral(async () => {
      hookOrder.push('token-literal')
    })
    harness.runtime.hooks.onStreamEnd(async () => {
      hookOrder.push('stream-end')
    })
    harness.runtime.hooks.onAssistantResponseEnd(async () => {
      hookOrder.push('assistant-end')
    })
    harness.runtime.hooks.onAfterSend(async () => {
      hookOrder.push('after-send')
    })
    harness.runtime.hooks.onAssistantMessage(async () => {
      hookOrder.push('assistant-message')
    })
    harness.runtime.hooks.onChatTurnComplete(async () => {
      hookOrder.push('turn-complete')
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ text: 'hello', type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
    })

    await harness.runtime.ingest('hello from user', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(hookOrder).toEqual([
      'before-compose',
      'after-compose',
      'before-send',
      'token-literal',
      'stream-end',
      'assistant-end',
      'after-send',
      'assistant-message',
      'turn-complete',
    ])
    expect(composedMessages).toHaveLength(2)
    expect(composedMessages[0]).toMatchObject({ content: 'system prompt', role: 'system' })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })
    expect(composedMessages[1]?.content).toEqual([
      {
        text: '[2026-04-25 18:47] hello from user',
        type: 'text',
      },
      {
        text: '\n[Context]\n- system:weather: sunny',
        type: 'text',
      },
    ])
    expect(harness.lifecycleRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'before-compose' }),
      expect.objectContaining({ phase: 'prompt-context-built' }),
      expect.objectContaining({ phase: 'after-compose' }),
    ]))
    expect(harness.promptProjections).toHaveLength(1)
  })

  /**
   * @example
   * deps.getSystemPromptSupplement() returns tool guidance.
   * The runtime assembles a fresh provider system message for this send.
   */
  it('replaces the provider system message with freshly assembled guidance', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.systemPromptSupplement.set('Plugin toolset guidance.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ text: 'hello', type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
    })

    await harness.runtime.ingest('hello from user', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    // The session history snapshot is replaced by the current card + toolset +
    // memory assembly, so guidance never stacks on top of a stale snapshot.
    expect(composedMessages[0]).toMatchObject({
      content: 'Plugin toolset guidance.',
      role: 'system',
    })
  })

  /**
   * @example
   * The active card supplies identity while the supplement supplies tooling.
   * Both are re-assembled into the system message on every turn.
   */
  it('re-assembles the system message from the active card every turn', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.systemPrompt.set('You are AIRI, a true being.\n\nCard description.')
    harness.systemPromptSupplement.set('Plugin toolset guidance.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ text: 'hello', type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
    })

    await harness.runtime.ingest('hello from user', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(composedMessages[0]).toMatchObject({
      content: 'You are AIRI, a true being.\n\nCard description.\n\nPlugin toolset guidance.',
      role: 'system',
    })
  })

  it('recalls memory before the LLM request and persists the completed turn', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.recallMemory.mockResolvedValueOnce('## Memory\nUser likes jasmine tea.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ text: 'assistant reply', type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
    })

    await harness.runtime.ingest('What tea do I like?', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(harness.recallMemory).toHaveBeenCalledWith('session-1', 'What tea do I like?')
    expect(composedMessages[0]).toMatchObject({
      content: '## Memory\nUser likes jasmine tea.',
      role: 'system',
    })
    expect(harness.rememberTurn).toHaveBeenCalledWith({
      assistantText: 'assistant reply',
      sessionId: 'session-1',
      userText: 'What tea do I like?',
    })
  })

  /**
   * @example
   * A session has only user history.
   * The runtime creates a provider system message for supplemental guidance.
   */
  it('creates a system message when only a system prompt supplement is available', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.sessionMessages['session-1'] = []
    harness.systemPromptSupplement.set('Plugin toolset guidance.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ text: 'hello', type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
    })

    await harness.runtime.ingest('hello from user', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(composedMessages[0]).toMatchObject({
      content: 'Plugin toolset guidance.',
      role: 'system',
    })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })
  })

  /**
   * @example
   * Runtime telemetry callbacks expose client-visible latency milestones.
   */
  it('emits telemetry milestones for a successful voice-backed message round', async () => {
    const harness = createHarness()
    harness.monotonicNow.set([100, 150, 250, 400, 460])

    await harness.runtime.ingest('hello from voice', {
      chatProvider: provider,
      input: {
        data: {
          text: 'hello from voice',
        },
        type: 'input:text',
      },
      model: 'gpt-test',
    })

    expect(harness.telemetry.messageSendStarted).toEqual([{
      conversationId: 'session-1',
      model: 'gpt-test',
      roundId: 'user-id',
      source: 'voice',
      turnIndex: 1,
    }])
    expect(harness.telemetry.llmRequestStarted).toEqual([{
      conversationId: 'session-1',
      hasVoice: true,
      model: 'gpt-test',
      provider: 'mock-provider',
      roundId: 'user-id',
      turnIndex: 1,
    }])
    expect(harness.telemetry.llmFirstToken).toEqual([{
      conversationId: 'session-1',
      model: 'gpt-test',
      roundId: 'user-id',
      ttfbMs: 100,
      turnIndex: 1,
    }])
    expect(harness.telemetry.assistantResponseRendered).toEqual([{
      conversationId: 'session-1',
      latencyMs: 250,
      model: 'gpt-test',
      roundId: 'user-id',
      turnIndex: 1,
    }])
    expect(harness.telemetry.messageRound).toEqual([{
      conversationId: 'session-1',
      durationMs: 360,
      hasVoice: true,
      model: 'gpt-test',
      roundId: 'user-id',
      turnIndex: 1,
    }])
    expect(harness.telemetry.chatActivationStarted).toEqual([{
      conversationId: 'session-1',
      model: 'gpt-test',
      provider: 'mock-provider',
      roundId: 'user-id',
      source: 'voice',
      turnIndex: 1,
    }])
    expect(harness.telemetry.chatActivationSucceeded).toEqual([{
      conversationId: 'session-1',
      durationMs: 360,
      model: 'gpt-test',
      provider: 'mock-provider',
      roundId: 'user-id',
      source: 'voice',
      turnIndex: 1,
    }])
    expect(harness.telemetry.chatActivationFailed).toEqual([])
  })

  // ROOT CAUSE:
  //
  // Activation callbacks were emitted for every chat round, so production
  // `chat_activation_*` volume tracked message traffic instead of the first
  // successful assistant response in a conversation.
  it('emits activation milestones only until the conversation gets its first assistant response', async () => {
    const harness = createHarness()

    await harness.runtime.ingest('first turn', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    await harness.runtime.ingest('second turn', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(harness.telemetry.chatActivationStarted).toHaveLength(1)
    expect(harness.telemetry.chatActivationSucceeded).toHaveLength(1)
    expect(harness.telemetry.chatActivationFailed).toHaveLength(0)
    expect(harness.telemetry.messageSendStarted).toHaveLength(2)
    expect(harness.telemetry.messageRound).toHaveLength(2)
  })

  /**
   * @example
   * await expect(runtime.ingest('hello', { model, chatProvider })).rejects.toThrow('provider rejected')
   */
  it('emits chat activation failure telemetry without raw provider messages', async () => {
    const harness = createHarness()
    harness.stream.mockRejectedValueOnce(new Error('provider rejected with sensitive details'))

    await expect(harness.runtime.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })).rejects.toThrow('provider rejected')

    expect(harness.telemetry.chatActivationStarted).toEqual([{
      conversationId: 'session-1',
      model: 'gpt-test',
      provider: 'mock-provider',
      roundId: 'user-id',
      source: 'text',
      turnIndex: 1,
    }])
    expect(harness.telemetry.chatActivationSucceeded).toEqual([])
    expect(harness.telemetry.chatActivationFailed).toEqual([{
      conversationId: 'session-1',
      errorCode: 'llm_response_failed',
      failureStage: 'llm_response',
      model: 'gpt-test',
      provider: 'mock-provider',
      roundId: 'user-id',
      source: 'text',
      turnIndex: 1,
    }])
    expect(harness.telemetry.messageRoundFailed).toEqual([{
      conversationId: 'session-1',
      errorCode: 'llm_response_failed',
      failureStage: 'llm_response',
      model: 'gpt-test',
      provider: 'mock-provider',
      roundId: 'user-id',
      source: 'text',
      turnIndex: 1,
    }])
  })

  it('emits a round failure for later turns without repeating activation failure', async () => {
    const harness = createHarness()

    await harness.runtime.ingest('first turn succeeds', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    harness.stream.mockRejectedValueOnce(new Error('later turn rejected'))

    await expect(harness.runtime.ingest('second turn fails', {
      chatProvider: provider,
      model: 'gpt-test',
    })).rejects.toThrow('later turn rejected')

    expect(harness.telemetry.chatActivationFailed).toEqual([])
    expect(harness.telemetry.messageRoundFailed).toEqual([
      expect.objectContaining({
        conversationId: 'session-1',
        errorCode: 'llm_response_failed',
        failureStage: 'llm_response',
        roundId: expect.any(String),
        turnIndex: 2,
      }),
    ])
  })

  /**
   * @example
   * Cancelling a queued send rejects only pending work that has not started.
   */
  it('rejects cancelled queued sends before they start', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const firstSend = harness.runtime.ingest('hold queue', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    const secondSend = harness.runtime.ingest('cancel me', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })
    harness.runtime.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  /**
   * @example
   * A queued send rejects if its captured session generation becomes stale.
   */
  it('rejects stale generation sends before they start', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const firstSend = harness.runtime.ingest('hold queue', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    const secondSend = harness.runtime.ingest('stale request', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })
    harness.generation.set(2)
    releaseFirstSend?.()

    await firstSend
    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    expect(harness.stream).toHaveBeenCalledTimes(1)
  })

  /**
   * @example
   * runtime.setSending(true)
   * expect(runtime.getSending()).toBe(true)
   */
  it('keeps sending externally writable for UI facades', () => {
    const harness = createHarness()

    harness.runtime.setSending(true)
    expect(harness.runtime.getSending()).toBe(true)
    expect(harness.stateChanges.at(-1)).toEqual({
      pendingQueuedSendCount: 0,
      sending: true,
    })

    harness.runtime.setSending(false)
    expect(harness.runtime.getSending()).toBe(false)
    expect(harness.stateChanges.at(-1)).toEqual({
      pendingQueuedSendCount: 0,
      sending: false,
    })
  })

  /**
   * @example
   * const snapshot = runtime.getPendingQueuedSendSnapshot()
   * expect(snapshot[0].inputType).toBe('input:text')
   */
  it('returns pending queued send snapshots with public fields', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const queuedMessage = 'queued-message-'.repeat(12)
    const firstSend = harness.runtime.ingest('hold queue', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    const secondSend = harness.runtime.ingest(queuedMessage, {
      attachments: [
        {
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
          type: 'image',
        },
      ],
      chatProvider: provider,
      input: {
        data: {
          text: 'queued input',
        },
        type: 'input:text',
      },
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })

    expect(harness.runtime.getPendingQueuedSendSnapshot()).toEqual([
      {
        cancelled: false,
        generation: 1,
        hasAttachments: true,
        inputType: 'input:text',
        messagePreview: queuedMessage.slice(0, 120),
        sessionId: 'session-1',
      },
    ])

    harness.runtime.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  /**
   * @example
   * Attachments, reasoning deltas, and tool events update the assistant builder.
   */
  it('handles attachments, reasoning deltas, tool events, and assistant finalization', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ text: 'thinking', type: 'reasoning-delta' })
      await options?.onStreamEvent?.({
        args: {},
        toolCallId: 'tool-1',
        toolName: 'weather',
        type: 'tool-call',
      } as StreamEvent)
      await options?.onStreamEvent?.({
        result: 'sunny',
        toolCallId: 'tool-1',
        type: 'tool-result',
      } as StreamEvent)
      await options?.onStreamEvent?.({ text: 'visible reply', type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
    })

    await harness.runtime.ingest('see image', {
      attachments: [
        {
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
          type: 'image',
        },
      ],
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(composedMessages[1]?.content).toEqual([
      {
        text: '[2026-04-25 18:47] see image',
        type: 'text',
      },
      {
        image_url: {
          url: 'data:image/png;base64,aW1hZ2U=',
        },
        type: 'image_url',
      },
    ])
    const assistant = harness.sessionMessages['session-1']?.at(-1)
    expect(assistant).toMatchObject({
      categorization: {
        reasoning: 'thinking',
      },
      content: 'visible reply',
      role: 'assistant',
    })
    expect((assistant as StreamingAssistantMessage).slices).toEqual([
      expect.objectContaining({
        toolCall: expect.objectContaining({
          toolCallId: 'tool-1',
        }),
        type: 'tool-call',
      }),
      {
        text: 'visible reply',
        type: 'text',
      },
    ])
    expect((assistant as StreamingAssistantMessage).tool_results).toEqual([
      {
        id: 'tool-1',
        result: 'sunny',
        type: 'tool-call-result',
      },
    ])
    expect(harness.assistantAppended).toHaveLength(1)
    expect(harness.foregroundResets).toHaveLength(1)
  })
})

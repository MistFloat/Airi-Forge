import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from '../types/llm'

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
  const checkpointTurn = vi.fn(async () => {})
  const settleTurn = vi.fn(async () => true)
  const startTurn = vi.fn(async () => true)
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
  const stream = vi.fn(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options?: StreamOptions) => {
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
    turnControl: {
      checkpoint: checkpointTurn,
      settle: settleTurn,
      start: startTurn,
    },
  })

  return {
    assistantAppended,
    assistantTurns,
    checkpointTurn,
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
    runtime,
    sessionMessages,
    settleTurn,
    startTurn,
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
  it('checkpoints a main-owned turn around renderer execution', async () => {
    const harness = createHarness()

    await harness.runtime.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(harness.startTurn).toHaveBeenCalledWith({
      assistantMessageId: 'assistant-id',
      sessionId: 'session-1',
      source: 'text',
      turnId: 'user-id',
      userMessage: expect.objectContaining({
        content: 'hello',
        id: 'user-id',
        role: 'user',
      }),
      userMessageId: 'user-id',
      userText: 'hello',
    })
    expect(harness.startTurn).toHaveBeenCalledBefore(harness.stream)
    expect(harness.checkpointTurn).toHaveBeenCalledWith({
      assistantMessageId: 'assistant-id',
      assistantText: 'assistant reply',
      sessionId: 'session-1',
      turnId: 'user-id',
    })
    expect(harness.settleTurn).toHaveBeenCalledWith({
      assistantMessage: expect.objectContaining({
        content: 'assistant reply',
        id: 'assistant-id',
        role: 'assistant',
      }),
      assistantMessageStatus: 'complete',
      finishReason: 'stop',
      sessionId: 'session-1',
      status: 'completed',
      turnId: 'user-id',
    })
    expect(harness.checkpointTurn).toHaveBeenCalledBefore(harness.settleTurn)
  })

  it('does not dispatch the model or forge a local close when durable admission fails', async () => {
    const harness = createHarness()
    const admissionError = new Error('turn admission unavailable')
    harness.startTurn.mockRejectedValueOnce(admissionError)

    await expect(harness.runtime.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })).rejects.toBe(admissionError)

    expect(harness.stream).not.toHaveBeenCalled()
    expect(harness.settleTurn).not.toHaveBeenCalled()
    expect(harness.runtime.getSessionEvents('session-1')).toEqual([])
    expect(harness.sessionMessages['session-1']).toHaveLength(1)
  })

  it('coalesces streaming checkpoints while one platform write is in flight', async () => {
    const harness = createHarness()
    let releaseCheckpoint: (() => void) | undefined
    harness.checkpointTurn.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseCheckpoint = resolve
      })
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ text: 'a'.repeat(60), type: 'text-delta' })
      await options?.onStreamEvent?.({ text: 'b'.repeat(60), type: 'text-delta' })
      await options?.onStreamEvent?.({ text: 'c'.repeat(60), type: 'text-delta' })
      await options?.onStreamEvent?.({ text: 'd'.repeat(60), type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'stop', type: 'finish' })
    })

    const send = harness.runtime.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(harness.checkpointTurn).toHaveBeenCalledTimes(1)
    })
    releaseCheckpoint?.()
    await send

    expect(harness.checkpointTurn).toHaveBeenCalledTimes(2)
    expect(harness.checkpointTurn).toHaveBeenLastCalledWith(expect.objectContaining({
      assistantText: `${'a'.repeat(60)}${'b'.repeat(60)}${'c'.repeat(60)}${'d'.repeat(60)}`,
    }))
  })

  // ROOT CAUSE:
  //
  // Provider configuration reached the orchestrator but only custom headers
  // were projected into StreamOptions, so every model silently used the global
  // maxTokens fallback regardless of the value saved in provider settings.
  //
  // We fixed this by accepting a finite positive integer from the active
  // provider configuration and forwarding it to the LLM port for this turn.
  it('forwards the active provider output-token limit to the LLM stream', async () => {
    const harness = createHarness()

    await harness.runtime.ingest('hello', {
      chatProvider: provider,
      model: 'model-a',
      providerConfig: { maxTokens: 65536 },
    })

    const streamOptions = harness.stream.mock.calls[0]?.[3] as StreamOptions | undefined
    expect(streamOptions?.maxTokens).toBe(65536)
  })

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

  it('persists an exhausted action continuation as an interrupted failed turn', async () => {
    const harness = createHarness()
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ text: '让我读取文件。', type: 'text-delta' })
      await options?.onStreamEvent?.({ finishReason: 'incomplete-action', type: 'finish' })
    })

    await expect(harness.runtime.ingest('读取文件', {
      chatProvider: provider,
      model: 'gpt-test',
    })).rejects.toThrow('promised tool action')

    expect(harness.sessionMessages['session-1']?.at(-1)).toMatchObject({
      content: '让我读取文件。',
      interrupted: true,
      role: 'assistant',
    })
    expect(harness.settleTurn).toHaveBeenCalledWith(expect.objectContaining({
      assistantMessageStatus: 'interrupted',
      finishReason: 'incomplete-action',
      status: 'failed',
    }))
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

  // ROOT CAUSE:
  //
  // The assistant message was appended only after the provider stream
  // resolved. If the connection failed after emitting text, the foreground
  // UI briefly showed that text but session history permanently lost it.
  //
  // We fixed this by finalizing the parser and committing the visible partial
  // assistant as interrupted before the failed turn settles.
  it('persists visible partial assistant output when a provider stream fails', async () => {
    const harness = createHarness()
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ text: 'partial reply', type: 'text-delta' })
      throw new Error('connection lost')
    })

    await expect(harness.runtime.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })).rejects.toThrow('connection lost')

    expect(harness.sessionMessages['session-1']?.at(-1)).toMatchObject({
      content: 'partial reply',
      interrupted: true,
      role: 'assistant',
    })
    expect(harness.assistantAppended).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ interrupted: true }),
        messageText: 'partial reply',
        sessionId: 'session-1',
      }),
    ])
    expect(harness.foregroundResets).toHaveLength(1)
    expect(harness.runtime.getSessionEvents('session-1').map(event => [event.type, event.payload])).toEqual([
      ['prompt.composed', expect.objectContaining({ turnId: 'user-id' })],
    ])
    expect(harness.settleTurn).toHaveBeenCalledWith({
      assistantMessage: expect.objectContaining({
        content: 'partial reply',
        interrupted: true,
        role: 'assistant',
      }),
      assistantMessageStatus: 'interrupted',
      sessionId: 'session-1',
      status: 'failed',
      turnId: 'user-id',
    })
  })

  // ROOT CAUSE:
  //
  // A lifecycle-interrupted turn rejected the failed settlement with
  // "already terminal with status interrupted". Throwing that rejection from
  // the stream-failure handler replaced the original provider error, so the
  // UI surfaced the state-machine guard instead of the real failure.
  //
  // We fixed this by logging the settlement conflict and re-throwing the
  // original stream error.
  it('keeps the original provider error when the failed settlement is rejected', async () => {
    const harness = createHarness()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ text: 'partial reply', type: 'text-delta' })
      throw new Error('connection lost')
    })
    harness.settleTurn.mockRejectedValueOnce(
      new Error('Agent turn user-id is already terminal with status interrupted'),
    )

    await expect(harness.runtime.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })).rejects.toThrow('connection lost')

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to settle Agent turn after stream failure:',
      expect.any(Error),
    )
    consoleError.mockRestore()
  })

  // ROOT CAUSE:
  //
  // Queue cancellation never reached the currently running provider request,
  // so a reset or explicit stop left the active stream and its tools running.
  //
  // We fixed this by giving each active turn its own AbortController and
  // passing that signal through the existing LLM port.
  it('aborts only the exact active turn and persists its partial assistant output', async () => {
    const harness = createHarness()
    let receivedSignal: AbortSignal | undefined
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      receivedSignal = options?.abortSignal
      await options?.onStreamEvent?.({ text: 'work in progress', type: 'text-delta' })
      await new Promise<void>((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => reject(receivedSignal?.reason), { once: true })
      })
    })

    const send = harness.runtime.ingest('start work', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(receivedSignal).toBeInstanceOf(AbortSignal)
    })
    expect(harness.runtime.getActiveTurn()).toEqual({ sessionId: 'session-1', turnId: 'user-id' })
    expect(harness.runtime.cancelActiveTurn('stale-turn')).toBe(false)
    expect(receivedSignal?.aborted).toBe(false)
    expect(harness.runtime.cancelActiveTurn('user-id')).toBe(true)

    await expect(send).rejects.toMatchObject({ name: 'AbortError' })
    expect(receivedSignal?.aborted).toBe(true)
    expect(harness.sessionMessages['session-1']?.at(-1)).toMatchObject({
      content: 'work in progress',
      interrupted: true,
      role: 'assistant',
    })
    expect(harness.runtime.getSessionEvents('session-1').at(-1)).toMatchObject({
      payload: { turnId: 'user-id' },
      type: 'prompt.composed',
    })
    expect(harness.telemetry.messageRoundFailed).toEqual([])
    expect(harness.telemetry.chatActivationFailed).toEqual([])
    expect(harness.settleTurn).toHaveBeenCalledWith({
      assistantMessage: expect.objectContaining({
        content: 'work in progress',
        interrupted: true,
        role: 'assistant',
      }),
      assistantMessageStatus: 'interrupted',
      sessionId: 'session-1',
      status: 'cancelled',
      turnId: 'user-id',
    })
    expect(harness.runtime.cancelActiveSend('session-1')).toBe(false)
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

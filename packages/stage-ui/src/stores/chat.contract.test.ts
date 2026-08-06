import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import { IOSpanNames } from '@proj-airi/stage-shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import { useChatOrchestratorStore } from './chat'

vi.hoisted(() => {
  // NOTICE: posthog-js reads `window.location.hash` during toolbar setup
  // (`_getHashParam`) and also references the bare `location` global. Node has
  // neither, so the mock must provide both or posthog crashes with
  // `Cannot read properties of undefined (reading 'match')` / `location is not defined`.
  const location = {
    hash: '',
    origin: 'http://localhost',
  }
  ;(globalThis as any).window = { location }
  ;(globalThis as any).location = location
})

const ioTracerMocks = vi.hoisted(() => {
  const activeTurnSpan = { value: undefined as any }
  const spans: any[] = []
  const startSpanMock = vi.fn((name: string) => {
    const span = {
      addEvent: vi.fn(),
      end: vi.fn(),
      name,
      setAttribute: vi.fn(),
    }
    spans.push(span)
    return span
  })

  return {
    activeTurnSpan,
    spans,
    startSpanMock,
  }
})

const llmStreamMock = vi.fn()
const trackFirstMessageMock = vi.fn()
const chatAnalyticsMocks = vi.hoisted(() => ({
  trackAssistantResponseRendered: vi.fn(),
  trackChatActivationFailed: vi.fn(),
  trackChatActivationStarted: vi.fn(),
  trackChatActivationSucceeded: vi.fn(),
  trackLlmFirstToken: vi.fn(),
  trackLlmRequestStarted: vi.fn(),
  trackMessageRound: vi.fn(),
  trackMessageRoundFailed: vi.fn(),
  trackMessageSendStarted: vi.fn(),
  trackMessageSent: vi.fn(),
  trackSecondTurnStarted: vi.fn(),
}))
const trackSecondTurnStartedMock = chatAnalyticsMocks.trackSecondTurnStarted
const redundantChatAnalyticsMocks = vi.hoisted(() => ({
  trackAssistantResponseCompleted: vi.fn(),
  trackChatFailed: vi.fn(),
  trackChatStarted: vi.fn(),
  trackFeatureUsed: vi.fn(),
}))
const ingestContextMessageMock = vi.fn()
const getContextsSnapshotMock = vi.fn()
const createMinecraftContextMock = vi.fn()
const persistSessionMessagesMock = vi.fn()
const forkSessionMock = vi.fn()
const ensureSessionMock = vi.fn()

const activeSessionIdRef = ref('session-1')
const activeProviderRef = ref('mock-provider')
const activeModelRef = ref('gpt-test')
const streamingMessageRef = ref<any>({ content: '', role: 'assistant', slices: [], tool_results: [] })
const sessionMessages: Record<string, any[]> = {}
let currentGeneration = 1

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: any) => store,
  }
})

vi.mock('../composables', () => ({
  useAnalytics: () => ({
    trackAssistantResponseCompleted: redundantChatAnalyticsMocks.trackAssistantResponseCompleted,
    trackAssistantResponseRendered: chatAnalyticsMocks.trackAssistantResponseRendered,
    trackChatActivationFailed: chatAnalyticsMocks.trackChatActivationFailed,
    trackChatActivationStarted: chatAnalyticsMocks.trackChatActivationStarted,
    trackChatActivationSucceeded: chatAnalyticsMocks.trackChatActivationSucceeded,
    trackChatFailed: redundantChatAnalyticsMocks.trackChatFailed,
    trackChatStarted: redundantChatAnalyticsMocks.trackChatStarted,
    trackFeatureUsed: redundantChatAnalyticsMocks.trackFeatureUsed,
    trackFirstMessage: trackFirstMessageMock,
    trackLlmFirstToken: chatAnalyticsMocks.trackLlmFirstToken,
    trackLlmRequestStarted: chatAnalyticsMocks.trackLlmRequestStarted,
    trackMessageRound: chatAnalyticsMocks.trackMessageRound,
    trackMessageRoundFailed: chatAnalyticsMocks.trackMessageRoundFailed,
    trackMessageSendStarted: chatAnalyticsMocks.trackMessageSendStarted,
    trackMessageSent: chatAnalyticsMocks.trackMessageSent,
    trackSecondTurnStarted: trackSecondTurnStartedMock,
  }),
}))

vi.mock('../composables/use-io-tracer', () => ({
  activeTurnSpan: ioTracerMocks.activeTurnSpan,
  startSpan: ioTracerMocks.startSpanMock,
}))

vi.mock('./chat/context-providers', () => ({
  createMinecraftContext: () => createMinecraftContextMock(),
}))

vi.mock('./chat/context-store', () => ({
  useChatContextStore: () => ({
    getContextsSnapshot: getContextsSnapshotMock,
    ingestContextMessage: ingestContextMessageMock,
  }),
}))

vi.mock('./chat/session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: activeSessionIdRef,
    appendSessionMessage: (sessionId: string, message: any) => {
      sessionMessages[sessionId] ??= []
      sessionMessages[sessionId].push(message)
    },
    ensureSession: (sessionId: string) => {
      ensureSessionMock(sessionId)
      sessionMessages[sessionId] ??= [{ content: 'system prompt', createdAt: 1, id: 'system', role: 'system' }]
    },
    forkSession: forkSessionMock,
    getSessionGeneration: () => currentGeneration,
    getSessionMessages: (sessionId: string) => sessionMessages[sessionId] ?? [],
    persistSessionMessages: persistSessionMessagesMock,
    // Cloud sync surface used by `chat.ts performSend`. Mocked as a no-op so
    // the orchestrator contract tests do not need a real WS / cloud mapper.
    pushMessageToCloud: vi.fn().mockResolvedValue(undefined),
    sessionMessages,
  }),
}))

vi.mock('./chat/stream-store', () => ({
  useChatStreamStore: () => ({
    streamingMessage: streamingMessageRef,
  }),
}))

vi.mock('./llm', () => ({
  useLLM: () => ({
    stream: llmStreamMock,
  }),
}))

vi.mock('./llm-toolset-prompts', () => ({
  useLlmToolsetPromptsStore: () => ({
    activeToolsetPrompt: 'Plugin toolset guidance.',
  }),
}))

vi.mock('./modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeModel: activeModelRef,
    activeProvider: activeProviderRef,
  }),
}))

vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCard: undefined,
  }),
}))

vi.mock('./modules/artistry-autonomous', () => ({
  useAutonomousArtistryStore: () => ({
    runArtistTask: vi.fn(),
  }),
}))

const provider = {
  chat: () => ({ baseURL: 'https://example.com/' }),
} as unknown as ChatProvider

describe('chat orchestrator contract', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    llmStreamMock.mockReset()
    trackFirstMessageMock.mockReset()
    for (const analyticsMock of Object.values(chatAnalyticsMocks))
      analyticsMock.mockReset()
    redundantChatAnalyticsMocks.trackAssistantResponseCompleted.mockReset()
    redundantChatAnalyticsMocks.trackChatFailed.mockReset()
    redundantChatAnalyticsMocks.trackChatStarted.mockReset()
    redundantChatAnalyticsMocks.trackFeatureUsed.mockReset()
    ingestContextMessageMock.mockReset()
    getContextsSnapshotMock.mockReset()
    getContextsSnapshotMock.mockReturnValue({})
    createMinecraftContextMock.mockReset()
    createMinecraftContextMock.mockReturnValue(undefined)
    persistSessionMessagesMock.mockReset()
    forkSessionMock.mockReset()
    ensureSessionMock.mockReset()
    ioTracerMocks.activeTurnSpan.value = undefined
    ioTracerMocks.spans.length = 0
    ioTracerMocks.startSpanMock.mockClear()
    activeSessionIdRef.value = 'session-1'
    activeProviderRef.value = 'mock-provider'
    streamingMessageRef.value = { content: '', role: 'assistant', slices: [], tool_results: [] }
    currentGeneration = 1

    for (const key of Object.keys(sessionMessages)) {
      delete sessionMessages[key]
    }

    sessionMessages['session-1'] = [{ content: 'system prompt', createdAt: 1, id: 'system', role: 'system' }]
  })

  it('forwards one correlation identity across every PostHog chat milestone', async () => {
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ text: 'ok', type: 'text-delta' })
      await options.onStreamEvent({ finishReason: 'stop', type: 'finish' })
    })

    const store = useChatOrchestratorStore()
    await store.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    const messageProperties = chatAnalyticsMocks.trackMessageSent.mock.calls[0]?.[0]
    expect(messageProperties).toMatchObject({
      conversation_id: 'session-1',
      round_id: messageProperties.message_id,
      turn_index: 1,
    })

    const correlation = {
      conversation_id: 'session-1',
      round_id: messageProperties.round_id,
      turn_index: 1,
    }
    expect(chatAnalyticsMocks.trackMessageSendStarted).toHaveBeenCalledWith(expect.objectContaining(correlation))
    expect(chatAnalyticsMocks.trackLlmRequestStarted).toHaveBeenCalledWith(expect.objectContaining(correlation))
    expect(chatAnalyticsMocks.trackLlmFirstToken).toHaveBeenCalledWith(expect.objectContaining(correlation))
    expect(chatAnalyticsMocks.trackAssistantResponseRendered).toHaveBeenCalledWith(expect.objectContaining(correlation))
    expect(chatAnalyticsMocks.trackMessageRound).toHaveBeenCalledWith(expect.objectContaining(correlation))
    expect(chatAnalyticsMocks.trackChatActivationStarted).toHaveBeenCalledWith(expect.objectContaining(correlation))
    expect(chatAnalyticsMocks.trackChatActivationSucceeded).toHaveBeenCalledWith(expect.objectContaining(correlation))
  })

  it('emits second turn analytics from chat sends', async () => {
    activeProviderRef.value = 'official-provider'
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ text: 'ok', type: 'text-delta' })
      await options.onStreamEvent({ finishReason: 'stop', type: 'finish' })
    })

    const store = useChatOrchestratorStore()

    await store.ingest('first turn', {
      chatProvider: provider,
      model: 'chat-auto',
    })
    await store.ingest('second turn', {
      chatProvider: provider,
      model: 'chat-auto',
    })

    expect(trackSecondTurnStartedMock).toHaveBeenCalledTimes(1)
    expect(trackSecondTurnStartedMock).toHaveBeenCalledWith({
      conversation_id: 'session-1',
      model_id: 'chat-auto',
      provider_id: 'official-provider',
      provider_mode: 'official',
      round_id: expect.any(String),
      source: 'text',
      turn_index: 2,
    })
  })

  // ROOT CAUSE:
  //
  // One successful send emitted both the canonical message/latency events
  // and four generic aliases, multiplying PostHog volume without adding a
  // distinct product decision.
  it('does not emit redundant generic chat aliases for a successful send', async () => {
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ text: 'ok', type: 'text-delta' })
      await options.onStreamEvent({ finishReason: 'stop', type: 'finish' })
    })

    const store = useChatOrchestratorStore()
    await store.ingest('hello', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(redundantChatAnalyticsMocks.trackChatStarted).not.toHaveBeenCalled()
    expect(redundantChatAnalyticsMocks.trackAssistantResponseCompleted).not.toHaveBeenCalled()
    expect(redundantChatAnalyticsMocks.trackChatFailed).not.toHaveBeenCalled()
    expect(redundantChatAnalyticsMocks.trackFeatureUsed).not.toHaveBeenCalled()
  })

  it('forwards later-turn failures to the canonical round failure event', async () => {
    llmStreamMock.mockImplementationOnce(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ text: 'ok', type: 'text-delta' })
      await options.onStreamEvent({ finishReason: 'stop', type: 'finish' })
    })
    llmStreamMock.mockRejectedValueOnce(new Error('later turn rejected'))

    const store = useChatOrchestratorStore()
    await store.ingest('first turn', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    await expect(store.ingest('second turn', {
      chatProvider: provider,
      model: 'gpt-test',
    })).rejects.toThrow('later turn rejected')

    expect(chatAnalyticsMocks.trackChatActivationFailed).not.toHaveBeenCalled()
    expect(chatAnalyticsMocks.trackMessageRoundFailed).toHaveBeenCalledWith({
      conversation_id: 'session-1',
      error_code: 'llm_response_failed',
      failure_stage: 'llm_response',
      model_id: 'gpt-test',
      provider_id: 'mock-provider',
      round_id: expect.any(String),
      source: 'text',
      turn_index: 2,
    })
  })

  it('keeps hook order and composes context prompt after system message', async () => {
    const contextsSnapshot = {
      'system:weather': [
        {
          contextId: 'system:weather',
          createdAt: 456,
          id: 'weather',
          source: 'ReplaceSelf',
          text: 'sunny',
        },
      ],
    }

    getContextsSnapshotMock.mockReturnValue(contextsSnapshot)

    let composedMessages: Message[] = []
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, messages: Message[], options: any) => {
      composedMessages = messages
      expect(options.waitForTools).toBe(true)
      expect(options.captureToolErrors).toBe(true)

      await options.onStreamEvent({ text: 'hello', type: 'text-delta' })
      await options.onStreamEvent({ finishReason: 'stop', type: 'finish' })
    })

    const store = useChatOrchestratorStore()
    const hookOrder: string[] = []

    store.onBeforeMessageComposed(async () => {
      hookOrder.push('before-compose')
    })
    store.onAfterMessageComposed(async () => {
      hookOrder.push('after-compose')
    })
    store.onBeforeSend(async () => {
      hookOrder.push('before-send')
    })
    store.onTokenLiteral(async () => {
      hookOrder.push('token-literal')
    })
    store.onStreamEnd(async () => {
      hookOrder.push('stream-end')
    })
    store.onAssistantResponseEnd(async () => {
      hookOrder.push('assistant-end')
    })
    store.onAfterSend(async () => {
      hookOrder.push('after-send')
    })
    store.onAssistantMessage(async () => {
      hookOrder.push('assistant-message')
    })
    store.onChatTurnComplete(async () => {
      hookOrder.push('turn-complete')
    })

    await store.ingest('hello from user', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(store.sending).toBe(false)
    expect(trackFirstMessageMock).toHaveBeenCalledTimes(1)
    // Datetime is no longer pushed through ingestContextMessage; it is now
    // applied at message-assembly time as a system-prompt anchor + per-message
    // [HH:MM] prefix. ingestContextMessage should still be called for other
    // context providers (e.g. minecraft) when they are configured, but not
    // for datetime in this test (minecraft is mocked to return undefined).
    expect(ingestContextMessageMock).not.toHaveBeenCalled()
    expect(persistSessionMessagesMock).not.toHaveBeenCalled()
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
    expect(composedMessages[0]).toMatchObject({ role: 'system' })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })

    // System message stays untouched: keeping it 100% static is what makes
    // the prefix permanently KV-cache friendly across turns and across day
    // boundaries (the date now lives inside per-message timestamp prefixes
    // instead of a system anchor).
    const systemContent = (composedMessages[0] as any).content
    const systemText = typeof systemContent === 'string' ? systemContent : systemContent.map((p: any) => p.text).join('')
    expect(systemText).toContain('system prompt')
    expect(systemText).toContain('Plugin toolset guidance.')

    // The user turn is prefixed with [YYYY-MM-DD HH:MM]. Both historic and
    // current turns share the same shape so prefix-cache stays valid when a
    // "current" turn becomes "historic" on the next send. Side-channel context
    // (weather) is appended as a separate text part so providers don't see
    // consecutive same-role messages.
    const userMessageContent = (composedMessages[1] as any).content
    expect(userMessageContent[0].text).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] hello from user$/)

    const syntheticContextText = userMessageContent[1].text
    expect(syntheticContextText).not.toContain('<context>')
    expect(syntheticContextText).not.toContain('<module ')
    expect(syntheticContextText).toContain('[Context]')
    expect(syntheticContextText).toContain('- system:weather: sunny')
  })

  it('emits special tokens for speech timeline handling during chat streaming', async () => {
    getContextsSnapshotMock.mockReturnValue({})
    llmStreamMock.mockImplementationOnce(async (_model, _provider, _messages, options) => {
      await options.onStreamEvent({ text: '<|CALL ["plugin.action"]|>', type: 'text-delta' })
    })

    const store = useChatOrchestratorStore()
    const specialHook = vi.fn()
    store.onTokenSpecial(specialHook)

    await store.ingest('trigger special', {
      chatProvider: provider,
      model: 'mock-model',
    })

    expect(specialHook).toHaveBeenCalledWith('<|CALL ["plugin.action"]|>', expect.objectContaining({
      contexts: {},
    }))
  })

  /**
   * @example
   * store.sending = true
   * await nextTick()
   * expect(store.sending).toBe(true)
   */
  it('keeps sending writable for context bridge and chat sync consumers', async () => {
    const store = useChatOrchestratorStore()

    expect(store.sending).toBe(false)

    store.sending = true
    await nextTick()
    expect(store.sending).toBe(true)

    store.sending = false
    await nextTick()
    expect(store.sending).toBe(false)
  })

  /**
   * @example
   * store.sending = false while a local runtime send is still streaming.
   */
  it('does not end the owned IO turn span when external sending mirror is cleared mid-send', async () => {
    let releaseStream: (() => void) | undefined
    llmStreamMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
    })

    const store = useChatOrchestratorStore()
    const send = store.ingest('hold stream', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(store.sending).toBe(true)
    })
    await vi.waitFor(() => {
      expect(ioTracerMocks.spans.some(span => span.name === IOSpanNames.InteractionTurn)).toBe(true)
    })

    const turnSpan = ioTracerMocks.spans.find(span => span.name === IOSpanNames.InteractionTurn)
    if (!turnSpan)
      throw new Error('Expected the chat facade to create an interaction turn span')

    store.sending = false
    await nextTick()

    expect(turnSpan.end).not.toHaveBeenCalled()

    releaseStream?.()
    await send

    expect(turnSpan.end).toHaveBeenCalledTimes(1)
    expect(ioTracerMocks.activeTurnSpan.value).toBeUndefined()
  })

  /**
   * @example
   * createMinecraftContext() returns a runtime context update.
   * The facade passes it into the core runtime before prompt snapshots are read.
   */
  it('ingests runtime context providers before composing prompt snapshots', async () => {
    const minecraftContext = {
      contextId: 'system:minecraft',
      createdAt: 123,
      id: 'minecraft-context',
      source: 'minecraft',
      strategy: 'replace-self',
      text: 'player is near spawn',
    }
    let composedMessages: Message[] = []

    createMinecraftContextMock.mockReturnValue(minecraftContext)
    getContextsSnapshotMock.mockReturnValue({
      'system:minecraft': [minecraftContext],
    })
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, messages: Message[], options: any) => {
      composedMessages = messages
      await options.onStreamEvent({ text: 'minecraft reply', type: 'text-delta' })
      await options.onStreamEvent({ finishReason: 'stop', type: 'finish' })
    })

    const store = useChatOrchestratorStore()

    await store.ingest('where am I?', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    expect(ingestContextMessageMock).toHaveBeenCalledTimes(1)
    expect(ingestContextMessageMock).toHaveBeenCalledWith(minecraftContext)
    expect(ingestContextMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      getContextsSnapshotMock.mock.invocationCallOrder[0],
    )
    const minecraftMessageContent = composedMessages[1]?.content
    if (!Array.isArray(minecraftMessageContent))
      throw new TypeError('Expected composed user message content to be an array')
    expect(minecraftMessageContent[1]).toMatchObject({
      text: expect.stringContaining('- system:minecraft: player is near spawn'),
    })
  })

  it('rejects cancelled queued sends before they start', async () => {
    let releaseFirstSend: (() => void) | undefined
    llmStreamMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const store = useChatOrchestratorStore()
    const firstSend = store.ingest('hold queue', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    const secondSend = store.ingest('cancel me', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(llmStreamMock).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(store.pendingQueuedSendCount).toBe(1)
    })
    store.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  /**
   * @example
   * store.getPendingQueuedSendSnapshot()
   * // => [{ sessionId, generation, cancelled, messagePreview, hasAttachments, inputType }]
   */
  it('mirrors pending queued send snapshots from the core runtime', async () => {
    let releaseFirstSend: (() => void) | undefined
    llmStreamMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const queuedMessage = 'queued-message-'.repeat(12)
    const store = useChatOrchestratorStore()
    const firstSend = store.ingest('hold queue', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    const secondSend = store.ingest(queuedMessage, {
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
      expect(llmStreamMock).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(store.pendingQueuedSendCount).toBe(1)
    })

    expect(store.getPendingQueuedSendSnapshot()).toEqual([
      {
        cancelled: false,
        generation: 1,
        hasAttachments: true,
        inputType: 'input:text',
        messagePreview: queuedMessage.slice(0, 120),
        sessionId: 'session-1',
      },
    ])

    store.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  it('rejects stale generation sends before performSend starts', async () => {
    let releaseFirstSend: (() => void) | undefined
    llmStreamMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const store = useChatOrchestratorStore()
    const firstSend = store.ingest('hold queue', {
      chatProvider: provider,
      model: 'gpt-test',
    })
    const secondSend = store.ingest('stale request', {
      chatProvider: provider,
      model: 'gpt-test',
    })

    await vi.waitFor(() => {
      expect(llmStreamMock).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(store.pendingQueuedSendCount).toBe(1)
    })
    currentGeneration = 2
    releaseFirstSend?.()

    await firstSend
    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    expect(llmStreamMock).toHaveBeenCalledTimes(1)
  })

  it('uses forked session id in ingestOnFork and keeps public store contract keys', async () => {
    getContextsSnapshotMock.mockReturnValue({})
    forkSessionMock.mockResolvedValue('session-forked')
    llmStreamMock.mockImplementation(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options: any) => {
      await options.onStreamEvent({ text: 'fork-reply', type: 'text-delta' })
      await options.onStreamEvent({ finishReason: 'stop', type: 'finish' })
    })

    const store = useChatOrchestratorStore()

    expect(store.$id).toBe('chat-orchestrator')
    expect(typeof store.ingest).toBe('function')
    expect(typeof store.ingestOnFork).toBe('function')
    expect(typeof store.cancelPendingSends).toBe('function')
    expect(typeof store.onBeforeSend).toBe('function')
    expect(typeof store.emitBeforeSendHooks).toBe('function')

    await store.ingestOnFork('fork me', {
      chatProvider: provider,
      model: 'gpt-test',
    }, {
      atIndex: 3,
      fromSessionId: 'session-1',
      hidden: true,
      reason: 'retry',
    })

    expect(forkSessionMock).toHaveBeenCalledWith({
      atIndex: 3,
      fromSessionId: 'session-1',
      hidden: true,
      reason: 'retry',
    })
    expect(ensureSessionMock).toHaveBeenCalledWith('session-forked')
  })
})

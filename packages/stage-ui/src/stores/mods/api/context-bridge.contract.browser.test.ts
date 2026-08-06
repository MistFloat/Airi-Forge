import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { CHAT_STREAM_CHANNEL_NAME, CONTEXT_CHANNEL_NAME } from '../../chat/constants'

type HookCallback = (...args: unknown[]) => Promise<void> | void
type UseContextBridgeStore = typeof import('./context-bridge')['useContextBridgeStore']

const contextUpdateHooks: HookCallback[] = []
const serverEventHooks = new Map<string, HookCallback[]>()

const chatContextIngestMock = vi.fn()
const beginStreamMock = vi.fn()
const appendStreamLiteralMock = vi.fn()
const finalizeStreamMock = vi.fn()
const resetStreamMock = vi.fn()
const serverSendMock = vi.fn()
const ensureConnectedMock = vi.fn().mockResolvedValue(undefined)
const onReconnectedMock = vi.fn(() => () => {})
const onContextUpdateMock = vi.fn((callback: HookCallback) => registerHook(contextUpdateHooks, callback))
const onEventMock = vi.fn((eventName: string, callback: HookCallback) => registerServerEventHook(eventName, callback))
const getProviderInstanceMock = vi.fn()
const recordLifecycleMock = vi.fn()

const activeProviderRef = ref<null | string>(null)
const activeModelRef = ref<null | string>(null)

const beforeComposeHooks: HookCallback[] = []
const afterComposeHooks: HookCallback[] = []
const beforeSendHooks: HookCallback[] = []
const afterSendHooks: HookCallback[] = []
const tokenLiteralHooks: HookCallback[] = []
const tokenSpecialHooks: HookCallback[] = []
const streamEndHooks: HookCallback[] = []
const assistantEndHooks: HookCallback[] = []
const assistantMessageHooks: HookCallback[] = []
const turnCompleteHooks: HookCallback[] = []

const activeSessionIdRef = ref('session-1')
let currentGeneration = 7
const testChannels: BroadcastChannel[] = []
let useContextBridgeStore: UseContextBridgeStore

function closeTestChannels() {
  for (const channel of testChannels) {
    channel.close()
  }
  testChannels.length = 0
}

function collectChannelMessages<T>(name: string) {
  const messages: T[] = []
  const channel = createTestChannel(name)
  channel.addEventListener('message', (event) => {
    messages.push((event as MessageEvent<T>).data)
  })
  return messages
}

function createContextMessage(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'context-1'

  return {
    contextId: typeof overrides.contextId === 'string' ? overrides.contextId : id,
    createdAt: 1,
    id,
    strategy: ContextUpdateStrategy.AppendSelf,
    text: 'context text',
    ...overrides,
  }
}

function createContextUpdateEvent(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'context-1'

  return {
    data: {
      contextId: id,
      id,
      strategy: ContextUpdateStrategy.AppendSelf,
      text: 'weather changed',
      ...overrides,
    },
    metadata: createMetadata('weather', 'station-1'),
    source: 'extension-module-host',
    type: 'context:update',
  }
}

function createMetadata(extensionId: string, moduleId: string) {
  return {
    source: {
      extension: {
        id: extensionId,
      },
      id: moduleId,
    },
  }
}

function createTestChannel(name: string) {
  const channel = new BroadcastChannel(name)
  testChannels.push(channel)
  return channel
}

async function emitContextUpdate(event: unknown) {
  await emitHooks(contextUpdateHooks, event)
}

async function emitHooks(target: HookCallback[], ...args: unknown[]) {
  for (const callback of target) {
    await callback(...args)
  }
}

async function emitServerEvent(eventName: string, event: unknown) {
  await emitHooks(serverEventHooks.get(eventName) ?? [], event)
}

function registerHook(target: HookCallback[], callback: HookCallback) {
  target.push(callback)
  return () => {
    const index = target.indexOf(callback)
    if (index >= 0)
      target.splice(index, 1)
  }
}

function registerServerEventHook(eventName: string, callback: HookCallback) {
  const hooks = serverEventHooks.get(eventName) ?? []
  serverEventHooks.set(eventName, hooks)
  return registerHook(hooks, callback)
}

async function waitForBroadcastDelivery() {
  await new Promise(resolve => setTimeout(resolve, 50))
}

const chatOrchestratorMock = {
  emitAfterMessageComposedHooks: (...args: unknown[]) => emitHooks(afterComposeHooks, ...args),
  emitAfterSendHooks: (...args: unknown[]) => emitHooks(afterSendHooks, ...args),

  emitAssistantResponseEndHooks: (...args: unknown[]) => emitHooks(assistantEndHooks, ...args),
  emitBeforeMessageComposedHooks: (...args: unknown[]) => emitHooks(beforeComposeHooks, ...args),
  emitBeforeSendHooks: (...args: unknown[]) => emitHooks(beforeSendHooks, ...args),
  emitStreamEndHooks: (...args: unknown[]) => emitHooks(streamEndHooks, ...args),
  emitTokenLiteralHooks: (...args: unknown[]) => emitHooks(tokenLiteralHooks, ...args),
  emitTokenSpecialHooks: (...args: unknown[]) => emitHooks(tokenSpecialHooks, ...args),
  ingest: vi.fn(),
  onAfterMessageComposed: (callback: HookCallback) => registerHook(afterComposeHooks, callback),
  onAfterSend: (callback: HookCallback) => registerHook(afterSendHooks, callback),
  onAssistantMessage: (callback: HookCallback) => registerHook(assistantMessageHooks, callback),

  onAssistantResponseEnd: (callback: HookCallback) => registerHook(assistantEndHooks, callback),
  onBeforeMessageComposed: (callback: HookCallback) => registerHook(beforeComposeHooks, callback),
  onBeforeSend: (callback: HookCallback) => registerHook(beforeSendHooks, callback),
  onChatTurnComplete: (callback: HookCallback) => registerHook(turnCompleteHooks, callback),
  onStreamEnd: (callback: HookCallback) => registerHook(streamEndHooks, callback),
  onTokenLiteral: (callback: HookCallback) => registerHook(tokenLiteralHooks, callback),
  onTokenSpecial: (callback: HookCallback) => registerHook(tokenSpecialHooks, callback),
  sending: false,
}

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: unknown) => store,
  }
})

vi.mock('@proj-airi/stage-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@proj-airi/stage-shared')>()
  return {
    ...actual,
    isStageTamagotchi: () => false,
    isStageWeb: () => true,
  }
})

vi.mock('es-toolkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('es-toolkit')>()
  return {
    ...actual,
    Mutex: class {
      async acquire() {}
      release() {}
    },
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../../character', () => ({
  useCharacterOrchestratorStore: () => ({
    handleSparkNotifyWithReaction: vi.fn(async (_event: unknown, options: { fallbackText: string }) => options.fallbackText),
  }),
}))

vi.mock('../../chat', () => ({
  useChatOrchestratorStore: () => chatOrchestratorMock,
}))

vi.mock('../../chat/context-store', () => ({
  useChatContextStore: () => ({
    ingestContextMessage: chatContextIngestMock,
  }),
}))

vi.mock('../../chat/session-store', () => ({
  useChatSessionStore: () => ({
    get activeSessionId() {
      return activeSessionIdRef.value
    },
    getSessionGenerationValue: () => currentGeneration,
  }),
}))

vi.mock('../../chat/stream-store', () => ({
  useChatStreamStore: () => ({
    appendStreamLiteral: appendStreamLiteralMock,
    beginStream: beginStreamMock,
    finalizeStream: finalizeStreamMock,
    resetStream: resetStreamMock,
  }),
}))

vi.mock('../../devtools/context-observability', () => ({
  useContextObservabilityStore: () => ({
    recordLifecycle: recordLifecycleMock,
  }),
}))

vi.mock('../../modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeModel: activeModelRef,
    activeProvider: activeProviderRef,
  }),
}))

vi.mock('../../providers', () => ({
  useProvidersStore: () => ({
    configuredSpeechProvidersMetadata: [],
    getProviderConfig: vi.fn(() => ({})),
    getProviderInstance: getProviderInstanceMock,
    getProviderMetadata: vi.fn(() => ({
      capabilities: {},
    })),
    providerRuntimeState: {},
  }),
}))

vi.mock('./channel-server', () => ({
  useModsServerChannelStore: () => ({
    ensureConnected: ensureConnectedMock,
    onContextUpdate: onContextUpdateMock,
    onEvent: onEventMock,
    onReconnected: onReconnectedMock,
    send: serverSendMock,
  }),
}))

describe('context bridge contract', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    ;({ useContextBridgeStore } = await import('./context-bridge'))

    chatContextIngestMock.mockReset()
    beginStreamMock.mockReset()
    appendStreamLiteralMock.mockReset()
    finalizeStreamMock.mockReset()
    resetStreamMock.mockReset()
    serverSendMock.mockReset()
    ensureConnectedMock.mockClear()
    ensureConnectedMock.mockResolvedValue(undefined)
    onReconnectedMock.mockClear()
    onContextUpdateMock.mockClear()
    onEventMock.mockClear()
    getProviderInstanceMock.mockReset()
    recordLifecycleMock.mockReset()
    chatOrchestratorMock.ingest.mockReset()

    activeProviderRef.value = null
    activeModelRef.value = null
    activeSessionIdRef.value = 'session-1'
    currentGeneration = 7
    chatOrchestratorMock.sending = false

    beforeComposeHooks.length = 0
    afterComposeHooks.length = 0
    beforeSendHooks.length = 0
    afterSendHooks.length = 0
    tokenLiteralHooks.length = 0
    tokenSpecialHooks.length = 0
    streamEndHooks.length = 0
    assistantEndHooks.length = 0
    assistantMessageHooks.length = 0
    turnCompleteHooks.length = 0
    contextUpdateHooks.length = 0
    serverEventHooks.clear()
  })

  afterEach(() => {
    closeTestChannels()
  })

  /**
   * @example
   * Broadcast context updates record store-ingested with core result fields.
   */
  it('records core ingest result for broadcast context updates', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      entryCount: 2,
      mutation: 'append',
      sourceKey: 'weather:station-1',
    })
    const store = useContextBridgeStore()
    await store.initialize()
    const contextSender = createTestChannel(CONTEXT_CHANNEL_NAME)

    contextSender.postMessage(createContextMessage({
      id: 'broadcast-context',
      metadata: createMetadata('weather', 'station-1'),
      text: 'broadcast weather',
    }))

    await vi.waitFor(() => {
      expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    })
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'broadcast',
      details: expect.objectContaining({
        entryCount: 2,
      }),
      mutation: 'append',
      phase: 'store-ingested',
      sourceKey: 'weather:station-1',
    }))

    await store.dispose()
  })

  /**
   * @example
   * Server context updates record store-ingested before broadcast-posted.
   */
  it('records core ingest result for server context updates before broadcasting', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      entryCount: 1,
      mutation: 'replace',
      sourceKey: 'weather:station-1',
    })
    const store = useContextBridgeStore()
    await store.initialize()

    await emitContextUpdate(createContextUpdateEvent({
      id: 'server-context',
      strategy: ContextUpdateStrategy.ReplaceSelf,
      text: 'server weather',
    }))

    expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'server',
      details: expect.objectContaining({
        entryCount: 1,
      }),
      mutation: 'replace',
      phase: 'store-ingested',
      sourceKey: 'weather:station-1',
    }))
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'broadcast',
      contextId: 'server-context',
      phase: 'broadcast-posted',
    }))

    await store.dispose()
  })

  /**
   * @example
   * Input context updates record store-ingested and stay in chat input payload.
   */
  it('records core ingest result for input context updates and forwards accepted updates', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      entryCount: 1,
      mutation: 'append',
      sourceKey: 'weather:station-1',
    })
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValueOnce({})
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      data: {
        contextUpdates: [
          {
            strategy: ContextUpdateStrategy.AppendSelf,
            text: 'input weather',
          },
        ],
        text: 'hello',
      },
      metadata: createMetadata('weather', 'station-1'),
      source: 'extension-module-host',
      type: 'input:text',
    })

    expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'input',
      details: expect.objectContaining({
        entryCount: 1,
        inputType: 'input:text',
      }),
      mutation: 'append',
      phase: 'store-ingested',
      sourceKey: 'weather:station-1',
    }))
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.data.contextUpdates).toEqual([
      expect.objectContaining({
        contextId: expect.any(String),
        id: expect.any(String),
        text: 'input weather',
      }),
    ])

    await store.dispose()
  })

  /**
   * @example
   * Broadcast context ingest failures record store-ingest-rejected instead of escaping.
   */
  it('records rejected lifecycle for broadcast ingest failures without interrupting the watcher', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone broadcast context')
    })
    const store = useContextBridgeStore()
    await store.initialize()
    const contextSender = createTestChannel(CONTEXT_CHANNEL_NAME)

    contextSender.postMessage(createContextMessage({
      id: 'bad-broadcast-context',
      metadata: createMetadata('weather', 'station-1'),
      text: 'bad broadcast weather',
    }))

    await vi.waitFor(() => {
      expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'broadcast',
        contextId: 'bad-broadcast-context',
        details: expect.objectContaining({
          errorMessage: 'Cannot clone broadcast context',
        }),
        phase: 'store-ingest-rejected',
      }))
    })

    await store.dispose()
  })

  /**
   * @example
   * Server context ingest failures are not rebroadcast.
   */
  it('records rejected lifecycle and skips broadcast when server context ingest fails', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone server context')
    })
    const postedContexts = collectChannelMessages(CONTEXT_CHANNEL_NAME)
    const store = useContextBridgeStore()
    await store.initialize()

    await emitContextUpdate(createContextUpdateEvent({
      id: 'bad-server-context',
      text: 'bad server weather',
    }))
    await waitForBroadcastDelivery()

    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'server',
      contextId: 'bad-server-context',
      details: expect.objectContaining({
        errorMessage: 'Cannot clone server context',
      }),
      phase: 'store-ingest-rejected',
    }))
    expect(recordLifecycleMock).not.toHaveBeenCalledWith(expect.objectContaining({
      contextId: 'bad-server-context',
      phase: 'broadcast-posted',
    }))
    expect(postedContexts).toHaveLength(0)

    await store.dispose()
  })

  /**
   * @example
   * Input context ingest failures drop only the failed context update.
   */
  it('records rejected lifecycle and continues text ingestion when input context ingest fails', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone input context')
    })
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValueOnce({})
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      data: {
        contextUpdates: [
          {
            strategy: ContextUpdateStrategy.AppendSelf,
            text: 'bad input weather',
          },
        ],
        text: 'hello',
      },
      metadata: createMetadata('weather', 'station-1'),
      source: 'extension-module-host',
      type: 'input:text',
    })

    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'input',
      details: expect.objectContaining({
        errorMessage: 'Cannot clone input context',
      }),
      phase: 'store-ingest-rejected',
    }))
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.data.contextUpdates).toEqual([])

    await store.dispose()
  })

  it('replays remote stream lifecycle into sending and stream store APIs', async () => {
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      composedMessage: [],
      contexts: {},
      message: { content: 'ping', role: 'user' },
    }

    streamSender.postMessage({ context, message: 'ping', sessionId: 'remote-session', type: 'before-send' })
    await vi.waitFor(() => {
      expect(chatOrchestratorMock.sending).toBe(true)
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })

    streamSender.postMessage({ context, literal: 'hello', sessionId: 'remote-session', type: 'token-literal' })
    await vi.waitFor(() => {
      expect(appendStreamLiteralMock).toHaveBeenCalledWith('hello')
    })

    streamSender.postMessage({ context, message: 'final answer', sessionId: 'remote-session', type: 'assistant-end' })
    await vi.waitFor(() => {
      expect(resetStreamMock).toHaveBeenCalledTimes(1)
    })

    // The bridge should call resetStream on follower tabs, not finalizeStream,
    // to avoid corrupting history by persisting a duplicate assistant message.
    expect(finalizeStreamMock).not.toHaveBeenCalled()
    expect(chatOrchestratorMock.sending).toBe(false)

    await store.dispose()
  })

  it('suppresses outbound broadcast while processing remote stream events', async () => {
    const outgoingStreamMessages = collectChannelMessages<{ sessionId: string }>(CHAT_STREAM_CHANNEL_NAME)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      composedMessage: [],
      contexts: {},
      message: { content: 'ping', role: 'user' },
    }

    await chatOrchestratorMock.emitTokenSpecialHooks('manual-special', context)
    await vi.waitFor(() => {
      expect(outgoingStreamMessages).toHaveLength(1)
    })

    streamSender.postMessage({ context, sessionId: 'remote-session', special: 'remote-special', type: 'token-special' })
    await waitForBroadcastDelivery()

    expect(outgoingStreamMessages.filter(message => message.sessionId === 'session-1')).toHaveLength(1)

    await store.dispose()
  })

  it('ignores remote literal and end events when generation guard is stale', async () => {
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      composedMessage: [],
      contexts: {},
      message: { content: 'ping', role: 'user' },
    }

    streamSender.postMessage({ context, message: 'ping', sessionId: 'remote-session', type: 'before-send' })
    await vi.waitFor(() => {
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })

    currentGeneration = 8
    streamSender.postMessage({ context, literal: 'stale-literal', sessionId: 'remote-session', type: 'token-literal' })
    await waitForBroadcastDelivery()

    streamSender.postMessage({ context, sessionId: 'remote-session', type: 'stream-end' })
    await waitForBroadcastDelivery()

    expect(appendStreamLiteralMock).not.toHaveBeenCalledWith('stale-literal')
    expect(finalizeStreamMock).not.toHaveBeenCalled()
    expect(chatOrchestratorMock.sending).toBe(true)

    await store.dispose()
  })
})

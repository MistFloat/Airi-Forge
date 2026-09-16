// @vitest-environment jsdom

import type { Tool } from '@xsai/shared-chat'
import type { Ref } from 'vue'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'

const mockResolveLlmTools = vi.hoisted(() => vi.fn<(options?: { customTools?: (() => Promise<Tool[]>) | Tool[] }) => Promise<Tool[]>>())
const mockGetProviderConfig = vi.hoisted(() => vi.fn(() => ({})))
const mockWidgetsTools = vi.hoisted(() => vi.fn<() => Promise<Tool[]>>(async () => []))
const mockWeatherTools = vi.hoisted(() => vi.fn<() => Promise<Tool[]>>(async () => []))
const mockImageJournalTools = vi.hoisted(() => vi.fn<() => Promise<Tool[]>>(async () => []))

interface MockBroadcastMessageEvent<T> {
  data: T
}

interface MockChatMessage {
  content: string
  id?: string
  role: string
  slices?: unknown[]
  tool_results?: Array<{ id: string, isError?: boolean, result: unknown }>
}
type MockListener = (event: MockBroadcastMessageEvent<unknown>) => void

interface MockState {
  activeSessionId: Ref<string>
  applyRemoteSnapshot: ReturnType<typeof vi.fn>
  cancelActiveSend: ReturnType<typeof vi.fn>
  getSessionMessages: ReturnType<typeof vi.fn>
  ingest: ReturnType<typeof vi.fn>
  sessionMessages: Ref<Record<string, MockChatMessage[]>>
  sessionMetas: Ref<Record<string, unknown>>
  setSessionMessages: ReturnType<typeof vi.fn>
}

class MockBroadcastChannel {
  static channels = new Map<string, Set<MockBroadcastChannel>>()
  static messages: unknown[] = []

  readonly name: string

  private readonly listeners = new Set<MockListener>()
  constructor(name: string) {
    this.name = name
    if (!MockBroadcastChannel.channels.has(name))
      MockBroadcastChannel.channels.set(name, new Set())
    MockBroadcastChannel.channels.get(name)?.add(this)
  }

  static reset() {
    for (const peers of MockBroadcastChannel.channels.values()) {
      for (const peer of peers)
        peer.listeners.clear()
    }
    MockBroadcastChannel.channels.clear()
    MockBroadcastChannel.messages = []
  }

  addEventListener(_type: 'message', listener: EventListener) {
    this.listeners.add(listener as unknown as MockListener)
  }

  close() {
    const peers = MockBroadcastChannel.channels.get(this.name)
    peers?.delete(this)
    this.listeners.clear()
    if (peers && peers.size === 0)
      MockBroadcastChannel.channels.delete(this.name)
  }

  postMessage(data: unknown) {
    MockBroadcastChannel.messages.push(data)

    const peers = MockBroadcastChannel.channels.get(this.name)
    if (!peers)
      return

    for (const peer of peers) {
      if (peer === this)
        continue

      for (const listener of peer.listeners)
        listener({ data })
    }
  }

  removeEventListener(_type: 'message', listener: EventListener) {
    this.listeners.delete(listener as unknown as MockListener)
  }
}

function assistantMessage(content: string): MockChatMessage {
  return {
    content,
    role: 'assistant',
    slices: [{ text: content, type: 'text' }],
    tool_results: [],
  }
}

function postedMessagesOfType<T extends string>(type: T) {
  return MockBroadcastChannel.messages.filter((message): message is Record<string, unknown> & { type: T } => {
    return typeof message === 'object'
      && message !== null
      && 'type' in message
      && message.type === type
  })
}

let mockState: MockState

vi.mock('@proj-airi/stage-ui/stores/chat/session-store', () => ({
  useChatSessionStore: () => ({
    activeSessionId: mockState.activeSessionId,
    applyRemoteSnapshot: mockState.applyRemoteSnapshot,
    getSessionMessages: mockState.getSessionMessages,
    getSnapshot: vi.fn(() => ({
      activeSessionId: mockState.activeSessionId.value,
      sessionMessages: mockState.sessionMessages.value,
      sessionMetas: mockState.sessionMetas.value,
    })),
    sessionMessages: mockState.sessionMessages,
    sessionMetas: mockState.sessionMetas,
    setSessionMessages: mockState.setSessionMessages,
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/chat/stream-store', () => ({
  useChatStreamStore: () => ({
    streamingMessage: ref({ content: '', role: 'assistant', slices: [], tool_results: [] }),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/chat', () => ({
  useChatOrchestratorStore: () => ({
    cancelActiveSend: mockState.cancelActiveSend,
    ingest: mockState.ingest,
    lastTurnOutputTokens: ref<number>(),
    sending: ref(false),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/chat/maintenance', () => ({
  useChatMaintenanceStore: () => ({
    cleanupMessages: vi.fn(),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/providers', () => ({
  useProvidersStore: () => ({
    getProviderConfig: mockGetProviderConfig,
    getProviderInstance: vi.fn(async () => ({ id: 'provider' })),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/provider-max-tokens', () => ({
  useProviderMaxTokensStore: () => ({
    getProviderMaxTokens: () => 65536,
    refresh: vi.fn(async () => {}),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeModel: computed(() => 'model-id'),
    activeProvider: computed(() => 'provider-id'),
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/llm-tool-resolver', async (importOriginal) => {
  const original = await importOriginal<typeof import('@proj-airi/stage-ui/stores/llm-tool-resolver')>()

  return {
    ...original,
    resolveLlmTools: mockResolveLlmTools,
  }
})

vi.mock('./tools/builtin/widgets', () => ({
  widgetsTools: mockWidgetsTools,
}))

vi.mock('./tools/builtin/agent-autonomy', () => ({
  agentAutonomyTools: vi.fn(async () => []),
}))

vi.mock('./tools/builtin/weather', () => ({
  weatherTools: mockWeatherTools,
}))

vi.mock('./tools/builtin/image-journal', () => ({
  imageJournalTools: mockImageJournalTools,
}))

describe('useChatSyncStore', async () => {
  const { useChatSyncStore } = await import('./chat-sync')

  function initializeAuthorityAndFollower() {
    const authorityStore = useChatSyncStore()
    authorityStore.initialize('authority')

    setActivePinia(createPinia())
    const followerStore = useChatSyncStore()
    followerStore.initialize('follower')

    return { authorityStore, followerStore }
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    MockBroadcastChannel.reset()
    vi.restoreAllMocks()

    const activeSessionId = ref('session-1')
    const sessionMessages = ref<Record<string, MockChatMessage[]>>({
      'session-1': [{ content: 'init', role: 'system' }],
    })
    const sessionMetas = ref<Record<string, unknown>>({})
    const applyRemoteSnapshot = vi.fn((snapshot: {
      activeSessionId: string
      sessionMessages: Record<string, MockChatMessage[]>
      sessionMetas: Record<string, unknown>
    }) => {
      activeSessionId.value = snapshot.activeSessionId
      sessionMessages.value = snapshot.sessionMessages
      sessionMetas.value = snapshot.sessionMetas
    })

    const setSessionMessages = vi.fn((sessionId: string, next: MockChatMessage[]) => {
      sessionMessages.value[sessionId] = next
    })

    const getSessionMessages = vi.fn((sessionId: string) => sessionMessages.value[sessionId] ?? [])

    const ingest = vi.fn(async () => {
      throw new Error('Remote sent 403 response: {"error":{"message":"This model is not available in your region.","code":403}}')
    })

    mockResolveLlmTools.mockReset()
    mockResolveLlmTools.mockResolvedValue([])
    mockWidgetsTools.mockReset()
    mockWidgetsTools.mockResolvedValue([])
    mockWeatherTools.mockReset()
    mockWeatherTools.mockResolvedValue([])
    mockImageJournalTools.mockReset()
    mockImageJournalTools.mockResolvedValue([])
    mockGetProviderConfig.mockClear()

    mockState = {
      activeSessionId,
      applyRemoteSnapshot,
      cancelActiveSend: vi.fn(),
      getSessionMessages,
      ingest,
      sessionMessages,
      sessionMetas,
      setSessionMessages,
    }

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    MockBroadcastChannel.reset()
  })

  it('routes a follower stop request to the active chat authority', async () => {
    const { followerStore } = initializeAuthorityAndFollower()

    await followerStore.requestCancel('session-1')

    expect(mockState.cancelActiveSend).toHaveBeenCalledWith('session-1')
  })

  it('stores command ingest errors in authority session history', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = useChatSyncStore()
    store.initialize('authority')

    const peer = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    peer.postMessage({
      command: 'ingest',
      payload: {
        sessionId: 'session-1',
        text: 'hello',
      },
      requestId: 'req-1',
      senderId: 'peer',
      type: 'command',
    })

    await vi.waitFor(() => {
      expect(mockState.ingest).toHaveBeenCalledTimes(1)
      expect(mockState.setSessionMessages).toHaveBeenCalledTimes(1)
    })

    const persistedMessages = mockState.sessionMessages.value['session-1']
    expect(persistedMessages).toHaveLength(2)
    expect(persistedMessages[1]?.role).toBe('error')
    expect(persistedMessages[1]?.content).toContain('This model is not available in your region')

    peer.close()
    store.dispose()
  })

  it('rejects follower ingest timeouts after thirty minutes', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = useChatSyncStore()
    store.initialize('follower')

    const pending = store.requestIngest({
      sessionId: 'session-1',
      text: 'hello timeout',
    })
    const expectedRejection = expect(pending).rejects.toThrow('Timed out waiting for chat authority response')

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)

    await expectedRejection

    store.dispose()
    vi.useRealTimers()
  })

  it('replaces the last failed turn before retrying', async () => {
    mockState.sessionMessages.value['session-1'] = [
      { content: 'init', role: 'system' },
      { content: 'hello-1', role: 'user' },
      { content: 'answer-1', role: 'assistant' },
      { content: 'hello', role: 'user' },
      { content: 'Remote sent 400 response', role: 'error' },
      { content: 'hello-3', role: 'user' },
      { content: 'answer-3', role: 'assistant' },
    ]
    mockState.ingest.mockResolvedValueOnce(undefined)

    const store = useChatSyncStore()
    store.initialize('authority')

    const peer = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    peer.postMessage({
      command: 'retry',
      payload: {
        index: 4,
        sessionId: 'session-1',
      },
      requestId: 'req-2',
      senderId: 'peer',
      type: 'command',
    })

    await vi.waitFor(() => {
      expect(mockState.setSessionMessages).toHaveBeenCalledWith('session-1', [
        { content: 'init', role: 'system' },
        { content: 'hello-1', role: 'user' },
        { content: 'answer-1', role: 'assistant' },
      ])
      expect(mockState.ingest).toHaveBeenCalledWith('hello', expect.any(Object), 'session-1')
    })

    const persistedMessages = mockState.sessionMessages.value['session-1']
    expect(persistedMessages).toEqual([
      { content: 'init', role: 'system' },
      { content: 'hello-1', role: 'user' },
      { content: 'answer-1', role: 'assistant' },
    ])

    peer.close()
    store.dispose()
  })

  it('rewinds from the source user turn when retry targets an assistant message', async () => {
    mockState.sessionMessages.value['session-1'] = [
      { content: 'init', role: 'system' },
      { content: 'hello-1', role: 'user' },
      { content: 'answer-1', role: 'assistant' },
      { content: 'hello-2', role: 'user' },
      { content: 'answer-2', role: 'assistant' },
      { content: 'hello-3', role: 'user' },
    ]
    mockState.ingest.mockResolvedValueOnce(undefined)

    const store = useChatSyncStore()
    store.initialize('authority')

    const peer = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    peer.postMessage({
      command: 'retry',
      payload: {
        index: 4,
        sessionId: 'session-1',
      },
      requestId: 'req-3',
      senderId: 'peer',
      type: 'command',
    })

    await vi.waitFor(() => {
      expect(mockState.setSessionMessages).toHaveBeenCalledWith('session-1', [
        { content: 'init', role: 'system' },
        { content: 'hello-1', role: 'user' },
        { content: 'answer-1', role: 'assistant' },
      ])
      expect(mockState.ingest).toHaveBeenCalledWith('hello-2', expect.any(Object), 'session-1')
    })

    peer.close()
    store.dispose()
  })

  it('keeps the follower chat window on its local session while applying remote snapshots', async () => {
    mockState.activeSessionId.value = 'session-2'
    mockState.sessionMessages.value = {
      'session-2': [{ content: 'chat-window', role: 'system' }],
    }

    const store = useChatSyncStore()
    store.initialize('follower')

    const authority = new MockBroadcastChannel('airi:stage-tamagotchi:chat-sync')
    authority.postMessage({
      authorityId: 'authority',
      snapshot: {
        activeSessionId: 'session-1',
        sessionMessages: {
          'session-1': [{ content: 'main-window', role: 'system' }],
          'session-2': [{ content: 'chat-window', role: 'system' }, { content: 'retry me', role: 'user' }],
        },
        sessionMetas: {},
      },
      type: 'session-snapshot',
    })

    await vi.waitFor(() => {
      expect(mockState.applyRemoteSnapshot).toHaveBeenCalledTimes(1)
    })

    expect(mockState.activeSessionId.value).toBe('session-2')
    expect(mockState.sessionMessages.value['session-2']).toEqual([
      { content: 'chat-window', role: 'system' },
      { content: 'retry me', role: 'user' },
    ])

    authority.close()
    store.dispose()
  })

  it('sends spotlight commands through shared request and response messages', async () => {
    mockState.ingest.mockImplementationOnce(async () => {
      mockState.sessionMessages.value['session-1'] = [
        ...(mockState.sessionMessages.value['session-1'] ?? []),
        assistantMessage('visible reply'),
      ]
    })

    const { authorityStore, followerStore } = initializeAuthorityAndFollower()
    const result = await followerStore.requestSpotlightIngest({ text: 'hello spotlight' })
    const spotlightCommands = postedMessagesOfType('command')
      .filter(message => message.command === 'spotlight-ingest')
    const responses = postedMessagesOfType('response')

    expect(result).toEqual({
      sessionId: 'session-1',
      visibleText: 'visible reply',
    })
    expect(spotlightCommands).toEqual([
      expect.objectContaining({
        command: 'spotlight-ingest',
        payload: {
          text: 'hello spotlight',
        },
        type: 'command',
      }),
    ])
    expect(responses).toEqual([
      expect.objectContaining({
        ok: true,
        result: {
          sessionId: 'session-1',
          visibleText: 'visible reply',
        },
        type: 'response',
      }),
    ])
    expect(mockState.ingest).toHaveBeenCalledWith('hello spotlight', expect.objectContaining({
      providerConfig: { maxTokens: 65536 },
      tools: expect.any(Function),
    }), 'session-1')
    expect(mockGetProviderConfig).toHaveBeenCalledTimes(1)

    authorityStore.dispose()
    followerStore.dispose()
  })

  it('uses an independent five minute timeout for spotlight requests', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = useChatSyncStore()
    store.initialize('follower')

    const pending = store.requestSpotlightIngest({ text: 'hello timeout' })
    const expectedRejection = expect(pending).rejects.toThrow('Spotlight response timed out')

    await vi.advanceTimersByTimeAsync(300000)

    await expectedRejection

    store.dispose()
    vi.useRealTimers()
  })

  it('reruns a tool call locally when this window is the authority', async () => {
    const execute = vi.fn<Tool['execute']>(async () => 'fresh result')
    const demoTool: Tool = {
      execute,
      function: {
        description: 'Demo tool',
        name: 'demo-tool',
        parameters: {
          properties: {},
          type: 'object',
        },
      },
      type: 'function',
    }
    mockWidgetsTools.mockResolvedValueOnce([demoTool])
    mockResolveLlmTools.mockImplementationOnce(async (options) => {
      if (typeof options?.customTools === 'function')
        return options.customTools()

      return options?.customTools ?? []
    })
    const initialMessages: MockChatMessage[] = [
      { content: 'run the tool', id: 'user-1', role: 'user' },
      {
        content: '',
        id: 'assistant-1',
        role: 'assistant',
        slices: [
          {
            toolCall: {
              args: '{ "value": 1 }',
              toolCallId: 'call-demo',
              toolCallType: 'function',
              toolName: 'demo-tool',
            },
            type: 'tool-call',
          },
        ],
        tool_results: [
          {
            id: 'call-demo',
            result: 'stale result',
          },
        ],
      },
    ]
    mockState.sessionMessages.value['session-1'] = initialMessages

    const store = useChatSyncStore()
    store.initialize('authority')

    await store.requestToolCallRerun({
      args: '{ "value": 2 }',
      messageId: 'assistant-1',
      sessionId: 'session-1',
      toolCallId: 'call-demo',
      toolName: 'demo-tool',
      toolset: 'widgets',
    })

    expect(mockResolveLlmTools).toHaveBeenCalledWith({ customTools: expect.any(Function) })
    expect(mockWidgetsTools).toHaveBeenCalledTimes(1)
    expect(mockWeatherTools).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ value: 2 }, {
      messages: initialMessages,
      toolCallId: 'call-demo',
    })
    expect(mockState.setSessionMessages).toHaveBeenCalledWith('session-1', [
      initialMessages[0],
      expect.objectContaining({
        id: 'assistant-1',
        tool_results: [
          {
            id: 'call-demo',
            result: 'fresh result',
          },
        ],
      }),
    ])

    store.dispose()
  })

  it('sends tool call rerun commands from followers', async () => {
    const store = useChatSyncStore()
    store.initialize('follower')

    const pending = store.requestToolCallRerun({
      args: '{ "value": 2 }',
      messageId: 'assistant-1',
      sessionId: 'session-1',
      toolCallId: 'call-demo',
      toolName: 'demo-tool',
      toolset: 'artistry',
    })
    pending.catch(() => {})

    const rerunCommands = postedMessagesOfType('command')
      .filter(message => message.command === 'tool-call-rerun')

    expect(rerunCommands).toEqual([
      expect.objectContaining({
        command: 'tool-call-rerun',
        payload: {
          args: '{ "value": 2 }',
          messageId: 'assistant-1',
          sessionId: 'session-1',
          toolCallId: 'call-demo',
          toolName: 'demo-tool',
          toolset: 'artistry',
        },
        type: 'command',
      }),
    ])

    store.dispose()
    await expect(pending).rejects.toThrow('Chat sync channel disposed')
  })
})

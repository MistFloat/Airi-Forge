import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isToolRelatedError, useLLM } from './llm'
import { useLlmToolsStore } from './llm-tools'

const {
  createSparkCommandToolMock,
  debugMock,
  mcpMock,
  skillToolsMock,
  streamTextMock,
} = vi.hoisted(() => ({
  createSparkCommandToolMock: vi.fn(async (): Promise<unknown> => [{
    description: '',
    execute: vi.fn(),
    name: 'spark',
    parameters: {},
  }]),
  debugMock: vi.fn(async (): Promise<Tool[]> => []),
  mcpMock: vi.fn(async (): Promise<Tool[]> => []),
  skillToolsMock: vi.fn(async (): Promise<Tool[]> => []),
  streamTextMock: vi.fn(),
}))

vi.mock('@xsai/model', () => ({
  listModels: vi.fn(),
}))

vi.mock('@xsai/stream-text', () => ({
  streamText: streamTextMock,
}))

vi.mock('@xsai/shared-chat', () => ({
  stepCountAtLeast: vi.fn(),
}))

vi.mock('../tools', () => ({
  createSparkCommandTool: createSparkCommandToolMock,
  debug: debugMock,
  mcp: mcpMock,
  skillTools: skillToolsMock,
}))

const provider = {
  chat: () => ({
    baseURL: 'https://example.com/',
  }),
} as unknown as ChatProvider

function createMockStreamResult() {
  return {
    messages: Promise.resolve([]),
    steps: Promise.resolve([]),
    totalUsage: Promise.resolve({}),
    usage: Promise.resolve({}),
  }
}

function toolNameFrom(tool: unknown) {
  if (typeof tool !== 'object' || tool === null)
    return undefined

  const candidate = tool as {
    function?: {
      name?: string
    }
    name?: string
  }

  return candidate.function?.name ?? candidate.name
}

describe('isToolRelatedError', () => {
  beforeEach(() => {
    streamTextMock.mockReset()
    mcpMock.mockClear()
    debugMock.mockClear()
    createSparkCommandToolMock.mockClear()
    skillToolsMock.mockClear()
    setActivePinia(createPinia())
  })

  const positives: [provider: string, msg: string][] = [
    ['ollama', 'llama3 does not support tools'],
    ['ollama', 'phi does not support tools'],
    ['openrouter', 'No endpoints found that support tool use'],
    ['openai-compatible', 'Invalid schema for function \'myFunc\': \'dict\' is not valid under any of the given schemas'],
    ['openai-compatible', 'invalid_function_parameters'],
    ['openai-compatible', 'invalid function parameters'],
    ['azure', 'Functions are not supported at this time'],
    ['azure', 'Unrecognized request argument supplied: tools'],
    ['azure', 'Unrecognized request arguments supplied: tool_choice, tools'],
    ['google', 'Tool use with function calling is unsupported'],
    ['groq', 'tool_use_failed'],
    ['groq', 'Error code: tool_use_failed - Failed to call a function'],
    ['anthropic', 'This model does not support function calling'],
    ['anthropic', 'does not support function_calling'],
    ['cloudflare', 'tools is not supported'],
    ['cloudflare', 'tool is not supported for this model'],
    ['cloudflare', 'tools are not supported'],
  ]

  const negatives = [
    'network error',
    'timeout',
    'rate limit exceeded',
    'invalid api key',
    'model not found',
    'context length exceeded',
    '',
  ]

  for (const [provider, msg] of positives) {
    it(`matches [${provider}]: "${msg}"`, () => {
      expect(isToolRelatedError(msg)).toBe(true)
      expect(isToolRelatedError(new Error(msg))).toBe(true)
    })
  }

  for (const msg of negatives) {
    it(`rejects: "${msg}"`, () => {
      expect(isToolRelatedError(msg)).toBe(false)
      expect(isToolRelatedError(new Error(msg))).toBe(false)
    })
  }

  it('resolves from steps while still forwarding tool_calls finish events', async () => {
    let onEvent: ((event: unknown) => Promise<void>) | undefined
    streamTextMock.mockImplementation((options: { onEvent: (event: unknown) => Promise<void> }) => {
      onEvent = options.onEvent
      return createMockStreamResult()
    })

    const store = useLLM()
    const onStreamEvent = vi.fn()
    let resolved = false

    const pending = store.stream('model-a', provider, [{ content: 'hello', role: 'user' }] as Message[], {
      onStreamEvent,
      waitForTools: true,
    }).then(() => {
      resolved = true
    })

    await vi.waitFor(() => expect(onEvent).toBeTypeOf('function'))
    await onEvent!({ finishReason: 'tool_calls', type: 'finish' })
    await Promise.resolve()
    expect(resolved).toBe(true)

    await onEvent!({ finishReason: 'stop', type: 'finish' })
    await pending

    expect(onStreamEvent).toHaveBeenCalledTimes(2)
  })

  it('ignores later error events after steps have resolved', async () => {
    let onEvent: ((event: unknown) => Promise<void>) | undefined
    streamTextMock.mockImplementation((options: { onEvent: (event: unknown) => Promise<void> }) => {
      onEvent = options.onEvent
      return createMockStreamResult()
    })

    const store = useLLM()
    const pending = store.stream('model-a', provider, [{ content: 'hello', role: 'user' }] as Message[], {
      waitForTools: true,
    })

    await vi.waitFor(() => expect(onEvent).toBeTypeOf('function'))
    await onEvent!({ finishReason: 'tool_calls', type: 'finish' })
    await onEvent!({ error: new Error('stream failed'), type: 'error' })
    await expect(pending).resolves.toBeUndefined()
  })

  it('keeps builtin tools when stream steps resolve before a tool-related error event', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const customTool = { name: 'custom-tool' } as any
    const runtimeTool = {
      execute: vi.fn(),
      function: {
        description: 'Start a runtime chess match.',
        name: 'runtime_play_chess_match',
        parameters: { properties: {}, type: 'object' },
      },
    }

    llmToolsStore.registerTools('plugin-tools', [runtimeTool as any])

    streamTextMock.mockImplementationOnce((options: { onEvent: (event: unknown) => Promise<void>, tools?: unknown[] }) => {
      queueMicrotask(async () => {
        await options.onEvent({ error: new Error('model does not support tools'), type: 'error' })
      })
      return createMockStreamResult()
    })

    await expect(store.stream('model-a', provider, [{ content: 'hello', role: 'user' }] as Message[], {
      tools: [customTool],
    })).resolves.toBeUndefined()

    const firstCallTools = streamTextMock.mock.calls[0]?.[0]?.tools
    expect(Array.isArray(firstCallTools)).toBe(true)
    expect(mcpMock).toHaveBeenCalledTimes(1)
    expect(debugMock).toHaveBeenCalledTimes(1)
    expect(firstCallTools).toContain(customTool)
    expect(firstCallTools?.map(toolNameFrom)).toContain('runtime_play_chess_match')

    streamTextMock.mockImplementationOnce((options: { onEvent: (event: unknown) => Promise<void>, tools?: unknown[] }) => {
      queueMicrotask(async () => {
        await options.onEvent({ finishReason: 'stop', type: 'finish' })
      })
      return createMockStreamResult()
    })

    await store.stream('model-a', provider, [{ content: 'hello again', role: 'user' }] as Message[], {
      tools: [customTool],
    })

    const secondCallTools = streamTextMock.mock.calls[1]?.[0]?.tools
    expect(Array.isArray(secondCallTools)).toBe(true)
    expect(secondCallTools?.map(toolNameFrom)).toContain('runtime_play_chess_match')
  })

  it('merges runtime-registered tools from the llm-tools store into the builtin tool resolver', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const playChessTool = {
      execute: vi.fn(),
      function: {
        description: 'Open the runtime chess board.',
        name: 'runtime_open_chess_board',
        parameters: { properties: {}, type: 'object' },
      },
    }
    const runtimeMcpStatusTool = {
      execute: vi.fn(),
      function: {
        description: 'Sync runtime MCP status.',
        name: 'runtime_sync_mcp_status',
        parameters: { properties: {}, type: 'object' },
      },
    }

    llmToolsStore.registerTools('mcp', [runtimeMcpStatusTool as any])
    llmToolsStore.registerTools('plugin-tools', [playChessTool as any])

    streamTextMock.mockImplementationOnce((options: { onEvent: (event: unknown) => Promise<void>, tools?: unknown[] }) => {
      queueMicrotask(async () => {
        await options.onEvent({ finishReason: 'stop', type: 'finish' })
      })
      return createMockStreamResult()
    })

    await store.stream('model-a', provider, [{ content: 'play chess', role: 'user' }] as Message[])

    const mergedTools = streamTextMock.mock.calls[0]?.[0]?.tools
    expect(mergedTools).toEqual(expect.arrayContaining([runtimeMcpStatusTool, playChessTool]))
  })

  it('prefers runtime-registered tools when duplicate tool names collide with builtin tools', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const builtinTool = {
      execute: vi.fn(),
      function: {
        description: 'Builtin version.',
        name: 'duplicate_runtime_tool',
        parameters: { properties: {}, type: 'object' },
      },
    } as unknown as Tool
    const runtimeTool = {
      execute: vi.fn(),
      function: {
        description: 'Runtime version.',
        name: 'duplicate_runtime_tool',
        parameters: { properties: {}, type: 'object' },
      },
    }

    mcpMock.mockResolvedValueOnce([builtinTool] as Tool[])
    llmToolsStore.registerTools('plugin-tools', [runtimeTool as any])

    streamTextMock.mockImplementationOnce((options: { onEvent: (event: unknown) => Promise<void>, tools?: unknown[] }) => {
      queueMicrotask(async () => {
        await options.onEvent({ finishReason: 'stop', type: 'finish' })
      })
      return createMockStreamResult()
    })

    await store.stream('model-a', provider, [{ content: 'play chess', role: 'user' }] as Message[])

    const mergedTools = streamTextMock.mock.calls[0]?.[0]?.tools as Array<{ function?: { name?: string } }>
    const duplicateNameTools = mergedTools.filter(tool => tool.function?.name === 'duplicate_runtime_tool')

    expect(duplicateNameTools).toHaveLength(1)
    expect(duplicateNameTools[0]).toMatchObject({
      function: {
        description: 'Runtime version.',
        name: 'duplicate_runtime_tool',
      },
    })
  })

  /**
   * @example
   * llmToolsStore.registerTools('plugin-tools', pendingRuntimeTools)
   * await store.stream('model-a', provider, messages)
   */
  it('waits for pending runtime tool registrations before building stream tools', async () => {
    const store = useLLM()
    const llmToolsStore = useLlmToolsStore()
    const runtimeTool = {
      execute: vi.fn(),
      function: {
        description: 'Pending runtime tool.',
        name: 'runtime_pending_tool',
        parameters: { properties: {}, type: 'object' },
      },
    }
    let resolveTools: ((tools: unknown[]) => void) | undefined
    const pendingTools = new Promise<unknown[]>((resolve) => {
      resolveTools = resolve
    })

    llmToolsStore.registerTools('plugin-tools', pendingTools as Promise<any[]>)

    streamTextMock.mockImplementationOnce((options: { onEvent: (event: unknown) => Promise<void>, tools?: unknown[] }) => {
      queueMicrotask(async () => {
        await options.onEvent({ finishReason: 'stop', type: 'finish' })
      })
      return createMockStreamResult()
    })

    const pendingStream = store.stream('model-a', provider, [{ content: 'play chess', role: 'user' }] as Message[])
    await Promise.resolve()

    expect(streamTextMock).not.toHaveBeenCalled()

    resolveTools?.([runtimeTool])
    await pendingStream

    const mergedTools = streamTextMock.mock.calls[0]?.[0]?.tools
    expect(mergedTools?.map(toolNameFrom)).toContain('runtime_pending_tool')
  })
})

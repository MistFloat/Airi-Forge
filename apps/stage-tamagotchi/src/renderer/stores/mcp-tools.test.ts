import type { Tool } from '@xsai/shared-chat'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(async () => ({
    content: [{ text: 'ok', type: 'text' }],
    isError: false,
  })),
  listMcpTools: vi.fn(async () => [{
    description: 'Search files.',
    inputSchema: {
      properties: {},
      type: 'object',
    },
    name: 'filesystem::search',
    serverName: 'filesystem',
    toolName: 'search',
  }]),
}))

const memoryMocks = vi.hoisted(() => ({
  recallMemories: vi.fn(async () => ({
    memories: [],
    trace: { candidates: [], originalText: '', retrievalId: 'retrieval-1', terms: [] },
  })),
  saveMemory: vi.fn(async () => 'memory-1'),
}))

vi.mock('@proj-airi/stage-ui/stores/modules/memory-long-term', () => ({
  useMemoryLongTermStore: () => memoryMocks,
}))

let progressListener: ((event: { body?: unknown }) => void) | undefined

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaContext: () => ({
    value: {
      on: (_eventa: unknown, listener: (event: { body?: unknown }) => void) => {
        progressListener = listener
        return () => {
          progressListener = undefined
        }
      },
    },
  }),
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:list-tools-receive')
      return invokeMocks.listMcpTools
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:call-tool-receive')
      return invokeMocks.callMcpTool

    throw new Error(`Unexpected eventa invoke: ${JSON.stringify(event)}`)
  },
}))

describe('useTamagotchiMcpToolsStore', async () => {
  const { useTamagotchiMcpToolsStore } = await import('./mcp-tools')

  beforeEach(() => {
    setActivePinia(createPinia())
    progressListener = undefined
    invokeMocks.listMcpTools.mockClear()
    invokeMocks.callMcpTool.mockClear()
    memoryMocks.recallMemories.mockClear()
    memoryMocks.saveMemory.mockClear()
  })

  /**
   * @example
   * await store.refresh()
   * expect(llmToolsStore.toolsByProvider.mcp).toHaveLength(3)
   */
  it('loads MCP tools, proxies execution, and clears them from the shared llm-tools store', async () => {
    const llmToolsStore = useLlmToolsStore()
    const store = useTamagotchiMcpToolsStore()
    const toolOptions = {} as Parameters<Tool['execute']>[1]

    await store.refresh()

    const mcpTools = llmToolsStore.toolsByProvider.mcp
    const listTools = mcpTools?.find(tool => tool.function.name === 'builtIn_mcpListTools')
    const callTool = mcpTools?.find(tool => tool.function.name === 'builtIn_mcpCallTool')
    const directTool = mcpTools?.find(tool => tool.function.name === 'filesystem__search')
    const memorySearch = mcpTools?.find(tool => tool.function.name === 'memory__search')

    // 2 meta-tools + 1 external direct tool + 2 built-in memory MCP tools.
    expect(mcpTools).toHaveLength(5)
    expect(mcpTools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: 'builtIn_mcpListTools' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'builtIn_mcpCallTool' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'filesystem__search' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'memory__remember' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'memory__search' }) }),
    ])

    const listResult = await listTools?.execute({}, toolOptions)
    const callResult = await callTool?.execute({
      arguments: JSON.stringify({ limit: 10, query: 'hello' }),
      name: 'filesystem::search',
    }, toolOptions)

    // Direct tool: model calls `filesystem__search` by sanitized name
    const directResult = await directTool?.execute({ limit: 10, query: 'hello' }, toolOptions)
    await memorySearch?.execute({ limit: 3, query: 'answer style' }, toolOptions)

    expect(invokeMocks.listMcpTools).toHaveBeenCalledTimes(1)
    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith({
      arguments: { limit: 10, query: 'hello' },
      name: 'filesystem::search',
    })
    expect(listResult).toHaveLength(3)
    expect(listResult).toEqual(expect.arrayContaining([{
      description: 'Search files.',
      inputSchema: {
        properties: {},
        type: 'object',
      },
      name: 'filesystem::search',
      serverName: 'filesystem',
      toolName: 'search',
    }]))
    expect(callResult).toEqual({
      content: [{ text: 'ok', type: 'text' }],
      isError: false,
    })
    // Direct tool returns the same result shape as the meta-tool
    expect(directResult).toEqual({
      content: [{ text: 'ok', type: 'text' }],
      isError: false,
    })
    // callMcpTool was invoked twice: once via meta-tool, once via direct tool
    expect(invokeMocks.callMcpTool).toHaveBeenCalledTimes(2)
    expect(memoryMocks.recallMemories).toHaveBeenCalledWith('answer style', { maxResults: 3 })

    store.dispose()

    expect(llmToolsStore.toolsByProvider.mcp).toBeUndefined()
  })

  it('registers a progress-aware renderer for every discovered MCP tool name', async () => {
    const store = useTamagotchiMcpToolsStore()

    await store.refresh()

    expect(store.mcpToolCallRenderers.filesystem__search).toBeDefined()
    expect(store.mcpToolCallRenderers.unknown__tool).toBeUndefined()
  })

  it('stores the latest progress event for the executing tool', async () => {
    const store = useTamagotchiMcpToolsStore()

    expect(progressListener).toBeDefined()
    progressListener?.({
      body: {
        message: 'scanning',
        name: 'filesystem::search',
        progress: 3,
        total: 10,
      },
    })

    expect(store.lastToolProgress).toEqual({
      message: 'scanning',
      name: 'filesystem::search',
      progress: 3,
      total: 10,
    })

    store.dispose()
    expect(progressListener).toBeUndefined()
  })
})

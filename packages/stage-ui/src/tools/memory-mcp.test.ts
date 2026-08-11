import { describe, expect, it, vi } from 'vitest'

import { createMemoryMcpRuntime } from './memory-mcp'

describe('createMemoryMcpRuntime', () => {
  it('lets the agent explicitly persist a long-term memory', async () => {
    const saveMemory = vi.fn(async () => 'memory-1')
    const runtime = createMemoryMcpRuntime({
      recallMemories: vi.fn(),
      saveMemory,
    })

    const result = await runtime.callTool({
      arguments: {
        content: 'The user prefers concise answers.',
        importance: 0.8,
        kind: 'preference',
        tags: ['communication'],
        title: 'Answer style',
      },
      name: 'memory::remember',
    })

    expect(saveMemory).toHaveBeenCalledWith({
      confidence: 1,
      content: 'The user prefers concise answers.',
      importance: 0.8,
      kind: 'preference',
      status: 'active',
      tags: ['communication', 'agent-authored'],
      title: 'Answer style',
    }, { createdBy: 'agent' })
    expect(result.structuredContent).toEqual({ memoryId: 'memory-1', stored: true })
  })

  it('uses the configured embedding recall pipeline to search memories', async () => {
    const recallMemories = vi.fn(async () => ({
      memories: [{ content: 'Use concise answers.', memoryId: 'memory-1', retrievalId: 'retrieval-1', similarity: 0.91, title: 'Answer style' }],
      trace: { candidates: [], originalText: 'answer style', retrievalId: 'retrieval-1', terms: ['answer', 'style'] },
    }))
    const runtime = createMemoryMcpRuntime({ recallMemories, saveMemory: vi.fn() })

    const result = await runtime.callTool({
      arguments: { limit: 3, query: 'answer style' },
      name: 'memory::search',
    })

    expect(recallMemories).toHaveBeenCalledWith('answer style', { maxResults: 3 })
    expect(result.structuredContent).toEqual({
      memories: [{ content: 'Use concise answers.', memoryId: 'memory-1', similarity: 0.91, title: 'Answer style' }],
      query: 'answer style',
      retrievalId: 'retrieval-1',
    })
  })
})

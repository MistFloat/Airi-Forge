import { describe, expect, it, vi } from 'vitest'

import { createMemoryMcpRuntime } from './memory-mcp'

describe('createMemoryMcpRuntime', () => {
  it('lets the agent explicitly persist a long-term memory', async () => {
    const saveMemory = vi.fn(async () => 'memory-1')
    const runtime = createMemoryMcpRuntime({
      saveMemory,
      searchEvidenceText: vi.fn(),
      searchMemoriesText: vi.fn(),
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

  it('searches agent-authored long-term memory by text', async () => {
    const searchMemoriesText = vi.fn(async () => ([
      { content: 'Use concise answers.', createdBy: 'agent', memoryId: 'memory-1', title: 'Answer style' },
    ]))
    const runtime = createMemoryMcpRuntime({ saveMemory: vi.fn(), searchEvidenceText: vi.fn(), searchMemoriesText })

    const result = await runtime.callTool({
      arguments: { limit: 3, query: 'answer style' },
      name: 'memory::search_memories',
    })

    expect(searchMemoriesText).toHaveBeenCalledWith('answer style', { limit: 3 })
    expect(result.structuredContent).toEqual({
      memories: [{ content: 'Use concise answers.', createdBy: 'agent', memoryId: 'memory-1', title: 'Answer style' }],
      query: 'answer style',
    })
  })

  it('searches raw conversation evidence by text', async () => {
    const searchEvidenceText = vi.fn(async () => ([
      { content: 'Please use concise answers.', id: 'evidence-1', sourceRole: 'user', sourceType: 'user_assertion' },
    ]))
    const runtime = createMemoryMcpRuntime({ saveMemory: vi.fn(), searchEvidenceText, searchMemoriesText: vi.fn() })

    const result = await runtime.callTool({
      arguments: { limit: 4, query: 'concise' },
      name: 'memory::search_evidence',
    })

    expect(searchEvidenceText).toHaveBeenCalledWith('concise', { limit: 4 })
    expect(result.structuredContent).toEqual({
      evidence: [{ content: 'Please use concise answers.', evidenceId: 'evidence-1', sourceRole: 'user', sourceType: 'user_assertion' }],
      query: 'concise',
    })
  })

  it('exposes exactly the three explicit memory tools', async () => {
    const runtime = createMemoryMcpRuntime({ saveMemory: vi.fn(), searchEvidenceText: vi.fn(), searchMemoriesText: vi.fn() })

    expect((await runtime.listTools()).map(tool => tool.name)).toEqual([
      'memory::remember',
      'memory::search_memories',
      'memory::search_evidence',
    ])
  })
})

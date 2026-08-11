import type { LongTermMemoryDraft, LongTermMemoryRecallResult, LongTermMemoryRecallTrace } from '../stores/modules/memory-long-term'
import type { McpCallToolResult, McpToolRuntime } from './mcp'

/** Long-term memory operations exposed through the built-in memory MCP. */
export interface MemoryMcpPort {
  recallMemories: (query: string, options?: { maxResults?: number }) => Promise<{
    memories: LongTermMemoryRecallResult[]
    trace: LongTermMemoryRecallTrace
  }>
  saveMemory: (draft: LongTermMemoryDraft, options?: { createdBy?: 'agent' | 'user' }) => Promise<string>
}

const memoryToolDescriptors = [
  {
    description: 'Persist information in AIRI long-term memory when it is stable and genuinely useful in future conversations. Do not store transient task details, guesses, secrets, or information the user did not provide.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        content: { description: 'Self-contained memory content.', minLength: 1, type: 'string' },
        importance: { default: 0.7, maximum: 1, minimum: 0, type: 'number' },
        kind: { enum: ['fact', 'preference', 'summary'], type: 'string' },
        tags: { items: { type: 'string' }, type: 'array' },
        title: { description: 'Short descriptive title.', minLength: 1, type: 'string' },
      },
      required: ['content', 'kind', 'title'],
      type: 'object',
    },
    name: 'memory::remember',
    serverName: 'memory',
    toolName: 'remember',
  },
  {
    description: 'Semantically search AIRI long-term memory with the configured Embedding model. Use this when prior user facts, preferences, or summaries may help the current task.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: { default: 5, maximum: 10, minimum: 1, type: 'integer' },
        query: { description: 'Meaning-focused search query.', minLength: 1, type: 'string' },
      },
      required: ['query'],
      type: 'object',
    },
    name: 'memory::search',
    serverName: 'memory',
    toolName: 'search',
  },
] satisfies Awaited<ReturnType<McpToolRuntime['listTools']>>

/** Creates the built-in MCP surface backed by AIRI's configured pgvector memory store. */
export function createMemoryMcpRuntime(memory: MemoryMcpPort): McpToolRuntime {
  return {
    async callTool(payload) {
      if (payload.name === 'memory::remember')
        return await remember(payload.arguments, memory)
      if (payload.name === 'memory::search')
        return await search(payload.arguments, memory)
      throw new Error(`Unknown memory MCP tool: ${payload.name}`)
    },
    async listTools() {
      return memoryToolDescriptors
    },
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

async function remember(args: Record<string, unknown> | undefined, memory: MemoryMcpPort): Promise<McpCallToolResult> {
  const content = requiredString(args?.content, 'content')
  const title = requiredString(args?.title, 'title')
  const kind = args?.kind
  if (kind !== 'fact' && kind !== 'preference' && kind !== 'summary')
    throw new Error('kind must be fact, preference, or summary')

  const importance = boundedNumber(args?.importance, 0.7, 0, 1)
  const tags = Array.isArray(args?.tags)
    ? args.tags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()).map(tag => tag.trim())
    : []
  const memoryId = await memory.saveMemory({
    confidence: 1,
    content,
    importance,
    kind,
    status: 'active',
    tags: [...new Set([...tags, 'agent-authored'])],
    title,
  }, { createdBy: 'agent' })

  return {
    content: [{ text: `Stored long-term memory ${memoryId}.`, type: 'text' }],
    structuredContent: { memoryId, stored: true },
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is required`)
  return value.trim()
}

async function search(args: Record<string, unknown> | undefined, memory: MemoryMcpPort): Promise<McpCallToolResult> {
  const query = requiredString(args?.query, 'query')
  const limit = Math.trunc(boundedNumber(args?.limit, 5, 1, 10))
  const result = await memory.recallMemories(query, { maxResults: limit })
  const memories = result.memories.map(item => ({
    content: item.content,
    memoryId: item.memoryId,
    similarity: item.similarity,
    title: item.title,
  }))
  return {
    content: [{ text: memories.length ? JSON.stringify(memories, null, 2) : 'No matching long-term memories found.', type: 'text' }],
    structuredContent: { memories, query, retrievalId: result.trace.retrievalId },
  }
}

import type { LongTermMemoryDraft, LongTermMemoryEvidence, LongTermMemoryItem } from '../stores/modules/memory-long-term'
import type { McpCallToolResult, McpToolRuntime } from './mcp'

/** Long-term memory operations exposed through the built-in memory MCP. */
export interface MemoryMcpPort {
  saveMemory: (draft: LongTermMemoryDraft, options?: { createdBy?: 'agent' | 'user' }) => Promise<string>
  searchEvidenceText: (query: string, options?: { limit?: number }) => Promise<Array<Pick<LongTermMemoryEvidence, 'content' | 'id' | 'sourceRole' | 'sourceType'>>>
  searchMemoriesText: (query: string, options?: { limit?: number }) => Promise<Array<Pick<LongTermMemoryItem, 'content' | 'createdBy' | 'memoryId' | 'title'>>>
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
    description: 'Search explicitly authored long-term memories by words or phrases.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: { default: 5, maximum: 10, minimum: 1, type: 'integer' },
        query: { description: 'Word or phrase to find in long-term memory.', minLength: 1, type: 'string' },
      },
      required: ['query'],
      type: 'object',
    },
    name: 'memory::search_memories',
    serverName: 'memory',
    toolName: 'search_memories',
  },
  {
    description: 'Search immutable raw user and assistant conversation evidence by words or phrases.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        limit: { default: 5, maximum: 10, minimum: 1, type: 'integer' },
        query: { description: 'Word or phrase to find in original conversation evidence.', minLength: 1, type: 'string' },
      },
      required: ['query'],
      type: 'object',
    },
    name: 'memory::search_evidence',
    serverName: 'memory',
    toolName: 'search_evidence',
  },
] satisfies Awaited<ReturnType<McpToolRuntime['listTools']>>

/** Creates the built-in MCP surface backed by AIRI's configured pgvector memory store. */
export function createMemoryMcpRuntime(memory: MemoryMcpPort): McpToolRuntime {
  return {
    async callTool(payload) {
      if (payload.name === 'memory::remember')
        return await remember(payload.arguments, memory)
      if (payload.name === 'memory::search_memories')
        return await searchMemories(payload.arguments, memory)
      if (payload.name === 'memory::search_evidence')
        return await searchEvidence(payload.arguments, memory)
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

async function searchEvidence(args: Record<string, unknown> | undefined, memory: MemoryMcpPort): Promise<McpCallToolResult> {
  const query = requiredString(args?.query, 'query')
  const limit = Math.trunc(boundedNumber(args?.limit, 5, 1, 10))
  const result = await memory.searchEvidenceText(query, { limit })
  const evidence = result.map(item => ({
    content: item.content,
    evidenceId: item.id,
    sourceRole: item.sourceRole,
    sourceType: item.sourceType,
  }))
  return {
    content: [{ text: evidence.length ? JSON.stringify(evidence, null, 2) : 'No matching original evidence found.', type: 'text' }],
    structuredContent: { evidence, query },
  }
}

async function searchMemories(args: Record<string, unknown> | undefined, memory: MemoryMcpPort): Promise<McpCallToolResult> {
  const query = requiredString(args?.query, 'query')
  const limit = Math.trunc(boundedNumber(args?.limit, 5, 1, 10))
  const result = await memory.searchMemoriesText(query, { limit })
  const memories = result.map(item => ({
    content: item.content,
    createdBy: item.createdBy,
    memoryId: item.memoryId,
    title: item.title,
  }))
  return {
    content: [{ text: memories.length ? JSON.stringify(memories, null, 2) : 'No matching long-term memories found.', type: 'text' }],
    structuredContent: { memories, query },
  }
}

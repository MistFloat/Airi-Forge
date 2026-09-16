import { createMemoryMcpRuntime } from '@proj-airi/stage-ui/tools/memory-mcp'
import { describe, expect, it } from 'vitest'

import { createPgvectorMemoryServer } from './index'

describe('pgvector memory HTTP gateway', () => {
  it('accepts renderer preflight requests', async () => {
    const memoryServer = await createPgvectorMemoryServer()
    await memoryServer.serverManager.start()

    try {
      const response = await fetch('http://127.0.0.1:6123/api/v1/memory/health', {
        headers: {
          'Access-Control-Request-Headers': 'content-type',
          'Access-Control-Request-Method': 'POST',
          'Origin': 'http://localhost:5173',
        },
        method: 'OPTIONS',
      })

      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    }
    finally {
      await memoryServer.serverManager.stop()
    }
  })

  // Root cause:
  // When PostgreSQL is unavailable, every route handler catches the connection
  // error and returns `jsonError(error)`. Previously `jsonError` created a bare
  // `Response` with only `Content-Type` — no `Access-Control-Allow-Origin` —
  // so the browser blocked the response and reported a CORS error, masking
  // the real 500 with a misleading cross-origin failure.
  //
  // Fixed by including CORS headers in `jsonError` and changing the default
  // status from 502 (Bad Gateway — wrong for an origin server) to 500.
  it('includes CORS headers on error responses so the browser does not mask the real status', async () => {
    const memoryServer = await createPgvectorMemoryServer()
    await memoryServer.serverManager.start()

    try {
      // /health requires a valid PostgreSQL connection string; an invalid one
      // triggers the error path without needing to mock the database layer.
      const response = await fetch('http://127.0.0.1:6123/api/v1/memory/health', {
        body: JSON.stringify({ connectionString: 'postgresql://nobody:nopass@127.0.0.1:1/nonexistent' }),
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:5173' },
        method: 'POST',
      })

      expect(response.status).toBe(500)
      // The CORS header must be present so the browser exposes the body to
      // the renderer's fetch caller instead of blocking it as cross-origin.
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('content-type')).toContain('application/json')
    }
    finally {
      await memoryServer.serverManager.stop()
    }
  })

  // The /ping endpoint is a lightweight liveness probe that does NOT touch
  // PostgreSQL. The renderer circuit breaker can use it to distinguish
  // "HTTP gateway process is down" from "database is unreachable".
  it('responds 200 on /ping without a database connection', async () => {
    const memoryServer = await createPgvectorMemoryServer()
    await memoryServer.serverManager.start()

    try {
      const response = await fetch('http://127.0.0.1:6123/api/v1/memory/ping', {
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:5173' },
        method: 'POST',
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      const body = await response.json()
      expect(body.ok).toBe(true)
      expect(body.service).toBe('memory-pgvector')
      expect(body.timestamp).toBeTypeOf('number')
    }
    finally {
      await memoryServer.serverManager.stop()
    }
  })

  it('accepts OPTIONS preflight on /ping', async () => {
    const memoryServer = await createPgvectorMemoryServer()
    await memoryServer.serverManager.start()

    try {
      const response = await fetch('http://127.0.0.1:6123/api/v1/memory/ping', {
        headers: {
          'Access-Control-Request-Headers': 'content-type',
          'Access-Control-Request-Method': 'POST',
          'Origin': 'http://localhost:5173',
        },
        method: 'OPTIONS',
      })

      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    }
    finally {
      await memoryServer.serverManager.stop()
    }
  })
})

const integrationConnectionString = process.env.AIRI_MEMORY_TEST_URL

describe.runIf(integrationConnectionString)('memory MCP PostgreSQL integration', () => {
  it('writes long-term memory and independently searches memories and raw evidence', { timeout: 30_000 }, async () => {
    const memoryServer = await createPgvectorMemoryServer()
    await memoryServer.serverManager.start()

    const marker = `mcp-e2e-${Date.now()}`
    const namespace = `integration:${marker}`
    let memoryId = ''
    const postMemory = async <T>(route: string, body: Record<string, unknown>): Promise<T> => {
      const response = await fetch(`http://127.0.0.1:6123/api/v1/memory/${route}`, {
        body: JSON.stringify({ connectionString: integrationConnectionString, namespace, ...body }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      const payload = await response.json() as T & { error?: string }
      if (!response.ok)
        throw new Error(payload.error ?? `Memory gateway ${route} failed with ${response.status}`)
      return payload
    }
    const runtime = createMemoryMcpRuntime({
      async saveMemory(draft, options) {
        const nextMemoryId = `memory-${marker}`
        await postMemory('upsert', { ...draft, createdBy: options?.createdBy, memoryId: nextMemoryId })
        return nextMemoryId
      },
      async searchEvidenceText(query, options) {
        const result = await postMemory<{ evidence: Array<{ content: string, id: string, sourceRole: string, sourceType: string }> }>('evidence/list', {
          limit: options?.limit,
          search: query,
          status: 'all',
        })
        return result.evidence
      },
      async searchMemoriesText(query, options) {
        const result = await postMemory<{ memories: Array<{ content: string, createdBy: string, memoryId: string, title: string }> }>('list', {
          limit: options?.limit,
          namespaces: [namespace],
          search: query,
          status: 'all',
        })
        return result.memories
      },
    })

    try {
      const written = await runtime.callTool({
        arguments: {
          content: `Agent-authored long-term memory ${marker}`,
          kind: 'fact',
          title: `Integration memory ${marker}`,
        },
        name: 'memory::remember',
      })
      memoryId = String(written.structuredContent?.memoryId ?? '')
      expect(memoryId).not.toBe('')

      const memories = await runtime.callTool({
        arguments: { query: marker },
        name: 'memory::search_memories',
      })
      expect(memories.structuredContent?.memories).toEqual(expect.arrayContaining([
        expect.objectContaining({ createdBy: 'agent', memoryId }),
      ]))

      await postMemory('remember', {
        memoryId: `evidence-${marker}`,
        sourceAssistantText: `Raw assistant evidence ${marker}`,
        sourceSessionId: 'integration-session',
        sourceUserText: `Raw user evidence ${marker}`,
      })
      const evidence = await runtime.callTool({
        arguments: { limit: 10, query: marker },
        name: 'memory::search_evidence',
      })
      expect(evidence.structuredContent?.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining(marker), sourceRole: 'user' }),
        expect.objectContaining({ content: expect.stringContaining(marker), sourceRole: 'assistant' }),
      ]))
    }
    finally {
      if (memoryId)
        await postMemory('delete', { memoryId })
      await memoryServer.serverManager.stop()
    }
  })
})

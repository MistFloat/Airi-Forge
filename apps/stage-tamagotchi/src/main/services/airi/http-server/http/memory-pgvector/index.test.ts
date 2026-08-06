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

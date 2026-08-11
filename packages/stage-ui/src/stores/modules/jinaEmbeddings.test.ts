import { afterEach, describe, expect, it, vi } from 'vitest'

import { embedWithJina } from './jinaEmbeddings'

describe('embedWithJina', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the requested retrieval adapter and returns the dense vector', async () => {
    const requests: Array<{ init?: RequestInit, input: RequestInfo | URL }> = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ init, input })
      return new Response(JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const embedding = await embedWithJina({
      apiKey: 'jina_test',
      dimensions: 512,
      input: 'The user prefers tea.',
      model: 'jina-embeddings-v5-text-small',
      task: 'retrieval.passage',
    })

    expect(embedding).toEqual([0.1, 0.2, 0.3])
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith('https://api.jina.ai/v1/embeddings', expect.objectContaining({
      headers: {
        'Authorization': 'Bearer jina_test',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }))

    expect(requests[0]?.input).toBe('https://api.jina.ai/v1/embeddings')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      dimensions: 512,
      embedding_type: 'float',
      input: 'The user prefers tea.',
      model: 'jina-embeddings-v5-text-small',
      normalized: true,
      task: 'retrieval.passage',
      truncate: true,
    })
  })

  it('reports the provider response when Jina rejects the token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid token', { status: 401 })))

    await expect(embedWithJina({
      apiKey: 'bad-key',
      dimensions: 1024,
      input: 'query',
      model: 'jina-embeddings-v5-text-small',
      task: 'retrieval.query',
    })).rejects.toThrow('Jina embedding failed: 401 invalid token')
  })

  it('retries a transient 429 concurrency limit before succeeding', async () => {
    // ROOT CAUSE:
    //
    // Jina's free tier caps concurrent embedding requests per key at 2, so the
    // renderer's 4-term fan-out plus gateway job draining can hit 429. embedWithJina
    // failed on the first 429 instead of waiting for a pending request to finish.
    //
    // We fixed this by retrying 429 responses with exponential backoff.
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'concurrency limit exceeded' }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const promise = embedWithJina({
        apiKey: 'jina_test',
        dimensions: 512,
        input: 'The user prefers tea.',
        model: 'jina-embeddings-v5-text-small',
        task: 'retrieval.passage',
      })
      await vi.advanceTimersByTimeAsync(500)
      await expect(promise).resolves.toEqual([0.1, 0.2, 0.3])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })
})

import { describe, expect, it, vi } from 'vitest'

import { embeddingRequestFor, embedForJob } from './embedding'

const jinaConfig = {
  embeddingModel: 'jina-embeddings-v5-text-small',
  embeddingProvider: 'jina-api',
  embeddingSource: 'jina-api' as const,
  jinaApiKey: 'secret-jina',
  jinaDimensions: 1024,
}

const providerConfig = {
  apiKey: 'secret-openai',
  baseUrl: 'https://api.openai.com/v1/',
}

describe('embeddingRequestFor', () => {
  it('builds a Jina task-specific retrieval request for passages', () => {
    const request = embeddingRequestFor('喜欢红茶', 'passage', jinaConfig)

    expect(request.url).toBe('https://api.jina.ai/v1/embeddings')
    expect(request.headers.Authorization).toBe('Bearer secret-jina')
    expect(request.body).toMatchObject({
      dimensions: 1024,
      input: '喜欢红茶',
      model: 'jina-embeddings-v5-text-small',
      normalized: true,
      task: 'retrieval.passage',
    })
  })

  it('uses the retrieval.query task for query embeddings', () => {
    const request = embeddingRequestFor('喜欢红茶', 'query', jinaConfig)

    expect(request.body.task).toBe('retrieval.query')
  })

  it('builds an OpenAI-compatible request for provider mode', () => {
    const request = embeddingRequestFor('喜欢红茶', 'passage', {
      embeddingModel: 'text-embedding-3-small',
      embeddingProvider: 'openai-audio-speech',
      embeddingSource: 'airi-provider',
      providerConfig,
    })

    expect(request.url).toBe('https://api.openai.com/v1/embeddings')
    expect(request.headers.Authorization).toBe('Bearer secret-openai')
    expect(request.body).toEqual({ input: '喜欢红茶', model: 'text-embedding-3-small' })
  })

  it('strips a trailing slash from the provider base URL', () => {
    const request = embeddingRequestFor('a', 'passage', {
      embeddingModel: 'm',
      embeddingProvider: 'p',
      embeddingSource: 'airi-provider',
      providerConfig: { ...providerConfig, baseUrl: 'https://example.com/v1' },
    })

    expect(request.url).toBe('https://example.com/v1/embeddings')
  })

  it('rejects incomplete Jina configuration', () => {
    expect(() => embeddingRequestFor('a', 'passage', { ...jinaConfig, jinaApiKey: '' }))
      .toThrow('missing apiKey or dimensions')
  })

  it('rejects incomplete provider configuration', () => {
    expect(() => embeddingRequestFor('a', 'passage', {
      embeddingModel: 'm',
      embeddingProvider: 'p',
      embeddingSource: 'airi-provider',
      providerConfig: { baseUrl: 'https://example.com/v1/' },
    })).toThrow('missing baseUrl or apiKey')
  })
})

describe('embedForJob', () => {
  it('extracts the dense vector from the provider response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ embedding: [0.1, 0.2, 0.3], index: 0, object: 'embedding' }],
      model: 'm',
      object: 'list',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      const embedding = await embedForJob('喜欢红茶', 'passage', jinaConfig)

      expect(embedding).toEqual([0.1, 0.2, 0.3])
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.jina.ai/v1/embeddings',
        expect.objectContaining({ method: 'POST' }),
      )
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws when the provider returns an invalid payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })))

    try {
      await expect(embedForJob('a', 'passage', jinaConfig)).rejects.toThrow('did not contain a valid dense vector')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('retries a transient 429 rate limit before succeeding', async () => {
    // ROOT CAUSE:
    //
    // Jina caps concurrent embedding requests per key at 2, so job draining can
    // hit 429 when the renderer embeds with the same key. embedForJob failed on
    // the first 429 instead of waiting for a pending request to finish.
    //
    // We fixed this by retrying 429 responses with exponential backoff.
    vi.useFakeTimers()
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'concurrency limit exceeded' }), { status: 429 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      const promise = embedForJob('a', 'passage', jinaConfig)
      await vi.advanceTimersByTimeAsync(500)
      await expect(promise).resolves.toEqual([1])
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})

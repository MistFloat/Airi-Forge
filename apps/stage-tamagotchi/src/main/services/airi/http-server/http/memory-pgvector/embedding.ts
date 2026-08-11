export interface EmbeddingHttpRequest {
  body: Record<string, unknown>
  headers: Record<string, string>
  url: string
}

/**
 * Configuration the renderer forwards to the desktop gateway so the main
 * process can build derivative vectors without owning the provider registry.
 *
 * `providerConfig` is the raw `providersStore.getProviderConfig()` record
 * (apiKey / baseUrl / …), so any OpenAI-compatible embedding provider works
 * without the main process re-implementing provider metadata.
 */
export interface EmbeddingJobClientConfig {
  embeddingModel: string
  embeddingProvider: string
  embeddingSource: 'airi-provider' | 'jina-api'
  jinaApiKey?: string
  jinaDimensions?: number
  providerConfig?: Record<string, unknown>
}

export type EmbeddingTask = 'passage' | 'query'

/** Retry budget for transient 429 rate-limit responses (see embedForJob NOTICE). */
const MAX_ATTEMPTS = 3

/**
 * Builds the embedding HTTP request for a job text without performing the
 * network call, so request construction is unit-testable.
 *
 * Jina uses the task-specific retrieval API; provider mode uses the standard
 * OpenAI-compatible `/embeddings` endpoint.
 */
export function embeddingRequestFor(text: string, task: EmbeddingTask, config: EmbeddingJobClientConfig): EmbeddingHttpRequest {
  if (config.embeddingSource === 'jina-api') {
    const apiKey = config.jinaApiKey?.trim()
    const dimensions = config.jinaDimensions
    if (!apiKey || !dimensions)
      throw new Error('Jina embedding client is missing apiKey or dimensions')
    return {
      body: {
        dimensions,
        embedding_type: 'float',
        input: text,
        model: config.embeddingModel.trim(),
        normalized: true,
        task: task === 'query' ? 'retrieval.query' : 'retrieval.passage',
        truncate: true,
      },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      url: 'https://api.jina.ai/v1/embeddings',
    }
  }

  const baseUrl = typeof config.providerConfig?.baseUrl === 'string' ? config.providerConfig.baseUrl.trim() : ''
  const apiKey = typeof config.providerConfig?.apiKey === 'string' ? config.providerConfig.apiKey.trim() : ''
  if (!baseUrl || !apiKey)
    throw new Error('Embedding provider client is missing baseUrl or apiKey')
  return {
    body: {
      input: text,
      model: config.embeddingModel.trim(),
    },
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    url: `${baseUrl.replace(/\/+$/, '')}/embeddings`,
  }
}

/**
 * Generates one dense vector for a background embedding job.
 *
 * NOTICE:
 * This mirrors the renderer-side embedders (`jinaEmbeddings.ts` and the
 * `providersStore` embed path). Keeping a second implementation here lets the
 * main process drain jobs without the renderer staying on the hot path; if the
 * renderer request shapes change, update both call sites in sync.
 */
export async function embedForJob(text: string, task: EmbeddingTask, config: EmbeddingJobClientConfig): Promise<number[]> {
  const request = embeddingRequestFor(text, task, config)
  // NOTICE:
  // Jina caps concurrent requests per key at 2; the renderer embeds with the
  // same key, so job draining can transiently hit 429. Absorb it with bounded
  // backoff; the job system still marks a persistently failing job as failed.
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(request.url, {
        body: JSON.stringify(request.body),
        headers: request.headers,
        method: 'POST',
      })
      if (!response.ok)
        throw new Error(`Embedding request failed: ${response.status} ${await response.text()}`)
      const payload = await response.json() as { data?: Array<{ embedding?: unknown }> }
      const embedding = payload.data?.[0]?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(value => typeof value === 'number' && Number.isFinite(value)))
        throw new Error('Embedding response did not contain a valid dense vector')
      return embedding
    }
    catch (error) {
      lastError = error
      if (error instanceof Error && error.message.includes('429'))
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
      else
        throw error
    }
  }
  throw lastError
}

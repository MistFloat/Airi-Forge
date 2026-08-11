export interface JinaEmbeddingOptions {
  apiKey: string
  dimensions: number
  input: string
  model: string
  task: JinaEmbeddingTask
}

export type JinaEmbeddingTask = 'retrieval.passage' | 'retrieval.query'

/** Retry budget for transient Jina 429 rate-limit responses (see embedWithJina NOTICE). */
const MAX_ATTEMPTS = 3

interface JinaEmbeddingResponse {
  data?: Array<{
    embedding?: unknown
  }>
}

/**
 * Generates one normalized dense vector with Jina's task-specific retrieval API.
 * Documents and queries must use matching passage/query adapters while retaining
 * the same model and dimensions, otherwise pgvector similarity quality degrades.
 */
export async function embedWithJina(options: JinaEmbeddingOptions): Promise<number[]> {
  // NOTICE:
  // Jina's free tier caps concurrent embedding requests per key at 2 and answers
  // 429 RATE_CONCURRENCY_LIMIT_EXCEEDED when the cap is hit. The renderer
  // semaphore in memory-long-term caps our own fan-out, but the desktop gateway
  // drains jobs with the same key concurrently, so absorb transient 429s with
  // bounded exponential backoff instead of failing the whole call.
  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch('https://api.jina.ai/v1/embeddings', {
        body: JSON.stringify({
          dimensions: options.dimensions,
          embedding_type: 'float',
          input: options.input,
          model: options.model,
          normalized: true,
          task: options.task,
          truncate: true,
        }),
        headers: {
          'Authorization': `Bearer ${options.apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (!response.ok)
        throw new Error(`Jina embedding failed: ${response.status} ${await response.text()}`)

      const payload = await response.json() as JinaEmbeddingResponse
      const embedding = payload.data?.[0]?.embedding
      if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(value => typeof value === 'number' && Number.isFinite(value)))
        throw new Error('Jina embedding response did not contain a valid dense vector')

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

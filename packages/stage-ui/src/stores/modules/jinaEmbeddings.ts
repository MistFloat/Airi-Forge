export interface JinaEmbeddingOptions {
  apiKey: string
  dimensions: number
  input: string
  model: string
  task: JinaEmbeddingTask
}

export type JinaEmbeddingTask = 'retrieval.passage' | 'retrieval.query'

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

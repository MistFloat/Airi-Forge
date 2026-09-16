import type { EmbedProvider } from '@xsai-ext/providers/utils'

import type { InstructionScope } from './instructionCompiler'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { embed } from '@xsai/embed'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useConfiguratorByModsChannelServer } from '../configurator'
import { useProvidersStore } from '../providers'
import { embedWithJina } from './jinaEmbeddings'

export interface LongTermMemoryClaim {
  assertionMode: 'explicit' | 'implicit' | 'none'
  createdAt: string
  evidenceId: string
  factKey: string
  id: string
  kind: 'fact' | 'preference'
  polarity: 'negative' | 'positive'
  promotedMemoryId?: string
  quote: string
  revision: number
  status: 'promoted' | 'proposed' | 'quarantined' | 'rejected' | 'validated'
  validFrom?: string
  validUntil?: string
  value: string
}

export interface LongTermMemoryDraft {
  confidence: number
  content: string
  effectiveFrom?: string
  effectiveUntil?: string
  importance: number
  instructionPriority?: number
  instructionRuleKey?: string
  instructionScope?: InstructionScope
  kind: LongTermMemoryKind
  memoryId?: string
  status: LongTermMemoryStatus
  supersedesId?: string
  tags: string[]
  title: string
}
export type LongTermMemoryEmbeddingSource = 'airi-provider' | 'jina-api'
export interface LongTermMemoryEvidence {
  archivedAt?: string
  content: string
  createdAt: string
  id: string
  observedAt?: string
  sourceId: string
  sourceMessageId?: string
  sourceRole: string
  sourceSessionId?: string
  sourceType: string
  status?: string
}

/** A knowledge-memory row returned to the desktop management interface. */
export interface LongTermMemoryItem {
  confidence: null | number
  content: string
  createdAt: string
  createdBy: string
  effectiveFrom?: string
  effectiveUntil?: string
  embeddingModel: string
  embeddingProvider: string
  importance: number
  instructionPriority: number
  instructionRuleKey: null | string
  instructionScope: InstructionScope
  kind: LongTermMemoryKind
  memoryId: string
  namespace: string
  sourceMessageIds: string[]
  sourceSessionId?: string
  status: LongTermMemoryStatus
  supersedesId?: string
  tags: string[]
  title: string
  updatedAt: string
}

export type LongTermMemoryKind = 'conversation' | 'fact' | 'instruction' | 'preference' | 'summary'

/** A semantic retrieval result exposed to the memory evaluation interface. */
export interface LongTermMemoryRecallResult {
  content: string
  memoryId: string
  retrievalId: string
  similarity: number
  title: string
}

export interface LongTermMemoryRecallTrace {
  candidates: Array<{
    baselineRank?: number
    filterReason?: 'confidence' | 'duplicate_fact_key' | 'expired' | 'similarity' | 'status'
    finalRank?: number
    injected: boolean
    memoryId: string
    similarity: number
    term: string
    termRank: number
  }>
  originalText: string
  queryPolicyVersion?: string
  retrievalId: string
  schemaId?: string
  terms: string[]
}

export type LongTermMemoryStatus = 'active' | 'archived' | 'disputed' | 'expired' | 'quarantined' | 'stale' | 'superseded'

export const useMemoryLongTermStore = defineStore('memory-long-term', () => {
  const configurator = useConfiguratorByModsChannelServer()
  const providersStore = useProvidersStore()
  const enabled = useLocalStorageManualReset<boolean>('settings/memory-long-term/enabled', false)
  const connectionString = useLocalStorageManualReset<string>('settings/memory-long-term/connection-string', 'postgresql://airi:pazzw0rd123@localhost:5432/airi_memory')
  const embeddingSource = useLocalStorageManualReset<LongTermMemoryEmbeddingSource>('settings/memory-long-term/embedding-source', 'airi-provider')
  const embeddingProvider = useLocalStorageManualReset<string>('settings/memory-long-term/embedding-provider', '')
  const embeddingModel = useLocalStorageManualReset<string>('settings/memory-long-term/embedding-model', '')
  const jinaApiKey = useLocalStorageManualReset<string>('settings/memory-long-term/jina-api-key', '')
  const jinaModel = useLocalStorageManualReset<string>('settings/memory-long-term/jina-model', 'jina-embeddings-v5-text-small')
  const jinaDimensions = useLocalStorageManualReset<number>('settings/memory-long-term/jina-dimensions', 1024)
  const similarityThreshold = useLocalStorageManualReset<number>('settings/memory-long-term/similarity-threshold', 0.7)
  const maxResults = useLocalStorageManualReset<number>('settings/memory-long-term/max-results', 5)
  const memoryNamespace = useLocalStorageManualReset<string>('settings/memory-long-term/namespace', 'default')
  const instructionTokenBudget = useLocalStorageManualReset<number>('settings/memory-long-term/instruction-token-budget', 1200)
  let embeddingJobRun: Promise<{ completed: number, failed: number, skipped: number }> | undefined

  function saveSettings() {
    configurator.updateFor('memory-long-term', {
      connectionString: connectionString.value,
      embeddingModel: embeddingModel.value,
      embeddingProvider: embeddingProvider.value,
      embeddingSource: embeddingSource.value,
      enabled: enabled.value,
      instructionTokenBudget: instructionTokenBudget.value,
      jinaApiKey: jinaApiKey.value,
      jinaDimensions: jinaDimensions.value,
      jinaModel: jinaModel.value,
      maxResults: maxResults.value,
      memoryNamespace: memoryNamespace.value,
      similarityThreshold: similarityThreshold.value,
    })
  }

  const databaseConfigured = computed(() => enabled.value
    && /^postgres(?:ql)?:\/\//i.test(connectionString.value.trim())
    && !!memoryNamespace.value.trim()
    && Number.isInteger(Number(instructionTokenBudget.value))
    && Number(instructionTokenBudget.value) >= 128
    && Number(instructionTokenBudget.value) <= 8192)

  const configured = computed(() => {
    const threshold = Number(similarityThreshold.value)
    const embeddingConfigured = embeddingSource.value === 'jina-api'
      ? !!jinaApiKey.value.trim()
      && !!jinaModel.value.trim()
      && Number.isInteger(Number(jinaDimensions.value))
      && Number(jinaDimensions.value) >= 32
      && Number(jinaDimensions.value) <= 1024
      : !!embeddingProvider.value.trim() && !!embeddingModel.value.trim()

    return databaseConfigured.value
      && embeddingConfigured
      && threshold >= 0
      && threshold <= 1
      && Number.isInteger(Number(maxResults.value))
      && Number(maxResults.value) > 0
  })

  // NOTICE:
  // Jina's free tier caps concurrent embedding requests per key at 2
  // (RATE_CONCURRENCY_LIMIT_EXCEEDED). recallMemories fans out up to 4 terms
  // with Promise.all and the desktop gateway drains jobs with the same key, so
  // the renderer serializes its own requests through a 2-slot semaphore. The
  // slot budget must stay <= 2 while Jina's cap is 2; revisit for paid tiers.
  const EMBEDDING_CONCURRENCY = 2
  let activeEmbeddingRequests = 0
  const embeddingWaiters: Array<() => void> = []

  function acquireEmbeddingSlot(): Promise<void> {
    if (activeEmbeddingRequests < EMBEDDING_CONCURRENCY) {
      activeEmbeddingRequests++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      embeddingWaiters.push(resolve)
    })
  }

  function releaseEmbeddingSlot(): void {
    const next = embeddingWaiters.shift()
    if (next) {
      // Hand the freed slot to the next waiter; the counter stays unchanged
      // because the waiter is now occupying the slot.
      next()
      return
    }
    activeEmbeddingRequests--
  }

  async function embeddingFor(text: string, task: 'passage' | 'query'): Promise<number[]> {
    await acquireEmbeddingSlot()
    try {
      if (embeddingSource.value === 'jina-api') {
        return await embedWithJina({
          apiKey: jinaApiKey.value,
          dimensions: Number(jinaDimensions.value),
          input: text,
          model: jinaModel.value.trim(),
          task: task === 'query' ? 'retrieval.query' : 'retrieval.passage',
        })
      }

      const provider = await providersStore.getProviderInstance<EmbedProvider<string>>(embeddingProvider.value)
      const result = await embed({
        ...provider.embed(embeddingModel.value),
        input: text,
      })
      return result.embedding
    }
    finally {
      releaseEmbeddingSlot()
    }
  }

  // NOTICE:
  // Circuit breaker + retry strategy for the desktop memory gateway on 6123.
  //
  // Two failure modes exist:
  // 1. Network-level (TypeError): the HTTP server process is not running or
  //    crashed. Retried up to MAX_RETRIES times with RETRY_DELAY_MS delay,
  //    because the server starts asynchronously via injeca and may not have
  //    bound when the renderer's first request fires.
  // 2. HTTP 5xx: the server IS running but the database is unreachable
  //    (PostgreSQL not started / wrong credentials / pgvector extension
  //    missing). Not retried — the server-side problem will not self-correct
  //    within the retry window.
  //
  // After CIRCUIT_FAILURE_THRESHOLD consecutive failed request() calls, the
  // circuit opens for CIRCUIT_COOLDOWN_MS. Memory reads and interactive MCP
  // calls still fail open at their owning boundaries. Event-derived writes
  // reject so the projector retains its durable cursor and retries later
  // instead of recording a false success. The circuit closes after the
  // cooldown to re-probe the gateway; a successful request resets it.
  const MAX_RETRIES = 3
  const RETRY_DELAY_MS = 1000
  const CIRCUIT_FAILURE_THRESHOLD = 3
  const CIRCUIT_COOLDOWN_MS = 60_000

  let consecutiveFailures = 0
  let circuitOpenUntil = 0
  let circuitOpenLogged = false

  function isCircuitOpen(): boolean {
    return Date.now() < circuitOpenUntil
  }

  function recordRequestSuccess(): void {
    if (consecutiveFailures !== 0 || circuitOpenUntil !== 0) {
      consecutiveFailures = 0
      circuitOpenUntil = 0
      circuitOpenLogged = false
    }
  }

  function recordRequestFailure(): void {
    consecutiveFailures++
    if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && circuitOpenUntil === 0) {
      circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS
      if (!circuitOpenLogged) {
        // NOTICE:
        // Warn (not error) once when the circuit opens to avoid console spam.
        // Subsequent failures during the cooldown are silently skipped by
        // the isCircuitOpen() guard in request() and rememberTurn.
        console.warn(
          `Long-term memory gateway has failed ${consecutiveFailures} consecutive times.`
          + ` Circuit breaker open for ${CIRCUIT_COOLDOWN_MS / 1000}s;`
          + ` memory operations will fail open until the gateway recovers.`,
        )
        circuitOpenLogged = true
      }
    }
  }

  async function sleep(ms: number): Promise<void> {
    return await new Promise(resolve => setTimeout(resolve, ms))
  }

  type MemoryRequestPath
    = | 'changes/list'
      | 'changes/rollback'
      | 'claims/create'
      | 'claims/list'
      | 'claims/promote'
      | 'claims/validate'
      | 'conflicts/list'
      | 'conflicts/resolve'
      | 'conflicts/scan/apply'
      | 'conflicts/scan/claim'
      | 'conflicts/scan/enqueue'
      | 'conflicts/scan/prepare'
      | 'delete'
      | 'embeddings/put'
      | 'evidence/archive'
      | 'evidence/list'
      | 'feedback'
      | 'health'
      | 'instructions'
      | 'jobs/claim'
      | 'jobs/fail'
      | 'jobs/list'
      | 'jobs/run'
      | 'list'
      | 'ping'
      | 'recall'
      | 'recall/plan'
      | 'remember'
      | 'schemas/activate'
      | 'schemas/archive-fallback'
      | 'schemas/create'
      | 'schemas/list'
      | 'upsert'

  async function request(path: MemoryRequestPath, body: Record<string, unknown>): Promise<Response> {
    if (isCircuitOpen()) {
      throw new Error('Long-term memory gateway circuit breaker is open')
    }

    let lastError: unknown

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:6123/api/v1/memory/${path}`, {
          body: JSON.stringify({ connectionString: connectionString.value, ...body }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        })

        if (!response.ok)
          throw new Error(`Long-term memory ${path} failed: ${response.status} ${await response.text()}`)

        recordRequestSuccess()
        return response
      }
      catch (error) {
        lastError = error
        // Only retry on network-level failures (gateway not ready yet).
        // Response errors (4xx / 5xx) are not retried because they indicate
        // a configuration or server-side problem that will not self-correct.
        if (error instanceof TypeError) {
          if (attempt < MAX_RETRIES - 1) {
            await sleep(RETRY_DELAY_MS)
            continue
          }
        }
        break
      }
    }

    recordRequestFailure()

    if (lastError instanceof Error && lastError.message.startsWith('Long-term memory'))
      throw lastError

    throw new Error(`Long-term memory desktop gateway is unavailable on 127.0.0.1:6123. Restart AIRI after updating. ${errorMessageFrom(lastError) ?? ''}`.trim())
  }

  async function requestJson<T>(path: Parameters<typeof request>[0], body: Record<string, unknown>): Promise<T> {
    return await (await request(path, body)).json() as T
  }

  function memoryScope(): string {
    // Model identity belongs to Embedding Schema Registry. Keeping it out of the
    // namespace preserves one evidence/canonical corpus across model migrations.
    return memoryNamespace.value.trim()
  }

  function embeddingIdentity(): string {
    return embeddingSource.value === 'jina-api' ? 'jina-api' : embeddingProvider.value
  }

  function activeEmbeddingModel(): string {
    return embeddingSource.value === 'jina-api' ? jinaModel.value : embeddingModel.value
  }

  async function rememberTurn(
    _sessionId: string,
    userText: string,
    assistantText: string,
    options: { memoryId?: string } = {},
  ): Promise<void> {
    if (!databaseConfigured.value || !userText.trim() || !assistantText.trim())
      return
    // Memory projection is detached from the chat send path, so rejecting here
    // cannot abort a reply. The rejection is the projector's only signal not
    // to advance its durable cursor past an exchange that PostgreSQL missed.
    if (isCircuitOpen())
      throw new Error('Long-term memory gateway circuit breaker is open')

    await request('remember', {
      memoryId: options.memoryId ?? nanoid(),
      namespace: memoryScope(),
      sourceAssistantText: assistantText.trim(),
      sourceMessageIds: [],
      sourceSessionId: _sessionId,
      sourceUserText: userText.trim(),
    })
  }

  async function testConnection(): Promise<{ memoryCount: number, pgvectorVersion: string }> {
    // Reset circuit breaker on manual connection test — the user is actively
    // probing the gateway after changing settings, so prior failures should
    // not block the test.
    consecutiveFailures = 0
    circuitOpenUntil = 0
    circuitOpenLogged = false
    return await requestJson('health', {})
  }

  async function testEmbedding(): Promise<{ dimensions: number }> {
    const embedding = await embeddingFor('AIRI long-term memory connection test', 'query')
    return { dimensions: embedding.length }
  }

  async function recallMemories(query: string, options: {
    maxResults?: number
    /** `terms` (default) embeds planned short terms; `original` embeds the full query as a single term for offline comparison. */
    mode?: 'original' | 'terms'
    namespace?: string
    sessionId?: string
    similarityThreshold?: number
    /** Neighbors fetched per retrieval term; a wider window feeds ranking diagnostics without raising maxResults. */
    topKPerTerm?: number
  } = {}): Promise<{ memories: LongTermMemoryRecallResult[], trace: LongTermMemoryRecallTrace }> {
    if (!configured.value || !query.trim()) {
      return {
        memories: [],
        trace: { candidates: [], originalText: query.trim(), retrievalId: '', terms: [] },
      }
    }

    // Crash recovery: older builds could leave promoted canonical text with a
    // pending vector job. Give the drain one short window so recently promoted
    // text can surface, then proceed with whatever is already queryable
    // (fail-open) — recall must never stall on embedding API latency.
    await Promise.race([
      processEmbeddingJobs().catch(() => undefined),
      sleep(200),
    ])
    const normalizedQuery = query.trim()
    const recallQuery = options.mode === 'original'
      // PRD v2 §4.2 keeps a full-sentence embedding as the fallback; exposing
      // it as an explicit mode lets the lab compare short-term vs full-text recall.
      ? { originalText: normalizedQuery, policyVersion: '', terms: [normalizedQuery] }
      : await requestJson<{ originalText: string, policyVersion: string, terms: string[] }>('recall/plan', {
          content: normalizedQuery,
        })
    const recallTerms = await Promise.all(recallQuery.terms.map(async text => ({
      embedding: await embeddingFor(text, 'query'),
      text,
    })))
    const payload = await requestJson<{ memories?: LongTermMemoryRecallResult[], trace: LongTermMemoryRecallTrace }>('recall', {
      content: recallQuery.originalText,
      maxResults: options.maxResults ?? Number(maxResults.value),
      namespace: options.namespace?.trim() || memoryScope(),
      queryPolicyVersion: options.mode === 'original' ? '' : recallQuery.policyVersion,
      recallTerms,
      similarityThreshold: options.similarityThreshold ?? Number(similarityThreshold.value),
      sourceSessionId: options.sessionId,
      topKPerTerm: options.topKPerTerm,
    })
    return { memories: payload.memories ?? [], trace: payload.trace }
  }

  async function listMemories(options: {
    limit?: number
    offset?: number
    search?: string
    status?: 'all' | LongTermMemoryStatus
  } = {}): Promise<{ memories: LongTermMemoryItem[], total: number }> {
    return await requestJson('list', {
      limit: options.limit ?? 20,
      namespaces: [memoryScope()],
      offset: options.offset ?? 0,
      search: options.search,
      status: options.status ?? 'all',
    })
  }

  async function saveMemory(draft: LongTermMemoryDraft, options: { createdBy?: 'agent' | 'user', namespace?: string } = {}): Promise<string> {
    const memoryId = draft.memoryId || nanoid()
    const namespace = options.namespace?.trim() || memoryScope()
    await request('upsert', {
      ...draft,
      createdBy: options.createdBy ?? 'user',
      embeddingModel: activeEmbeddingModel(),
      embeddingProvider: embeddingIdentity(),
      memoryId,
      namespace,
      sourceMessageIds: [],
    })
    return memoryId
  }

  async function deleteMemory(memoryId: string, namespace: string): Promise<boolean> {
    const result = await requestJson<{ deleted: boolean }>('delete', {
      memoryId,
      namespace,
    })
    return result.deleted
  }

  async function listEvidence(options: {
    limit?: number
    offset?: number
    search?: string
    status?: 'active' | 'all' | 'archived'
  } = {}): Promise<LongTermMemoryEvidence[]> {
    const result = await requestJson<{ evidence: LongTermMemoryEvidence[] }>('evidence/list', {
      limit: options.limit ?? 50,
      namespace: memoryScope(),
      offset: options.offset ?? 0,
      search: options.search,
      status: options.status ?? 'all',
    })
    return result.evidence
  }

  /** Searches raw evidence without invoking an Embedding model. */
  async function searchEvidenceText(query: string, options: { limit?: number } = {}): Promise<LongTermMemoryEvidence[]> {
    const search = query.trim()
    if (!databaseConfigured.value || !search)
      return []
    const limit = Math.min(10, Math.max(1, Math.trunc(options.limit ?? 5)))
    return await listEvidence({ limit, search, status: 'all' })
  }

  /** Searches explicitly authored long-term memory without invoking an Embedding model. */
  async function searchMemoriesText(query: string, options: { limit?: number } = {}): Promise<LongTermMemoryItem[]> {
    const search = query.trim()
    if (!databaseConfigured.value || !search)
      return []
    const limit = Math.min(10, Math.max(1, Math.trunc(options.limit ?? 5)))
    return (await listMemories({ limit, search, status: 'all' })).memories
  }

  /**
   * Soft-archives unreferenced evidence older than the retention window in the
   * main process. PRD v2 keeps evidence immutable, so rows are flagged, not
   * deleted.
   */
  async function archiveEvidence(days = 90): Promise<number> {
    const result = await requestJson<{ archived: number }>('evidence/archive', { days, namespace: memoryScope() })
    return result.archived
  }

  async function listClaims(status = 'all'): Promise<LongTermMemoryClaim[]> {
    const result = await requestJson<{ claims: LongTermMemoryClaim[] }>('claims/list', { namespace: memoryScope(), status })
    return result.claims
  }

  async function validateClaim(id: string): Promise<void> {
    await request('claims/validate', { id, namespace: memoryScope() })
  }

  async function promoteClaim(id: string, source?: 'auto'): Promise<void> {
    await request('claims/promote', { id, namespace: memoryScope(), source })
    // NOTICE:
    // Promote only enqueues a build_embedding job; nothing drains it until the
    // next recall or turn, and recallMemories races its drain against a 200ms
    // budget that Jina round-trips usually exceed. That is why a manually
    // promoted memory stayed unqueryable until the user edited and re-saved it
    // (upsert computes the embedding inline). For manual promotion, wait on a
    // bounded drain so the promoted memory is immediately recallable. The auto
    // path stays fire-and-forget: rememberTurn already kicks a drain and the
    // chat turn must not stall on embedding API latency.
    if (source !== 'auto') {
      await Promise.race([
        processEmbeddingJobs().catch(() => undefined),
        sleep(5_000),
      ])
    }
  }

  async function listGovernance() {
    const [conflicts, schemas, jobs, changes] = await Promise.all([
      requestJson<{ conflicts: Record<string, unknown>[] }>('conflicts/list', { namespace: memoryScope() }),
      requestJson<{ schemas: Record<string, unknown>[], state: null | Record<string, unknown> }>('schemas/list', { namespace: memoryScope() }),
      requestJson<{ jobs: Record<string, unknown>[] }>('jobs/list', { jobStatus: 'all', namespace: memoryScope() }),
      requestJson<{ changes: Record<string, unknown>[] }>('changes/list', { namespace: memoryScope() }),
    ])
    return { changes: changes.changes, conflicts: conflicts.conflicts, jobs: jobs.jobs, schemas: schemas.schemas, schemaState: schemas.state }
  }

  async function resolveConflict(id: string, decision: 'accept_candidate' | 'dismiss' | 'keep_left' | 'keep_right'): Promise<void> {
    await request('conflicts/resolve', { decision, id, namespace: memoryScope() })
  }

  async function rollbackTransaction(transactionId: string): Promise<void> {
    await request('changes/rollback', { namespace: memoryScope(), transactionId })
  }

  async function addFeedback(memoryId: string, feedback: 'irrelevant' | 'outdated' | 'useful' | 'wrong', reasonCode?: string): Promise<void> {
    await request('feedback', {
      feedback,
      memoryId,
      namespace: memoryScope(),
      reasonCode,
      source: 'user',
      sourceEventId: nanoid(),
    })
  }

  async function createEmbeddingSchema(): Promise<string> {
    const dimensions = embeddingSource.value === 'jina-api' ? Number(jinaDimensions.value) : (await testEmbedding()).dimensions
    const result = await requestJson<{ schemaId: string }>('schemas/create', {
      embeddingModel: activeEmbeddingModel(),
      embeddingProvider: embeddingIdentity(),
      inputTemplateVersion: 'canonical-v1',
      jinaDimensions: dimensions,
      namespace: memoryScope(),
      schemaVersion: `${embeddingIdentity()}:${activeEmbeddingModel()}:${dimensions}:canonical-v1`,
    })
    return result.schemaId
  }

  async function activateEmbeddingSchema(schemaId: string): Promise<void> {
    await request('schemas/activate', { namespace: memoryScope(), schemaId })
  }

  async function archiveFallbackSchema(): Promise<void> {
    await request('schemas/archive-fallback', { namespace: memoryScope() })
  }

  async function processEmbeddingJobs(): Promise<{ completed: number, failed: number, skipped: number }> {
    if (embeddingJobRun)
      return await embeddingJobRun

    embeddingJobRun = runEmbeddingJobs()
    try {
      return await embeddingJobRun
    }
    finally {
      embeddingJobRun = undefined
    }
  }

  async function runEmbeddingJobs(): Promise<{ completed: number, failed: number, skipped: number }> {
    // The desktop gateway owns the claim → embed → put/fail loop now (PRD #5),
    // so the renderer only forwards its embedding client config. The gateway
    // cannot read renderer-local provider credentials, so pass them through.
    const owner = `renderer:${nanoid()}`
    return await requestJson<{ completed: number, failed: number, skipped: number }>('jobs/run', {
      embeddingModel: activeEmbeddingModel(),
      embeddingProvider: embeddingIdentity(),
      embeddingSource: embeddingSource.value,
      jinaApiKey: jinaApiKey.value,
      jinaDimensions: Number(jinaDimensions.value),
      limit: 8,
      namespace: memoryScope(),
      owner,
      providerConfig: embeddingSource.value === 'jina-api'
        ? undefined
        : providersStore.getProviderConfig(embeddingProvider.value.trim()) ?? {},
    })
  }

  function resetState() {
    enabled.reset()
    connectionString.reset()
    embeddingSource.reset()
    embeddingProvider.reset()
    embeddingModel.reset()
    jinaApiKey.reset()
    jinaModel.reset()
    jinaDimensions.reset()
    similarityThreshold.reset()
    maxResults.reset()
    memoryNamespace.reset()
    instructionTokenBudget.reset()
    consecutiveFailures = 0
    circuitOpenUntil = 0
    circuitOpenLogged = false
    saveSettings()
  }

  return {
    activateEmbeddingSchema,
    addFeedback,
    archiveEvidence,
    archiveFallbackSchema,
    configured,
    connectionString,
    createEmbeddingSchema,
    databaseConfigured,
    deleteMemory,
    embeddingModel,
    embeddingProvider,
    embeddingSource,
    enabled,
    instructionTokenBudget,
    isCircuitOpen,
    jinaApiKey,
    jinaDimensions,
    jinaModel,
    listClaims,
    listEvidence,
    listGovernance,
    listMemories,
    maxResults,
    memoryNamespace,
    processEmbeddingJobs,
    promoteClaim,
    recallMemories,
    rememberTurn,
    resetState,
    resolveConflict,
    rollbackTransaction,
    saveMemory,
    saveSettings,
    searchEvidenceText,
    searchMemoriesText,
    similarityThreshold,
    testConnection,
    testEmbedding,
    validateClaim,
  }
})

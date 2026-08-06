import type { InstructionScope, MemoryKind, MemoryStatus, PgvectorMemoryRecord } from '@proj-airi/memory-pgvector/store'

import type { BuiltInServerAddress } from '../../server'
import type { EmbeddingJobClientConfig } from './embedding'

import { useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'
import { createPgvectorMemoryStore, planMemoryRecallQuery, recallQueryPolicyVersion } from '@proj-airi/memory-pgvector/store'
import { eventHandler, H3, handleCors, readBody } from 'h3'

import { createH3Server } from '../../server'
import { embedForJob } from './embedding'

const log = useLogg('memory-pgvector').useGlobalConfig()

interface MemoryPayload {
  assertionMode?: unknown
  assistantText?: unknown
  confidence?: unknown
  connectionString?: unknown
  content?: unknown
  createdBy?: unknown
  days?: unknown
  decision?: unknown
  effectiveFrom?: unknown
  effectiveUntil?: unknown
  embedding?: unknown
  embeddingModel?: unknown
  embeddingProvider?: unknown
  embeddingSource?: unknown
  error?: unknown
  evidenceId?: unknown
  evidenceQuote?: unknown
  factKey?: unknown
  feedback?: unknown
  id?: unknown
  importance?: unknown
  inputTemplateVersion?: unknown
  instructionPriority?: unknown
  instructionRuleKey?: unknown
  instructionScope?: unknown
  jinaApiKey?: unknown
  jinaDimensions?: unknown
  jobId?: unknown
  jobStatus?: unknown
  kind?: unknown
  limit?: unknown
  maxResults?: unknown
  memoryId?: unknown
  namespace?: unknown
  namespaces?: unknown
  offset?: unknown
  owner?: unknown
  pairs?: unknown
  polarity?: unknown
  predicate?: unknown
  providerConfig?: unknown
  queryPolicyVersion?: unknown
  quote?: unknown
  quoteEnd?: unknown
  quoteStart?: unknown
  reasonCode?: unknown
  recallTerms?: unknown
  retrievalId?: unknown
  schemaId?: unknown
  schemaVersion?: unknown
  scope?: unknown
  search?: unknown
  seedEmbedding?: unknown
  similarityThreshold?: unknown
  source?: unknown
  sourceAssistantText?: unknown
  sourceEventId?: unknown
  sourceMessageIds?: unknown
  sourceSessionId?: unknown
  sourceUserText?: unknown
  status?: unknown
  subject?: unknown
  supersedesId?: unknown
  tags?: unknown
  title?: unknown
  topKPerTerm?: unknown
  transactionId?: unknown
  userText?: unknown
  value?: unknown
}

const MEMORY_KINDS = new Set<MemoryKind>(['conversation', 'fact', 'instruction', 'preference', 'summary'])
const MEMORY_STATUSES = new Set<MemoryStatus>(['active', 'archived', 'disputed', 'expired', 'quarantined', 'stale', 'superseded'])
const INSTRUCTION_SCOPES = new Set<InstructionScope>(['artistry', 'chat', 'global', 'memory', 'speech', 'vision'])

/** A `build_embedding` row claimed by the desktop gateway from `claimEmbeddingJobs`. */
interface ClaimedEmbeddingJob {
  attempts: number
  dimensions: number
  id: string
  inputText: string
  jobKey: string
  jobType: string
  model: string
  payload: null | Record<string, unknown>
  provider: string
  schemaId: string
  status: string
}

/** Creates the desktop-only PostgreSQL/pgvector knowledge-memory gateway. */
export async function createPgvectorMemoryServer(): Promise<{
  getAddress: () => BuiltInServerAddress | undefined
  serverManager: { key: string, start: () => Promise<void>, stop: () => Promise<void> }
}> {
  const app = new H3()
  const server = createH3Server({ app, host: '127.0.0.1', port: 6123 })
  const corsOptions = {
    methods: ['POST', 'OPTIONS'],
    origin: '*' as const,
    preflight: { statusCode: 204 },
  }
  const memoryPaths = [
    'health',
    'ping',
    'instructions',
    'list',
    'upsert',
    'delete',
    'remember',
    'recall',
    'recall/plan',
    'evidence/archive',
    'evidence/list',
    'claims/list',
    'claims/create',
    'claims/validate',
    'claims/promote',
    'feedback',
    'conflicts/list',
    'conflicts/resolve',
    'conflicts/scan/apply',
    'conflicts/scan/claim',
    'conflicts/scan/enqueue',
    'conflicts/scan/prepare',
    'schemas/list',
    'schemas/create',
    'schemas/activate',
    'schemas/archive-fallback',
    'embeddings/put',
    'jobs/list',
    'jobs/claim',
    'jobs/fail',
    'jobs/run',
    'changes/list',
    'changes/rollback',
  ] as const

  // The renderer runs on a Vite origin in development and a file origin in
  // production. JSON POST requests therefore require an explicit loopback
  // preflight even though both processes belong to the same desktop app.
  for (const path of memoryPaths) {
    app.options(`/api/v1/memory/${path}`, eventHandler((event) => {
      return handleCors(event, corsOptions)
    }))
  }

  // NOTICE:
  // Lightweight liveness probe that does NOT touch PostgreSQL. The renderer
  // circuit breaker uses this to distinguish "HTTP gateway is down" (process
  // crashed / port not bound) from "database is unreachable" (PostgreSQL not
  // running / wrong credentials / pgvector extension missing). The /health
  // endpoint above checks database connectivity and will 500 when the DB is
  // unavailable; /ping returns 200 as long as the HTTP server process is alive.
  app.post('/api/v1/memory/ping', eventHandler((event) => {
    handleCors(event, corsOptions)
    return { ok: true, service: 'memory-pgvector', timestamp: Date.now() }
  }))

  app.post('/api/v1/memory/health', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      log.log(`pgvector memory health check, db: ${String(body.connectionString).replace(/\/\/.*@/, '//***@')}`)
      return await createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString')).health()
    }
    catch (error) {
      log.withError(error).error('pgvector memory health check failed')
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/list', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString')).list({
        limit: Math.min(100, Math.max(1, Math.trunc(Number(body.limit) || 20))),
        namespaces: stringArray(body.namespaces).length > 0
          ? stringArray(body.namespaces)
          : [requiredString(body.namespace, 'namespace')],
        offset: Math.max(0, Math.trunc(Number(body.offset) || 0)),
        search: optionalString(body.search),
        status: body.status === 'all' ? 'all' : memoryStatus(body.status),
      })
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/instructions', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const instructions = await createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString'))
        .instructions(requiredString(body.namespace, 'namespace'))
      return { instructions }
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/upsert', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      await createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString')).upsert(memoryRecord(body))
      return { ok: true }
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/delete', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const deleted = await createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString')).remove(
        requiredString(body.namespace, 'namespace'),
        requiredString(body.memoryId, 'memoryId'),
      )
      return { deleted }
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/remember', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const store = createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString'))
      const namespace = requiredString(body.namespace, 'namespace')
      const sourceId = requiredString(body.memoryId ?? body.id, 'memoryId')
      const sourceSessionId = optionalString(body.sourceSessionId)
      const userText = requiredString(body.sourceUserText ?? body.userText, 'sourceUserText')
      const assistantText = requiredString(body.sourceAssistantText ?? body.assistantText, 'sourceAssistantText')
      const user = await store.ingestEvidence({
        content: userText,
        namespace,
        sourceId: `${sourceId}:user`,
        sourceRole: 'user',
        sourceSessionId,
        sourceType: 'user_assertion',
      })
      const assistant = await store.ingestEvidence({
        content: assistantText,
        namespace,
        sourceId: `${sourceId}:assistant`,
        sourceRole: 'assistant',
        sourceSessionId,
        sourceType: 'assistant_inference',
      })
      return { assistantEvidenceId: assistant.evidenceId, ok: true, userEvidenceId: user.evidenceId }
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/evidence/list', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const status = body.status === 'active' || body.status === 'archived' ? body.status : 'all'
      const evidence = await storeFor(body).listEvidence(requiredString(body.namespace, 'namespace'), Number(body.limit) || 50, Number(body.offset) || 0, { status })
      return { evidence }
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/evidence/archive', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await storeFor(body).archiveEvidence(requiredString(body.namespace, 'namespace'), {
        days: Number(body.days) || 90,
        limit: Number(body.limit) || 500,
      })
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))

  app.post('/api/v1/memory/claims/list', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return { claims: await storeFor(body).listClaims(requiredString(body.namespace, 'namespace'), optionalString(body.status) ?? 'all') }
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/claims/create', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await storeFor(body).createClaim({
        assertionMode: assertionMode(body.assertionMode),
        evidenceId: requiredString(body.evidenceId, 'evidenceId'),
        factKey: optionalString(body.factKey) ?? '',
        kind: body.kind === 'preference' ? 'preference' : 'fact',
        namespace: requiredString(body.namespace, 'namespace'),
        polarity: body.polarity === 'negative' ? 'negative' : 'positive',
        predicate: requiredString(body.predicate, 'predicate'),
        quote: requiredString(body.quote, 'quote'),
        quoteEnd: requiredInteger(body.quoteEnd, 'quoteEnd'),
        quoteStart: requiredInteger(body.quoteStart, 'quoteStart'),
        scope: requiredString(body.scope ?? 'global', 'scope'),
        subject: requiredString(body.subject ?? 'user', 'subject'),
        validFrom: optionalString(body.effectiveFrom),
        validUntil: optionalString(body.effectiveUntil),
        value: requiredString(body.value, 'value'),
      }, optionalString(body.schemaVersion) ?? 'claim-v1')
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))

  for (const operation of ['validate', 'promote'] as const) {
    app.post(`/api/v1/memory/claims/${operation}`, eventHandler(async (event) => {
      handleCors(event, corsOptions)
      try {
        const body = await payloadFor(event)
        const store = storeFor(body)
        const namespace = requiredString(body.namespace, 'namespace')
        const claimId = requiredString(body.id, 'id')
        if (operation === 'validate') {
          await store.validateClaim(namespace, claimId)
          return { ok: true }
        }
        return await store.promoteClaim(namespace, claimId, body.source === 'auto' ? 'auto' : 'user')
      }
      catch (error) {
        return jsonError(error, 400)
      }
    }))
  }

  app.post('/api/v1/memory/feedback', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const feedback = optionalString(body.feedback)
      if (!feedback || !['irrelevant', 'outdated', 'useful', 'wrong'].includes(feedback))
        throw new Error('feedback is invalid')
      await storeFor(body).feedback({
        evidenceQuote: optionalString(body.evidenceQuote),
        feedback: feedback as 'irrelevant' | 'outdated' | 'useful' | 'wrong',
        memoryId: requiredString(body.memoryId, 'memoryId'),
        namespace: requiredString(body.namespace, 'namespace'),
        reasonCode: optionalString(body.reasonCode),
        retrievalId: optionalString(body.retrievalId),
        source: body.source === 'automatic' ? 'automatic' : 'user',
        sourceEventId: requiredString(body.sourceEventId, 'sourceEventId'),
      })
      return { ok: true }
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))

  app.post('/api/v1/memory/conflicts/list', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    return await listResult(event, 'conflicts')
  }))
  app.post('/api/v1/memory/conflicts/resolve', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const decision = optionalString(body.decision)
      if (!decision || !['accept_candidate', 'dismiss', 'keep_left', 'keep_right'].includes(decision))
        throw new Error('decision is invalid')
      await storeFor(body).resolveConflict(
        requiredString(body.namespace, 'namespace'),
        requiredString(body.id, 'id'),
        decision as 'accept_candidate' | 'dismiss' | 'keep_left' | 'keep_right',
      )
      return { ok: true }
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))
  app.post('/api/v1/memory/conflicts/scan/enqueue', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await storeFor(body).enqueueConflictScan(requiredString(body.namespace, 'namespace'))
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))
  app.post('/api/v1/memory/conflicts/scan/claim', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return {
        jobs: await storeFor(body).claimConflictScanJobs(
          requiredString(body.namespace, 'namespace'),
          requiredString(body.owner, 'owner'),
          Number(body.limit) || 1,
        ),
      }
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))
  app.post('/api/v1/memory/conflicts/scan/prepare', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await storeFor(body).prepareConflictBatch(
        requiredString(body.namespace, 'namespace'),
        requiredString(body.jobId, 'jobId'),
        requiredString(body.owner, 'owner'),
        parseEmbedding(body.seedEmbedding),
      )
    }
    catch (error) {
      return jsonError(error, 409)
    }
  }))
  app.post('/api/v1/memory/conflicts/scan/apply', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await storeFor(body).applyConflictBatch(
        requiredString(body.namespace, 'namespace'),
        requiredString(body.jobId, 'jobId'),
        requiredString(body.owner, 'owner'),
        conflictPairs(body.pairs),
      )
    }
    catch (error) {
      return jsonError(error, 409)
    }
  }))
  app.post('/api/v1/memory/jobs/list', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    return await listResult(event, 'jobs')
  }))
  app.post('/api/v1/memory/jobs/claim', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return {
        jobs: await storeFor(body).claimEmbeddingJobs(
          requiredString(body.namespace, 'namespace'),
          requiredString(body.owner, 'owner'),
          {
            limit: Number(body.limit) || 8,
            model: optionalString(body.embeddingModel),
            provider: optionalString(body.embeddingProvider),
          },
        ),
      }
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))
  app.post('/api/v1/memory/jobs/fail', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      await storeFor(body).failJob(
        requiredString(body.jobId, 'jobId'),
        requiredString(body.owner, 'owner'),
        requiredString(body.error, 'error'),
      )
      return { ok: true }
    }
    catch (error) {
      return jsonError(error, 409)
    }
  }))
  // Background drain loop moved from the renderer store into the main process:
  // the renderer sends its embedding client config and only waits when it
  // explicitly asks; hot chat paths no longer depend on vector build latency.
  app.post('/api/v1/memory/jobs/run', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const store = storeFor(body)
      const namespace = requiredString(body.namespace, 'namespace')
      const owner = requiredString(body.owner, 'owner')
      // NOTICE:
      // postgres.js returns claimed rows as its own tagged-template `Row[]`
      // type, so a direct cast is rejected. The claim query selects exactly the
      // fields `ClaimedEmbeddingJob` declares, making the double cast safe.
      const jobs = await store.claimEmbeddingJobs(namespace, owner, {
        limit: Math.min(32, Math.max(1, Math.trunc(Number(body.limit) || 8))),
        model: optionalString(body.embeddingModel),
        provider: optionalString(body.embeddingProvider),
      }) as unknown as ClaimedEmbeddingJob[]
      let completed = 0
      let failed = 0
      let lastFailure = ''
      let skipped = 0
      for (const job of jobs) {
        const memoryId = optionalString(job.payload?.memoryId)
        const schemaId = optionalString(job.payload?.schemaId)
        if (job.jobType !== 'build_embedding' || !memoryId || !schemaId || !job.inputText) {
          skipped++
          continue
        }
        try {
          const embedding = await embedForJob(job.inputText, 'passage', embeddingJobClientConfig(body))
          if (job.dimensions !== embedding.length)
            throw new Error(`Embedding job expected ${job.dimensions} dimensions but provider returned ${embedding.length}`)
          await store.putEmbedding(memoryId, schemaId, embedding)
          completed++
        }
        catch (cause) {
          failed++
          lastFailure = errorMessageFrom(cause) ?? 'Embedding job failed'
          await store.failJob(job.id, owner, lastFailure)
        }
      }
      if (failed > 0)
        throw new Error(`Failed to build ${failed} long-term memory embedding(s): ${lastFailure}`)
      return { completed, failed, skipped }
    }
    catch (error) {
      return jsonError(error)
    }
  }))
  app.post('/api/v1/memory/changes/list', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    return await listResult(event, 'changes')
  }))
  app.post('/api/v1/memory/changes/rollback', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      await storeFor(body).rollbackTransaction(requiredString(body.namespace, 'namespace'), requiredString(body.transactionId, 'transactionId'))
      return { ok: true }
    }
    catch (error) {
      return jsonError(error, 409)
    }
  }))
  app.post('/api/v1/memory/schemas/list', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await storeFor(body).listEmbeddingSchemas(requiredString(body.namespace, 'namespace'))
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/schemas/create', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return await storeFor(body).createEmbeddingSchema({
        dimensions: requiredInteger(body.jinaDimensions, 'dimensions'),
        distanceMetric: 'cosine',
        inputTemplateVersion: optionalString(body.inputTemplateVersion) ?? 'canonical-v1',
        model: requiredString(body.embeddingModel, 'embeddingModel'),
        namespace: requiredString(body.namespace, 'namespace'),
        provider: requiredString(body.embeddingProvider, 'embeddingProvider'),
        schemaVersion: requiredString(body.schemaVersion, 'schemaVersion'),
      })
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))

  for (const operation of ['activate', 'archive-fallback'] as const) {
    app.post(`/api/v1/memory/schemas/${operation}`, eventHandler(async (event) => {
      handleCors(event, corsOptions)
      try {
        const body = await payloadFor(event)
        const store = storeFor(body)
        const namespace = requiredString(body.namespace, 'namespace')
        if (operation === 'activate')
          await store.activateEmbeddingSchema(namespace, requiredString(body.schemaId, 'schemaId'))
        else
          await store.archiveFallbackSchema(namespace)
        return { ok: true }
      }
      catch (error) {
        return jsonError(error, 400)
      }
    }))
  }

  app.post('/api/v1/memory/embeddings/put', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      await storeFor(body).putEmbedding(requiredString(body.memoryId, 'memoryId'), requiredString(body.schemaId, 'schemaId'), parseEmbedding(body.embedding))
      return { ok: true }
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))

  app.post('/api/v1/memory/recall', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      const memories = await createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString')).recall({
        maxResults: Math.min(5, Math.max(1, Math.trunc(Number(body.maxResults) || 5))),
        namespace: requiredString(body.namespace, 'namespace'),
        originalText: requiredString(body.content, 'content'),
        queryPolicyVersion: optionalString(body.queryPolicyVersion),
        sessionId: optionalString(body.sourceSessionId),
        similarityThreshold: score(body.similarityThreshold, 0),
        terms: recallTerms(body.recallTerms),
        topKPerTerm: body.topKPerTerm === undefined || body.topKPerTerm === null ? undefined : Math.min(20, Math.max(1, Math.trunc(Number(body.topKPerTerm) || 5))),
      })
      return memories
    }
    catch (error) {
      return jsonError(error)
    }
  }))

  app.post('/api/v1/memory/recall/plan', eventHandler(async (event) => {
    handleCors(event, corsOptions)
    try {
      const body = await payloadFor(event)
      return {
        ...planMemoryRecallQuery(requiredString(body.content, 'content')),
        policyVersion: recallQueryPolicyVersion(),
      }
    }
    catch (error) {
      return jsonError(error, 400)
    }
  }))

  const serverManager = {
    key: 'memory-pgvector',
    start: async () => {
      const addr = await server.start()
      log.log(`pgvector memory gateway listening on ${addr.baseUrl}`)
    },
    stop: () => server.stop(),
  }

  return {
    getAddress: () => server.getAddress(),
    serverManager,
  }
}

function assertionMode(value: unknown): 'explicit' | 'implicit' | 'none' {
  return value === 'explicit' || value === 'implicit' ? value : 'none'
}

function conflictPairs(value: unknown): Array<{
  classification: 'compatible' | 'conflict' | 'duplicate' | 'uncertain' | 'unrelated'
  leftId: string
  rightId: string
}> {
  if (!Array.isArray(value))
    throw new Error('pairs must be an array')
  return value.map((pair, index) => {
    if (!pair || typeof pair !== 'object')
      throw new Error(`pairs[${index}] is invalid`)
    const record = pair as Record<string, unknown>
    const classification = optionalString(record.classification)
    if (!classification || !['compatible', 'conflict', 'duplicate', 'uncertain', 'unrelated'].includes(classification))
      throw new Error(`pairs[${index}].classification is invalid`)
    return {
      classification: classification as 'compatible' | 'conflict' | 'duplicate' | 'uncertain' | 'unrelated',
      leftId: requiredString(record.leftId, `pairs[${index}].leftId`),
      rightId: requiredString(record.rightId, `pairs[${index}].rightId`),
    }
  })
}

/**
 * Assembles the embedding client config the renderer used to own. The gateway
 * cannot read renderer-local state (`providersStore` / localStorage), so the
 * renderer forwards its choice plus the raw provider credentials record and the
 * main process builds derivative vectors with a plain fetch.
 */
function embeddingJobClientConfig(body: MemoryPayload): EmbeddingJobClientConfig {
  const embeddingModel = requiredString(body.embeddingModel, 'embeddingModel')
  const embeddingProvider = requiredString(body.embeddingProvider, 'embeddingProvider')
  const embeddingSource = body.embeddingSource === 'jina-api' || body.embeddingSource === 'airi-provider'
    ? body.embeddingSource
    : 'airi-provider'
  const jinaDimensions = Number(body.jinaDimensions)
  return {
    embeddingModel,
    embeddingProvider,
    embeddingSource,
    jinaApiKey: optionalString(body.jinaApiKey),
    jinaDimensions: Number.isFinite(jinaDimensions) ? jinaDimensions : undefined,
    providerConfig: isRecord(body.providerConfig) ? body.providerConfig : undefined,
  }
}

function instructionScope(value: unknown): InstructionScope {
  return typeof value === 'string' && INSTRUCTION_SCOPES.has(value as InstructionScope) ? value as InstructionScope : 'global'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// NOTICE:
// Default status changed from 502 to 500: this server is the origin, not a
// proxy. 502 ("Bad Gateway") misled diagnosis — the HTTP gateway IS running,
// but the upstream database (PostgreSQL) is unavailable. Callers that need a
// specific status (400 for validation, 409 for conflict) pass it explicitly.
//
// CORS headers are included on error responses because `handleCors` sets
// headers on the event's response object, but returning a new `Response`
// replaces them. Without `Access-Control-Allow-Origin` on the error body, the
// browser blocks the response and reports a CORS error — masking the real
// 500 with a misleading cross-origin failure.
function jsonError(error: unknown, status = 500): Response {
  // Use || not ??: errorMessageFrom may return "" for some PostgresError
  // variants (e.g. connection errors with only a code, no message), and ??
  // does not treat "" as falsy, producing {"error":""} which is useless
  // for diagnosis.
  const message = errorMessageFrom(error) || 'Unknown error'
  return new Response(JSON.stringify({ error: message }), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    },
    status,
  })
}

async function listResult(event: Parameters<typeof readBody>[0], kind: 'changes' | 'conflicts' | 'jobs') {
  try {
    const body = await payloadFor(event)
    const store = storeFor(body)
    const namespace = requiredString(body.namespace, 'namespace')
    if (kind === 'changes')
      return { changes: await store.listChanges(namespace) }
    if (kind === 'conflicts')
      return { conflicts: await store.listConflicts(namespace) }
    return { jobs: await store.listJobs(namespace, optionalString(body.jobStatus) ?? 'all') }
  }
  catch (error) {
    return jsonError(error)
  }
}

function memoryKind(value: unknown): MemoryKind {
  return typeof value === 'string' && MEMORY_KINDS.has(value as MemoryKind) ? value as MemoryKind : 'conversation'
}

function memoryRecord(body: MemoryPayload): PgvectorMemoryRecord {
  const sourceUserText = optionalString(body.sourceUserText) ?? optionalString(body.userText)
  const sourceAssistantText = optionalString(body.sourceAssistantText) ?? optionalString(body.assistantText)
  const fallbackContent = sourceUserText
    ? `User: ${sourceUserText}\nAssistant: ${sourceAssistantText ?? ''}`
    : undefined
  return {
    confidence: score(body.confidence, 0.7),
    content: requiredString(body.content ?? fallbackContent, 'content'),
    createdBy: optionalString(body.createdBy) ?? 'user',
    effectiveFrom: optionalString(body.effectiveFrom),
    effectiveUntil: optionalString(body.effectiveUntil),
    embedding: body.kind === 'instruction' ? undefined : parseEmbedding(body.embedding),
    embeddingModel: optionalString(body.embeddingModel) ?? '',
    embeddingProvider: optionalString(body.embeddingProvider) ?? '',
    importance: score(body.importance, 0.5),
    instructionPriority: Math.min(100, Math.max(0, Math.trunc(Number(body.instructionPriority) || 50))),
    instructionRuleKey: optionalString(body.instructionRuleKey),
    instructionScope: instructionScope(body.instructionScope),
    kind: memoryKind(body.kind),
    memoryId: requiredString(body.memoryId ?? body.id, 'memoryId'),
    namespace: requiredString(body.namespace, 'namespace'),
    sourceAssistantText,
    sourceMessageIds: stringArray(body.sourceMessageIds),
    sourceSessionId: optionalString(body.sourceSessionId),
    sourceUserText,
    status: memoryStatus(body.status),
    supersedesId: optionalString(body.supersedesId),
    tags: stringArray(body.tags),
    title: requiredString(body.title ?? sourceUserText?.slice(0, 120), 'title'),
  }
}

function memoryStatus(value: unknown): MemoryStatus {
  return typeof value === 'string' && MEMORY_STATUSES.has(value as MemoryStatus) ? value as MemoryStatus : 'active'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function parseEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'number' && Number.isFinite(item)))
    throw new Error('Embedding must be a non-empty array of finite numbers')
  return value
}

async function payloadFor(event: Parameters<typeof readBody>[0]): Promise<MemoryPayload> {
  return await readBody<MemoryPayload>(event) ?? {}
}

function recallTerms(value: unknown): Array<{ embedding: number[], text: string }> {
  if (!Array.isArray(value))
    throw new Error('recallTerms must be an array')
  return value.slice(0, 4).map((term, index) => {
    if (!term || typeof term !== 'object')
      throw new Error(`recallTerms[${index}] is invalid`)
    const record = term as Record<string, unknown>
    return {
      embedding: parseEmbedding(record.embedding),
      text: requiredString(record.text, `recallTerms[${index}].text`),
    }
  })
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed))
    throw new Error(`${field} must be an integer`)
  return parsed
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is required`)
  return value.trim()
}

function score(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback
}

function storeFor(body: MemoryPayload) {
  return createPgvectorMemoryStore(requiredString(body.connectionString, 'connectionString'))
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
}

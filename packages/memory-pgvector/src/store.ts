import type { ConflictBatchPair } from './conflictBatch.ts'
import type { AssertionMode, ClaimInput, EmbeddingSchemaInput, EvidenceInput, EvidenceSourceType, MemoryKind, MemoryStatus, PgvectorMemoryListOptions, PgvectorMemoryRecord, PgvectorMemoryView, PgvectorRecallCandidate, PgvectorRecalledMemory, PgvectorRecallOptions, PgvectorRecallResult, Polarity } from './domain.ts'

import { createHash, randomUUID } from 'node:crypto'

import postgres from 'postgres'

import { validateConflictBatch } from './conflictBatch.ts'
import { rankRecallCandidates } from './evaluation.ts'
import { areValidityIntervalsDisjoint, embeddingJobKey, supportWeight } from './policy.ts'
import { cardinalityFor, conflictSeverityFor, implicitPromotionFor, importancePolicyFor, normalizeFactIdentity, normalizeValueFor, PREDICATE_REGISTRY_VERSION, sensitivityFor } from './predicateRegistry.ts'
import { migrateMemorySchema } from './schema.ts'
import { containsSensitiveSecret } from './sensitiveContent.ts'

export type { ClaimInput, EmbeddingSchemaInput, EvidenceInput, InstructionScope, MemoryKind, MemoryStatus, PgvectorMemoryListOptions, PgvectorMemoryRecord, PgvectorMemoryView, PgvectorRecallCandidate, PgvectorRecalledMemory, PgvectorRecallOptions, PgvectorRecallResult } from './domain.ts'
export { planMemoryRecallQuery, recallQueryPolicyVersion } from './recallQuery.ts'
export type { MemoryRecallQuery } from './recallQuery.ts'

const initializedDatabases = new Set<string>()

interface CanonicalRow extends Record<string, unknown> {
  id: string
  polarity: Polarity
  revision: number
  value_text: string
}

interface ClaimRow {
  assertion_mode: AssertionMode
  evidence_id: string
  evidence_quote: string
  fact_key: string
  id: string
  kind: 'fact' | 'preference'
  polarity: Polarity
  predicate: string
  promoted_memory_id?: string
  scope: string
  source_type: EvidenceSourceType
  status: string
  subject: string
  valid_from?: string
  valid_until?: string
  value_text: string
}

interface ConflictScanPayload {
  attemptedIds: string[]
  batches: Array<Record<string, unknown>>
  currentBatchIds: string[]
  memoryIds: string[]
  pendingIds: string[]
  policyVersion: string
  schemaId: string
}

interface FeedbackInput {
  evidenceQuote?: string
  feedback: 'irrelevant' | 'outdated' | 'useful' | 'wrong'
  memoryId: string
  namespace: string
  reasonCode?: string
  retrievalId?: string
  source: 'automatic' | 'user'
  sourceEventId: string
}

interface RecallRow extends PgvectorRecalledMemory {
  factKey: null | string
  predicate: null | string
}

/**
 * Creates the authoritative PostgreSQL memory boundary.
 *
 * Text evidence is immutable, canonical rows are revisioned projections, and
 * embeddings are replaceable schema-versioned derivatives. Each call uses a
 * short-lived connection so changing desktop credentials takes effect without restart.
 */
export function createPgvectorMemoryStore(connectionString: string) {
  async function withDatabase<T>(operation: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(connectionString, { connect_timeout: 10, max: 1 })
    try {
      if (!initializedDatabases.has(connectionString)) {
        await migrateMemorySchema(sql)
        initializedDatabases.add(connectionString)
      }
      return await operation(sql)
    }
    finally {
      await sql.end({ timeout: 5 })
    }
  }

  async function health(): Promise<{ memoryCount: number, pgvectorVersion: string }> {
    return await withDatabase(async (sql) => {
      const versions = await sql<{ extversion: string }[]>`SELECT extversion FROM pg_extension WHERE extname = 'vector'`
      const counts = await sql<{ count: number }[]>`
        SELECT (SELECT COUNT(*) FROM canonical_memories)::INTEGER
             + (SELECT COUNT(*) FROM memory_instructions)::INTEGER AS count
      `
      return { memoryCount: counts[0]?.count ?? 0, pgvectorVersion: versions[0]?.extversion ?? 'unknown' }
    })
  }

  async function ingestEvidence(input: EvidenceInput): Promise<{ blocked: boolean, created: boolean, evidenceId: string }> {
    const content = input.content.trim()
    if (containsSensitiveSecret(content)) {
      // Privacy gate shared with the renderer extractor guard: credential-shaped
      // text must not enter long-term memory. Audit the drop without persisting
      // the raw content — writing it to the change log would re-introduce the
      // secret. The caller sees an empty evidenceId and skips claim extraction.
      const contentHash = hash(content)
      await withDatabase(sql => recordChange(sql, 'evidence', `sensitive:${contentHash}`, 'block_sensitive', null, {
        contentHash,
        namespace: input.namespace,
        sourceId: input.sourceId,
        sourceType: input.sourceType,
      }, 'system'))
      return { blocked: true, created: false, evidenceId: '' }
    }
    const contentHash = hash(content)
    const evidenceId = stableId('evidence', input.namespace, input.sourceType, input.sourceId, contentHash)
    return await withDatabase(async (sql) => {
      const rows = await sql<{ id: string }[]>`
        INSERT INTO memory_evidence (
          id, namespace, source_type, source_id, source_role, source_session_id,
          source_message_id, content, content_hash, observed_at, metadata
        ) VALUES (
          ${evidenceId}, ${input.namespace}, ${input.sourceType}, ${input.sourceId}, ${input.sourceRole},
          ${input.sourceSessionId ?? null}, ${input.sourceMessageId ?? null}, ${content}, ${contentHash},
          ${input.observedAt ?? null}, ${sql.json(toJsonValue(input.metadata ?? {}))}
        ) ON CONFLICT (namespace, source_type, source_id, content_hash) DO NOTHING
        RETURNING id
      `
      if (rows[0])
        await recordChange(sql, 'evidence', evidenceId, 'create', null, { ...input, contentHash }, 'system')
      return { blocked: false, created: rows.length > 0, evidenceId }
    })
  }

  async function listEvidence(namespace: string, limit = 50, offset = 0, options: { status?: 'active' | 'all' | 'archived' } = {}) {
    const status = options.status ?? 'all'
    return await withDatabase(sql => sql`
      SELECT id, namespace, source_type AS "sourceType", source_id AS "sourceId",
        source_role AS "sourceRole", source_session_id AS "sourceSessionId",
        source_message_id AS "sourceMessageId", content, observed_at::TEXT AS "observedAt",
        status, archived_at::TEXT AS "archivedAt",
        metadata, created_at::TEXT AS "createdAt"
      FROM memory_evidence WHERE namespace = ${namespace}
        AND (${status} = 'all' OR status = ${status})
      ORDER BY created_at DESC LIMIT ${bounded(limit, 1, 100)} OFFSET ${Math.max(0, Math.trunc(offset))}
    `)
  }

  /**
   * Soft-archives unreferenced evidence older than the retention window.
   *
   * PRD v2 keeps evidence immutable, so rows are flagged `archived` instead of
   * deleted. Evidence still referenced by a claim or an evidence link stays
   * active because its traceability is load-bearing.
   */
  async function archiveEvidence(namespace: string, options: { days?: number, limit?: number } = {}): Promise<{ archived: number }> {
    const olderThanDays = Math.max(1, Math.trunc(options.days ?? 90))
    const limit = bounded(options.limit ?? 500, 1, 5000)
    return await withDatabase(async (sql) => {
      const rows = await sql<{ content: string, id: string }[]>`
        SELECT e.id, e.content
        FROM memory_evidence e
        WHERE e.namespace = ${namespace}
          AND e.status = 'active'
          AND e.created_at < NOW() - (${olderThanDays}::INTEGER * INTERVAL '1 day')
          AND NOT EXISTS (SELECT 1 FROM memory_claims c WHERE c.evidence_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM memory_evidence_links l WHERE l.evidence_id = e.id)
        ORDER BY e.created_at
        LIMIT ${limit}
      `
      for (const row of rows) {
        const updated = await sql`
          UPDATE memory_evidence SET status = 'archived', archived_at = NOW()
          WHERE id = ${row.id} RETURNING id, status, archived_at::TEXT AS "archivedAt"
        `
        await recordChange(sql, 'evidence', row.id, 'archive', row, updated[0], 'system')
      }
      return { archived: rows.length }
    })
  }

  async function createClaim(input: ClaimInput, schemaVersion = 'claim-v1'): Promise<{ claimId: string, created: boolean }> {
    const identity = normalizeFactIdentity(input)
    // Value normalization is part of the stored identity: 上海市 and 上海 must
    // collapse to one value so the set/temporal conflict tracks stay aligned.
    const value = normalizeValueFor(identity.predicate, input.value)
    const effectiveSchemaVersion = `${schemaVersion}:${PREDICATE_REGISTRY_VERSION}`
    const claimHash = hash([input.kind, identity.factKey, input.polarity, value, input.quote].join('\u001F'))
    const claimId = stableId('claim', input.evidenceId, effectiveSchemaVersion, claimHash)
    return await withDatabase(async (sql) => {
      const evidence = await sql<{ content: string, sourceType: EvidenceInput['sourceType'] }[]>`
        SELECT content, source_type AS "sourceType" FROM memory_evidence
        WHERE id = ${input.evidenceId} AND namespace = ${input.namespace}
      `
      const source = evidence[0]
      if (!source)
        throw new Error('Evidence does not exist in this namespace')
      if (source.content.slice(input.quoteStart, input.quoteEnd) !== input.quote)
        throw new Error('Evidence quote does not match the declared UTF-16 half-open range')

      const rows = await sql<{ id: string }[]>`
        INSERT INTO memory_claims (
          id, namespace, evidence_id, kind, subject, predicate, scope, fact_key,
          polarity, value_text, assertion_mode, evidence_quote, quote_start, quote_end,
          valid_from, valid_until, schema_version, claim_hash
        ) VALUES (
          ${claimId}, ${input.namespace}, ${input.evidenceId}, ${input.kind}, ${identity.subject},
          ${identity.predicate}, ${identity.scope}, ${identity.factKey}, ${input.polarity}, ${value},
          ${input.assertionMode}, ${input.quote}, ${input.quoteStart}, ${input.quoteEnd},
          ${input.validFrom ?? null}, ${input.validUntil ?? null}, ${effectiveSchemaVersion}, ${claimHash}
        ) ON CONFLICT (evidence_id, schema_version, claim_hash) DO NOTHING RETURNING id
      `
      if (rows[0])
        await recordChange(sql, 'claim', claimId, 'create', null, input, 'extractor')
      return { claimId, created: rows.length > 0 }
    })
  }

  async function listClaims(namespace: string, status: string = 'all') {
    return await withDatabase(sql => sql`
      SELECT id, evidence_id AS "evidenceId", kind, fact_key AS "factKey", polarity,
        value_text AS value, assertion_mode AS "assertionMode", evidence_quote AS quote,
        valid_from::TEXT AS "validFrom", valid_until::TEXT AS "validUntil", status,
        promoted_memory_id AS "promotedMemoryId", revision, created_at::TEXT AS "createdAt"
      FROM memory_claims
      WHERE namespace = ${namespace} AND (${status} = 'all' OR status = ${status})
      ORDER BY created_at DESC LIMIT 100
    `)
  }

  async function validateClaim(namespace: string, claimId: string): Promise<void> {
    await withDatabase(async (sql) => {
      const before = await oneForUpdate(sql, 'memory_claims', namespace, claimId)
      if (before.status !== 'proposed' && before.status !== 'quarantined')
        throw new Error(`Claim cannot be validated from ${String(before.status)}`)
      const rows = await sql`UPDATE memory_claims SET status = 'validated', revision = revision + 1, updated_at = NOW() WHERE id = ${claimId} RETURNING *`
      await recordChange(sql, 'claim', claimId, 'validate', before, rows[0], 'user')
    })
  }

  async function promoteClaim(namespace: string, claimId: string, source: 'auto' | 'user' = 'user'): Promise<{ memoryId?: string, outcome: 'conflict' | 'promoted' | 'quarantined' | 'rejected' }> {
    return await withDatabase(async sql => await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
      const claims = await transaction<ClaimRow[]>`
        SELECT c.*, e.source_type FROM memory_claims c
        JOIN memory_evidence e ON e.id = c.evidence_id
        WHERE c.id = ${claimId} AND c.namespace = ${namespace} FOR UPDATE OF c
      `
      const claim = claims[0]
      if (!claim)
        throw new Error('Claim not found')
      if (claim.status === 'promoted')
        return { memoryId: claim.promoted_memory_id as string, outcome: 'promoted' as const }
      if (claim.status !== 'validated')
        return { outcome: 'rejected' as const }

      const existing = await transaction<CanonicalRow[]>`
        SELECT * FROM canonical_memories
        WHERE namespace = ${namespace} AND fact_key = ${claim.fact_key}
          AND status IN ('active','disputed')
        ORDER BY created_at, id FOR UPDATE
      `
      const same = existing.find(memory => memory.value_text === claim.value_text && memory.polarity === claim.polarity)
      if (same) {
        await linkClaim(transaction, same.id, claim)
        await recalculateConfidence(transaction, same.id)
        await transaction`UPDATE memory_claims SET status = 'promoted', promoted_memory_id = ${same.id}, revision = revision + 1, updated_at = NOW() WHERE id = ${claimId}`
        await enqueueEmbeddingJobs(transaction, namespace, same.id, Number(same.revision) + 1)
        return { memoryId: same.id as string, outcome: 'promoted' as const }
      }

      // Quarantined memories are intentionally excluded. They require an explicit
      // user restore before they can participate in a later conflict run.
      const cardinality = cardinalityFor(claim.predicate)
      if (cardinality === 'unknown' && source === 'auto') {
        // Unknown predicates have no trustworthy single/set semantics. Keeping
        // the validated claim in quarantine preserves its evidence without
        // inventing a cardinality or creating an unsafe canonical projection.
        // Manual (user) promotion is still allowed: the user explicitly confirmed
        // the claim, so it falls through and is treated with single semantics.
        await transaction`UPDATE memory_claims SET status = 'quarantined', revision = revision + 1, updated_at = NOW() WHERE id = ${claimId}`
        return { outcome: 'quarantined' as const }
      }
      if (source === 'auto' && (
        // Sensitive predicates never auto-activate (PRD v2 §6.3): the user
        // confirms before a sensitive value becomes an injected fact.
        sensitivityFor(claim.predicate) === 'sensitive'
        || (claim.assertion_mode === 'implicit' && (claim.kind !== 'preference' || !implicitPromotionFor(claim.predicate)))
      )) {
        // Implicit promotion is an allow-list in the predicate registry. The
        // auto path keeps anything else quarantined instead of silently
        // becoming a canonical fact; manual promotion still works.
        await transaction`UPDATE memory_claims SET status = 'quarantined', revision = revision + 1, updated_at = NOW() WHERE id = ${claimId}`
        return { outcome: 'quarantined' as const }
      }
      const temporalChange = cardinality === 'temporal_single'
        && existing.every(memory => areValidityIntervalsDisjoint(
          { validFrom: asOptionalString(memory.valid_from), validUntil: asOptionalString(memory.valid_until) },
          { validFrom: claim.valid_from, validUntil: claim.valid_until },
        ))
      if (existing.length > 0 && cardinality === 'set') {
        // A set predicate conflicts only when the same value flips polarity
        // (PRD v2 §5.1); different set members coexist.
        const opposite = existing.find(memory => memory.value_text === claim.value_text && memory.polarity !== claim.polarity)
        if (opposite) {
          const conflictId = stableId('conflict', opposite.id, claimId)
          await transaction`
            INSERT INTO memory_conflicts (
              id, namespace, fact_key, left_memory_id, candidate_claim_id, detection_method, status, importance
            ) VALUES (${conflictId}, ${namespace}, ${claim.fact_key}, ${opposite.id}, ${claimId}, 'fact_key_polarity', 'awaiting_user', ${conflictSeverityFor(claim.predicate) ?? null})
            ON CONFLICT DO NOTHING
          `
          await transaction`UPDATE memory_claims SET status = 'quarantined', revision = revision + 1, updated_at = NOW() WHERE id = ${claimId}`
          return { outcome: 'conflict' as const }
        }
      }
      if (existing.length > 0 && cardinality !== 'set' && !temporalChange) {
        const left = existing[0]
        const conflictId = stableId('conflict', left.id, claimId)
        // Deterministic first-track conflicts wait for the user; no
        // classify_conflict worker exists, so enqueueing one would strand it.
        await transaction`
          INSERT INTO memory_conflicts (
            id, namespace, fact_key, left_memory_id, candidate_claim_id, detection_method, status, importance
          ) VALUES (${conflictId}, ${namespace}, ${claim.fact_key}, ${left.id}, ${claimId}, 'fact_key', 'awaiting_user', ${conflictSeverityFor(claim.predicate) ?? null})
          ON CONFLICT DO NOTHING
        `
        await transaction`UPDATE memory_claims SET status = 'quarantined', revision = revision + 1, updated_at = NOW() WHERE id = ${claimId}`
        return { outcome: 'conflict' as const }
      }

      const memoryId = stableId('memory', claimId)
      if (temporalChange) {
        for (const memory of existing)
          await transaction`UPDATE canonical_memories SET status = 'expired', revision = revision + 1, updated_at = NOW() WHERE id = ${memory.id}`
      }
      await transaction`
        INSERT INTO canonical_memories (
          id, namespace, title, kind, subject, predicate, scope, fact_key, polarity,
          value_text, importance, confidence, status, valid_from, valid_until, created_by
        ) VALUES (
          ${memoryId}, ${namespace}, ${claim.evidence_quote.slice(0, 120)}, ${claim.kind}, ${claim.subject},
          ${claim.predicate}, ${claim.scope}, ${claim.fact_key}, ${claim.polarity}, ${claim.value_text},
          ${initialImportance(claim.kind, claim.assertion_mode, claim.predicate)}, NULL, 'active', ${claim.valid_from ?? null},
          ${claim.valid_until ?? null}, 'promotion-policy-v1'
        )
      `
      await linkClaim(transaction, memoryId, claim)
      await recalculateConfidence(transaction, memoryId)
      await transaction`UPDATE memory_claims SET status = 'promoted', promoted_memory_id = ${memoryId}, revision = revision + 1, updated_at = NOW() WHERE id = ${claimId}`
      await enqueueEmbeddingJobs(transaction, namespace, memoryId, 1)
      await recordChange(transaction, 'memory', memoryId, 'promote', null, { claimId }, 'promotion-policy-v1')
      return { memoryId, outcome: 'promoted' as const }
    }))
  }

  async function upsert(memory: PgvectorMemoryRecord): Promise<void> {
    if (memory.kind === 'instruction') {
      await upsertInstruction(memory)
      return
    }
    await upsertManualMemory(memory)
  }

  async function upsertInstruction(memory: PgvectorMemoryRecord): Promise<void> {
    if ((memory.createdBy ?? 'user') !== 'user')
      throw new Error('Permanent instructions can only be created by the user')
    const ruleKey = memory.instructionRuleKey?.trim() || null
    await withDatabase(async sql => await sql.begin(async (transaction) => {
      const before = (await transaction`SELECT * FROM memory_instructions WHERE id = ${memory.memoryId} FOR UPDATE`)[0] ?? null
      await transaction`
        INSERT INTO memory_instructions (
          id, namespace, title, content, scope, priority, rule_key, tags,
          valid_from, valid_until, status, created_by
        ) VALUES (
          ${memory.memoryId}, ${memory.namespace}, ${memory.title.trim()}, ${memory.content.trim()},
          ${memory.instructionScope ?? 'global'}, ${bounded(memory.instructionPriority ?? 50, 0, 100)},
          ${ruleKey}, ${cleanTags(memory.tags)}, ${memory.effectiveFrom ?? null}, ${memory.effectiveUntil ?? null},
          ${instructionStatus(memory.status)}, 'user'
        ) ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title, content = EXCLUDED.content, scope = EXCLUDED.scope,
          priority = EXCLUDED.priority, rule_key = EXCLUDED.rule_key, tags = EXCLUDED.tags,
          valid_from = EXCLUDED.valid_from, valid_until = EXCLUDED.valid_until,
          status = EXCLUDED.status, revision = memory_instructions.revision + 1, updated_at = NOW()
      `
      await recordChange(transaction, 'instruction', memory.memoryId, before ? 'update' : 'create', before, memory, 'user')
    }))
  }

  async function upsertManualMemory(memory: PgvectorMemoryRecord): Promise<void> {
    await withDatabase(async sql => await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${memory.namespace}, 0))`
      const before = (await transaction`SELECT * FROM canonical_memories WHERE id = ${memory.memoryId} FOR UPDATE`)[0] ?? null
      const kind = canonicalKind(memory.kind)
      // summary memories are polarity-less by schema; only fact/preference carry polarity
      const polarity = kind === 'summary' ? null : (memory.content.trim().startsWith('!') ? 'negative' : 'positive')
      await transaction`
        INSERT INTO canonical_memories (
          id, namespace, title, kind, subject, predicate, scope, fact_key, polarity,
          value_text, tags, importance, confidence, status, valid_from, valid_until,
          created_by, supersedes_id
        ) VALUES (
          ${memory.memoryId}, ${memory.namespace}, ${memory.title.trim()}, ${kind},
          'user', 'manual_note', 'global', ${`user/manual_note/${memory.memoryId}`}, ${polarity},
          ${memory.content.trim()}, ${cleanTags(memory.tags)}, ${normalizedScore(memory.importance, 0.5)},
          1, ${canonicalStatus(memory.status)}, ${memory.effectiveFrom ?? null}, ${memory.effectiveUntil ?? null},
          'user', ${memory.supersedesId ?? null}
        ) ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title, value_text = EXCLUDED.value_text, tags = EXCLUDED.tags,
          importance = EXCLUDED.importance, status = EXCLUDED.status, valid_from = EXCLUDED.valid_from,
          valid_until = EXCLUDED.valid_until, supersedes_id = EXCLUDED.supersedes_id,
          confidence = 1, revision = canonical_memories.revision + 1, updated_at = NOW()
      `
      const rows = await transaction<{ revision: number }[]>`SELECT revision FROM canonical_memories WHERE id = ${memory.memoryId}`
      await enqueueEmbeddingJobs(transaction, memory.namespace, memory.memoryId, rows[0]?.revision ?? 1)
      if (memory.embedding)
        await putCompatibilityEmbedding(transaction, memory, rows[0]?.revision ?? 1)
      await recordChange(transaction, 'memory', memory.memoryId, before ? 'update' : 'create', before, memory, 'user')
    }))
  }

  async function list(options: PgvectorMemoryListOptions): Promise<{ memories: PgvectorMemoryView[], total: number }> {
    const namespaces = options.namespaces.map(value => value.trim()).filter(Boolean)
    if (namespaces.length === 0)
      return { memories: [], total: 0 }
    const status = options.status ?? 'all'
    const search = options.search?.trim() ?? ''
    const limit = bounded(options.limit, 1, 100)
    const offset = Math.max(0, Math.trunc(options.offset))
    return await withDatabase(async (sql) => {
      const rows = await sql<PgvectorMemoryView[]>`
        WITH memories AS (${memoryProjection(sql, namespaces, status, search)})
        SELECT * FROM memories ORDER BY "updatedAt" DESC LIMIT ${limit} OFFSET ${offset}
      `
      const counts = await sql<{ count: number }[]>`
        WITH memories AS (${memoryProjection(sql, namespaces, status, search)})
        SELECT COUNT(*)::INTEGER AS count FROM memories
      `
      return { memories: rows, total: counts[0]?.count ?? 0 }
    })
  }

  async function archive(namespace: string, memoryId: string): Promise<boolean> {
    return await withDatabase(async sql => await sql.begin(async (transaction) => {
      const canonical = await transaction<CanonicalRow[]>`SELECT * FROM canonical_memories WHERE namespace = ${namespace} AND id = ${memoryId} FOR UPDATE`
      if (canonical[0]) {
        const rows = await transaction`UPDATE canonical_memories SET status = 'archived', revision = revision + 1, updated_at = NOW() WHERE id = ${memoryId} RETURNING *`
        await recordChange(transaction, 'memory', memoryId, 'archive', canonical[0], rows[0], 'user')
        return true
      }
      const instruction = await transaction<Record<string, unknown>[]>`SELECT * FROM memory_instructions WHERE namespace = ${namespace} AND id = ${memoryId} FOR UPDATE`
      if (!instruction[0])
        return false
      const rows = await transaction`UPDATE memory_instructions SET status = 'archived', revision = revision + 1, updated_at = NOW() WHERE id = ${memoryId} RETURNING *`
      await recordChange(transaction, 'instruction', memoryId, 'archive', instruction[0], rows[0], 'user')
      return true
    }))
  }

  async function recall(options: PgvectorRecallOptions): Promise<PgvectorRecallResult> {
    const terms = options.terms
      .map(term => ({ embedding: term.embedding, text: term.text.trim() }))
      .filter(term => term.text && term.embedding.length > 0)
      .slice(0, 4)
    if (terms.length === 0)
      throw new Error('Recall requires at least one non-empty term embedding')
    return await withDatabase(async (sql) => {
      const state = await sql<{ activeSchemaId?: string, dimensions?: number }[]>`
        SELECT s.active_schema_id AS "activeSchemaId", e.dimensions
        FROM embedding_schema_state s
        LEFT JOIN embedding_schemas e ON e.id = s.active_schema_id
        WHERE s.namespace = ${options.namespace}
      `
      const schemaId = state[0]?.activeSchemaId
      const retrievalId = randomUUID()
      if (!schemaId) {
        const trace = {
          candidates: [],
          originalText: options.originalText,
          queryPolicyVersion: options.queryPolicyVersion,
          retrievalId,
          terms: terms.map(term => term.text),
        }
        await sql`INSERT INTO memory_retrievals (id, namespace, session_id, query_text, trace) VALUES (${retrievalId}, ${options.namespace}, ${options.sessionId ?? null}, ${options.originalText}, ${sql.json(trace)})`
        return { memories: [], trace }
      }

      const expectedDimensions = Number(state[0]?.dimensions)
      if (terms.some(term => term.embedding.length !== expectedDimensions))
        throw new Error(`Recall embedding dimensions must match the active schema (${expectedDimensions})`)

      const candidateRows: Array<{ row: RecallRow, term: string, termRank: number }> = []
      for (const term of terms) {
        const vector = vectorLiteral(term.embedding)
        const rows = await sql<RecallRow[]>`
          SELECT m.id AS "memoryId", m.namespace, m.title, m.value_text AS content, m.kind,
            m.tags, m.importance, m.confidence, m.status, '' AS "embeddingProvider", '' AS "embeddingModel",
            ARRAY[]::TEXT[] AS "sourceMessageIds", m.supersedes_id AS "supersedesId",
            'global' AS "instructionScope", 0 AS "instructionPriority", NULL AS "instructionRuleKey",
            m.fact_key AS "factKey", m.predicate,
            m.valid_from::TEXT AS "effectiveFrom", m.valid_until::TEXT AS "effectiveUntil",
            m.created_by AS "createdBy", m.revision, m.created_at::TEXT AS "createdAt",
            m.updated_at::TEXT AS "updatedAt", 1 - (e.vector <=> ${vector}::vector) AS similarity,
            ${retrievalId} AS "retrievalId"
          FROM canonical_memories m JOIN memory_embeddings e ON e.memory_id = m.id
          WHERE m.namespace = ${options.namespace} AND e.schema_id = ${schemaId} AND e.build_status = 'ready'
          ORDER BY 1 - (e.vector <=> ${vector}::vector) DESC, m.id
          LIMIT ${bounded(options.topKPerTerm ?? 5, 1, 20)}
        `
        rows.forEach((row, index) => candidateRows.push({ row, term: term.text, termRank: index + 1 }))
      }

      const merged = new Map<string, { row: RecallRow, sources: Array<{ term: string, termRank: number }> }>()
      for (const candidate of candidateRows) {
        const existing = merged.get(candidate.row.memoryId)
        if (!existing || candidate.row.similarity > existing.row.similarity) {
          merged.set(candidate.row.memoryId, {
            row: candidate.row,
            sources: existing
              ? [...existing.sources, { term: candidate.term, termRank: candidate.termRank }]
              : [{ term: candidate.term, termRank: candidate.termRank }],
          })
        }
        else {
          existing.sources.push({ term: candidate.term, termRank: candidate.termRank })
        }
      }

      const now = Date.now()
      const seenSingleFactKeys = new Set<string>()
      const selected: RecallRow[] = []
      const filterReasons = new Map<string, PgvectorRecallCandidate['filterReason']>()
      for (const item of [...merged.values()].sort((left, right) => right.row.similarity - left.row.similarity || left.row.memoryId.localeCompare(right.row.memoryId))) {
        const row = item.row
        let reason: PgvectorRecallCandidate['filterReason']
        if (row.status !== 'active')
          reason = 'status'
        else if (row.confidence === null || row.confidence <= 0)
          reason = 'confidence'
        else if ((row.effectiveFrom && Date.parse(row.effectiveFrom) > now) || (row.effectiveUntil && Date.parse(row.effectiveUntil) <= now))
          reason = 'expired'
        else if (row.similarity < normalizedScore(options.similarityThreshold, 0))
          reason = 'similarity'
        else if (row.factKey && row.predicate && cardinalityFor(row.predicate) !== 'set' && cardinalityFor(row.predicate) !== 'unknown' && seenSingleFactKeys.has(row.factKey))
          reason = 'duplicate_fact_key'

        if (reason) {
          filterReasons.set(row.memoryId, reason)
          continue
        }
        if (row.factKey && row.predicate && cardinalityFor(row.predicate) !== 'set' && cardinalityFor(row.predicate) !== 'unknown')
          seenSingleFactKeys.add(row.factKey)
        if (selected.length < bounded(options.maxResults, 1, 5))
          selected.push(row)
      }

      const selectedIds = new Set(selected.map(row => row.memoryId))
      // PRD v2 §7 keeps the pure-similarity baseline in the trace so a future
      // utility/importance re-rank can be compared against it (issue #8).
      const rankings = rankRecallCandidates(
        [...merged.values()].map(item => ({ memoryId: item.row.memoryId, similarity: item.row.similarity })),
        selected.map(row => row.memoryId),
      )
      const traceCandidates: PgvectorRecallCandidate[] = candidateRows.map((candidate) => {
        const ranking = rankings.get(candidate.row.memoryId)
        return {
          baselineRank: ranking?.baselineRank,
          filterReason: filterReasons.get(candidate.row.memoryId),
          finalRank: ranking?.finalRank,
          injected: selectedIds.has(candidate.row.memoryId),
          memoryId: candidate.row.memoryId,
          similarity: candidate.row.similarity,
          term: candidate.term,
          termRank: candidate.termRank,
        }
      })
      const trace = {
        candidates: traceCandidates,
        originalText: options.originalText,
        queryPolicyVersion: options.queryPolicyVersion,
        retrievalId,
        schemaId,
        terms: terms.map(term => term.text),
      }
      await sql.begin(async (transaction) => {
        await transaction`INSERT INTO memory_retrievals (id, namespace, session_id, query_text, schema_id, trace) VALUES (${retrievalId}, ${options.namespace}, ${options.sessionId ?? null}, ${options.originalText}, ${schemaId}, ${transaction.json(toJsonValue(trace))})`
        for (const [index, row] of selected.entries())
          await transaction`INSERT INTO memory_retrieval_items (retrieval_id, memory_id, rank, similarity, injected) VALUES (${retrievalId}, ${row.memoryId}, ${index + 1}, ${row.similarity}, TRUE)`
      })
      const memories = selected.map(({ factKey: _factKey, predicate: _predicate, ...row }) => row)
      return { memories, trace }
    })
  }

  async function instructions(namespace: string): Promise<PgvectorMemoryView[]> {
    const result = await list({ limit: 100, namespaces: [namespace], offset: 0, status: 'active' })
    return result.memories.filter(memory => memory.kind === 'instruction')
  }

  async function feedback(input: FeedbackInput): Promise<void> {
    await withDatabase(async sql => await sql.begin(async (transaction) => {
      const transactionId = randomUUID()
      const memoryBefore = (await transaction`SELECT * FROM canonical_memories WHERE id = ${input.memoryId} AND namespace = ${input.namespace} FOR UPDATE`)[0]
      if (!memoryBefore)
        throw new Error('Feedback memory not found')
      const id = stableId('feedback', input.source, input.sourceEventId, input.memoryId)
      const inserted = await transaction`
        INSERT INTO memory_feedback (
          id, namespace, memory_id, retrieval_id, feedback, source, source_event_id, evidence_quote, reason_code
        ) VALUES (${id}, ${input.namespace}, ${input.memoryId}, ${input.retrievalId ?? null}, ${input.feedback},
          ${input.source}, ${input.sourceEventId}, ${input.evidenceQuote ?? null}, ${input.reasonCode ?? null})
        ON CONFLICT (source, source_event_id, memory_id) DO NOTHING RETURNING *
      `
      if (!inserted[0])
        return
      if (input.feedback === 'wrong' || input.feedback === 'outdated') {
        // Automatic attribution is only accepted when it identifies one concrete
        // memory and supplies the user quote that justified that selection.
        if (input.source === 'automatic') {
          if (!input.evidenceQuote?.trim() || !input.retrievalId)
            throw new Error('Automatic correction requires a quote and retrieval tied to one memory')
          const targets = await transaction<{ found: boolean }[]>`
            SELECT EXISTS(
              SELECT 1 FROM memory_retrieval_items
              WHERE retrieval_id = ${input.retrievalId} AND memory_id = ${input.memoryId} AND injected
            ) AS found
          `
          if (!targets[0]?.found)
            throw new Error('Automatic correction target was not injected in the referenced retrieval')
        }
        const nextStatus = input.source === 'automatic' ? 'quarantined' : input.feedback === 'outdated' ? 'expired' : 'superseded'
        if (input.source === 'user' && input.feedback === 'wrong')
          await transaction`UPDATE memory_evidence_links SET valid = FALSE WHERE memory_id = ${input.memoryId} AND relation = 'supports'`
        await transaction`UPDATE canonical_memories SET status = ${nextStatus}, confidence = CASE WHEN ${input.source} = 'user' AND ${input.feedback} = 'wrong' THEN 0 ELSE confidence END, revision = revision + 1, updated_at = NOW() WHERE id = ${input.memoryId}`
      }
      await recalculateUtility(transaction, input.memoryId)
      const memoryAfter = (await transaction`SELECT * FROM canonical_memories WHERE id = ${input.memoryId}`)[0]
      await recordChange(transaction, 'feedback', id, 'create', null, inserted[0], input.source, transactionId)
      if (JSON.stringify(memoryBefore) !== JSON.stringify(memoryAfter))
        await recordChange(transaction, 'memory', input.memoryId, `feedback:${input.feedback}`, memoryBefore, memoryAfter, input.source, transactionId)
    }))
  }

  async function createEmbeddingSchema(input: EmbeddingSchemaInput) {
    const id = stableId('schema', input.namespace, input.schemaVersion)
    return await withDatabase(async (sql) => {
      await sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO embedding_schemas (
            id, namespace, schema_version, provider, model, dimensions, distance_metric, input_template_version, status
          ) VALUES (${id}, ${input.namespace}, ${input.schemaVersion}, ${input.provider}, ${input.model}, ${input.dimensions}, ${input.distanceMetric}, ${input.inputTemplateVersion}, 'building')
          ON CONFLICT (namespace, schema_version) DO NOTHING
        `
        const memories = await transaction<{ id: string, revision: number }[]>`
          SELECT id, revision FROM canonical_memories WHERE namespace = ${input.namespace}
            AND status IN ('active','disputed') AND kind IN ('fact','preference','summary')
        `
        for (const memory of memories)
          await enqueueEmbedding(transaction, input.namespace, memory.id, id, memory.revision)
      })
      return { schemaId: id }
    })
  }

  async function listEmbeddingSchemas(namespace: string) {
    return await withDatabase(async (sql) => {
      const schemas = await sql`
        SELECT s.*, COUNT(e.*)::INTEGER AS eligible_count,
          COUNT(e.*) FILTER (WHERE e.build_status = 'ready')::INTEGER AS ready_count,
          COUNT(e.*) FILTER (WHERE e.build_status = 'failed')::INTEGER AS failed_count
        FROM embedding_schemas s LEFT JOIN memory_embeddings e ON e.schema_id = s.id
        WHERE s.namespace = ${namespace} GROUP BY s.id ORDER BY s.created_at DESC
      `
      const state = (await sql`SELECT * FROM embedding_schema_state WHERE namespace = ${namespace}`)[0] ?? null
      return { schemas, state }
    })
  }

  async function activateEmbeddingSchema(namespace: string, schemaId: string): Promise<void> {
    await withDatabase(async sql => await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
      const schemas = await transaction<{ id: string }[]>`SELECT id FROM embedding_schemas WHERE id = ${schemaId} AND namespace = ${namespace} FOR UPDATE`
      const schema = schemas[0]
      if (!schema)
        throw new Error('Embedding schema not found')
      const coverage = await transaction<{ eligible: number, ready: number }[]>`
        SELECT COUNT(*)::INTEGER AS eligible,
          COUNT(*) FILTER (WHERE e.build_status = 'ready')::INTEGER AS ready
        FROM canonical_memories m LEFT JOIN memory_embeddings e ON e.memory_id = m.id AND e.schema_id = ${schemaId}
        WHERE m.namespace = ${namespace} AND m.status IN ('active','disputed') AND m.kind IN ('fact','preference','summary')
      `
      if ((coverage[0]?.eligible ?? 0) !== (coverage[0]?.ready ?? 0))
        throw new Error('Embedding schema cannot become active before 100% eligible coverage')
      const schemaDetails = (await transaction<{ dimensions: number }[]>`SELECT dimensions FROM embedding_schemas WHERE id = ${schemaId}`)[0]
      if (!schemaDetails || !/^schema_[a-f\d]{32}$/.test(schemaId))
        throw new Error('Embedding schema identity is invalid')
      const indexName = `memory_embedding_${hash(schemaId).slice(0, 16)}`
      // Fixed-dimension partial indexes isolate vector spaces even though the
      // physical vector column can store several embedding dimensions.
      await transaction.unsafe(`CREATE INDEX IF NOT EXISTS ${indexName} ON memory_embeddings USING hnsw ((vector::vector(${schemaDetails.dimensions})) vector_cosine_ops) WHERE schema_id = '${schemaId}' AND build_status = 'ready'`)
      await transaction`UPDATE embedding_schemas SET status = 'ready', index_name = ${indexName}, index_status = 'ready', updated_at = NOW() WHERE id = ${schemaId}`
      await transaction`
        INSERT INTO embedding_schema_state (namespace, active_schema_id)
        VALUES (${namespace}, ${schemaId})
        ON CONFLICT (namespace) DO UPDATE SET
          fallback_schema_id = CASE WHEN embedding_schema_state.active_schema_id <> EXCLUDED.active_schema_id THEN embedding_schema_state.active_schema_id ELSE embedding_schema_state.fallback_schema_id END,
          active_schema_id = EXCLUDED.active_schema_id, revision = embedding_schema_state.revision + 1, updated_at = NOW()
      `
      await recordChange(transaction, 'embedding_schema_state', namespace, 'activate', null, { schemaId }, 'user')
    }))
  }

  async function archiveFallbackSchema(namespace: string): Promise<boolean> {
    return await withDatabase(async sql => await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
      const rows = await transaction<{ fallbackSchemaId?: string }[]>`
        SELECT fallback_schema_id AS "fallbackSchemaId" FROM embedding_schema_state WHERE namespace = ${namespace} FOR UPDATE
      `
      const fallbackId = rows[0]?.fallbackSchemaId
      if (!fallbackId)
        return false
      // Clear the pointer before archiving. FK RESTRICT then prevents future
      // accidental deletion of schemas that still own derivative records.
      await transaction`UPDATE embedding_schema_state SET fallback_schema_id = NULL, revision = revision + 1, updated_at = NOW() WHERE namespace = ${namespace}`
      await transaction`UPDATE embedding_schemas SET status = 'archived', updated_at = NOW() WHERE id = ${fallbackId}`
      await transaction`UPDATE memory_jobs SET status = 'cancelled', updated_at = NOW() WHERE status = 'pending' AND job_type = 'build_embedding' AND payload->>'schemaId' = ${fallbackId}`
      await recordChange(transaction, 'embedding_schema', fallbackId, 'archive_fallback', null, { namespace }, 'user')
      return true
    }))
  }

  async function putEmbedding(memoryId: string, schemaId: string, embedding: number[]): Promise<void> {
    await withDatabase(async (sql) => {
      const schemas = await sql<{ dimensions: number, namespace: string }[]>`SELECT dimensions, namespace FROM embedding_schemas WHERE id = ${schemaId}`
      const schema = schemas[0]
      if (!schema || schema.dimensions !== embedding.length)
        throw new Error('Embedding dimensions do not match schema')
      await sql`
        INSERT INTO memory_embeddings (memory_id, schema_id, vector, build_status)
        VALUES (${memoryId}, ${schemaId}, ${vectorLiteral(embedding)}::vector, 'ready')
        ON CONFLICT (memory_id, schema_id) DO UPDATE SET vector = EXCLUDED.vector, build_status = 'ready', last_error = NULL, updated_at = NOW()
      `
      await sql`UPDATE memory_jobs SET status = 'succeeded', lease_owner = NULL, lease_until = NULL, updated_at = NOW() WHERE job_type = 'build_embedding' AND payload->>'memoryId' = ${memoryId} AND payload->>'schemaId' = ${schemaId}`
    })
  }

  async function listJobs(namespace: string, status = 'pending') {
    return await withDatabase(sql => sql`
      SELECT j.id, j.job_key AS "jobKey", j.job_type AS "jobType", j.payload, j.status, j.attempts,
        j.run_after::TEXT AS "runAfter", j.last_error AS "lastError", j.created_at::TEXT AS "createdAt",
        s.id AS "schemaId", s.provider, s.model, s.dimensions,
        CASE WHEN m.id IS NULL THEN NULL ELSE concat_ws(E'\n', m.kind, m.fact_key, m.polarity, m.value_text) END AS "inputText"
      FROM memory_jobs j
      LEFT JOIN embedding_schemas s ON s.id = j.payload->>'schemaId'
      LEFT JOIN canonical_memories m ON m.id = j.payload->>'memoryId'
      WHERE j.namespace = ${namespace} AND (${status} = 'all' OR j.status = ${status})
      ORDER BY j.created_at LIMIT 100
    `)
  }

  async function claimEmbeddingJobs(namespace: string, owner: string, options: {
    limit?: number
    model?: string
    provider?: string
  } = {}) {
    const model = options.model?.trim() || null
    const provider = options.provider?.trim() || null
    return await withDatabase(sql => sql.begin(async transaction => transaction`
      WITH selected AS (
        SELECT j.id FROM memory_jobs j
        JOIN embedding_schemas s ON s.id = j.payload->>'schemaId'
        WHERE j.namespace = ${namespace} AND j.job_type = 'build_embedding'
          AND j.run_after <= NOW()
          AND (j.status = 'pending' OR (j.status = 'running' AND j.lease_until < NOW()))
          AND (${provider}::TEXT IS NULL OR s.provider = ${provider})
          AND (${model}::TEXT IS NULL OR s.model = ${model})
        ORDER BY j.run_after, j.created_at
        FOR UPDATE OF j SKIP LOCKED LIMIT ${bounded(options.limit ?? 8, 1, 32)}
      ), claimed AS (
        UPDATE memory_jobs j SET status = 'running', attempts = attempts + 1,
          lease_owner = ${owner}, lease_until = NOW() + INTERVAL '60 seconds', updated_at = NOW()
        FROM selected WHERE j.id = selected.id RETURNING j.*
      )
      SELECT c.id, c.job_key AS "jobKey", c.job_type AS "jobType", c.payload, c.status, c.attempts,
        s.id AS "schemaId", s.provider, s.model, s.dimensions,
        concat_ws(E'\n', m.kind, m.fact_key, m.polarity, m.value_text) AS "inputText"
      FROM claimed c
      JOIN embedding_schemas s ON s.id = c.payload->>'schemaId'
      JOIN canonical_memories m ON m.id = c.payload->>'memoryId'
    `))
  }

  async function failJob(jobId: string, owner: string, error: string): Promise<void> {
    await withDatabase(async (sql) => {
      const rows = await sql`
        UPDATE memory_jobs SET
          status = CASE WHEN attempts >= CASE WHEN job_type = 'scan_conflict_batch' THEN 3 ELSE 5 END THEN 'failed' ELSE 'pending' END,
          run_after = NOW() + LEAST(60, POWER(2, attempts)) * INTERVAL '1 second',
          lease_owner = NULL, lease_until = NULL, last_error = ${error.slice(0, 2000)}, updated_at = NOW()
        WHERE id = ${jobId} AND status = 'running' AND lease_owner = ${owner}
        RETURNING id
      `
      if (!rows[0])
        throw new Error('Job lease is no longer owned by this worker')
    })
  }

  async function enqueueConflictScan(namespace: string): Promise<{ jobId: string }> {
    return await withDatabase(async sql => await sql.begin(async (transaction) => {
      const state = await transaction<{ activeSchemaId?: string }[]>`
        SELECT active_schema_id AS "activeSchemaId" FROM embedding_schema_state WHERE namespace = ${namespace}
      `
      const schemaId = state[0]?.activeSchemaId
      if (!schemaId)
        throw new Error('Conflict scan requires an active embedding schema')
      const memories = await transaction<Array<{ id: string, revision: number }>>`
        SELECT m.id, m.revision FROM canonical_memories m
        JOIN memory_embeddings e ON e.memory_id = m.id AND e.schema_id = ${schemaId} AND e.build_status = 'ready'
        WHERE m.namespace = ${namespace} AND m.status = 'active' AND m.confidence > 0
        ORDER BY m.id
      `
      if (memories.length < 2)
        throw new Error('Conflict scan requires at least two active vector memories')
      const policyVersion = 'conflict-scan-v1'
      const snapshotHash = hash(memories.map(memory => `${memory.id}:${memory.revision}`).join('\u001F'))
      const jobKey = `scan-conflict:${namespace}:${schemaId}:${policyVersion}:${snapshotHash}`
      const jobId = stableId('job', jobKey)
      const memoryIds = memories.map(memory => memory.id)
      const payload: ConflictScanPayload = {
        attemptedIds: [],
        batches: [],
        currentBatchIds: [],
        memoryIds,
        pendingIds: memoryIds,
        policyVersion,
        schemaId,
      }
      await enqueueJob(transaction, namespace, jobKey, 'scan_conflict_batch', payload)
      return { jobId }
    }))
  }

  async function claimConflictScanJobs(namespace: string, owner: string, limit = 1) {
    return await withDatabase(async sql => await sql.begin(async (transaction) => {
      const claimed = await transaction<Array<Record<string, unknown> & { id: string, payload: unknown }>>`
        WITH selected AS (
          SELECT id FROM memory_jobs
          WHERE namespace = ${namespace} AND job_type = 'scan_conflict_batch' AND run_after <= NOW()
            AND (status = 'pending' OR (status = 'running' AND lease_until < NOW()))
          ORDER BY run_after, created_at FOR UPDATE SKIP LOCKED LIMIT ${bounded(limit, 1, 4)}
        )
        UPDATE memory_jobs j SET status = 'running', attempts = attempts + 1,
          lease_owner = ${owner}, lease_until = NOW() + INTERVAL '90 seconds', updated_at = NOW()
        FROM selected WHERE j.id = selected.id RETURNING j.*
      `
      const jobs = []
      for (const job of claimed) {
        const payload = conflictScanPayload(job.payload)
        const seedId = nextConflictSeed(payload)
        const rows = seedId
          ? await transaction<{ title: string }[]>`SELECT title FROM canonical_memories WHERE id = ${seedId} AND namespace = ${namespace}`
          : []
        jobs.push({ ...job, seedId, seedTitle: rows[0]?.title ?? '' })
      }
      return jobs
    }))
  }

  async function prepareConflictBatch(namespace: string, jobId: string, owner: string, seedEmbedding: number[]) {
    return await withDatabase(async sql => await sql.begin(async (transaction) => {
      const jobs = await transaction<Array<{ lease_owner?: string, payload: unknown, status: string }>>`
        SELECT status, lease_owner, payload FROM memory_jobs
        WHERE id = ${jobId} AND namespace = ${namespace} AND job_type = 'scan_conflict_batch' FOR UPDATE
      `
      const job = jobs[0]
      if (!job || job.status !== 'running' || job.lease_owner !== owner)
        throw new Error('Conflict scan job lease is no longer owned by this worker')
      const payload = conflictScanPayload(job.payload)
      const seedId = nextConflictSeed(payload)
      if (!seedId)
        return { members: [] }
      let batchIds = payload.currentBatchIds
      if (batchIds.length === 0) {
        const schemas = await transaction<{ dimensions: number }[]>`SELECT dimensions FROM embedding_schemas WHERE id = ${payload.schemaId}`
        if (!schemas[0] || schemas[0].dimensions !== seedEmbedding.length)
          throw new Error('Conflict seed embedding dimensions do not match the scan schema')
        const neighbors = await transaction<{ id: string }[]>`
          SELECT m.id FROM canonical_memories m
          JOIN memory_embeddings e ON e.memory_id = m.id AND e.schema_id = ${payload.schemaId} AND e.build_status = 'ready'
          WHERE m.namespace = ${namespace} AND m.id = ANY(${payload.memoryIds}) AND m.id <> ${seedId}
          ORDER BY 1 - (e.vector <=> ${vectorLiteral(seedEmbedding)}::vector) DESC, m.id LIMIT 3
        `
        batchIds = [seedId, ...neighbors.map(memory => memory.id)]
        if (batchIds.length < 2)
          throw new Error('Conflict scan seed has no eligible neighbor in the snapshot')
        payload.currentBatchIds = batchIds
        await transaction`UPDATE memory_jobs SET payload = ${transaction.json(toJsonValue(payload))}, lease_until = NOW() + INTERVAL '90 seconds', updated_at = NOW() WHERE id = ${jobId}`
      }
      const rows = await transaction<Array<{
        factKey: null | string
        id: string
        polarity: null | Polarity
        title: string
        validFrom: null | string
        validUntil: null | string
        value: string
      }>>`
        SELECT id, title, value_text AS value, polarity, fact_key AS "factKey",
          valid_from::TEXT AS "validFrom", valid_until::TEXT AS "validUntil"
        FROM canonical_memories WHERE namespace = ${namespace} AND id = ANY(${batchIds})
      `
      const byId = new Map(rows.map(row => [row.id, row]))
      return { members: batchIds.map(id => byId.get(id)).filter(item => item !== undefined) }
    }))
  }

  async function applyConflictBatch(namespace: string, jobId: string, owner: string, pairs: ConflictBatchPair[]) {
    return await withDatabase(async sql => await sql.begin(async (transaction) => {
      const jobs = await transaction<Array<{ lease_owner?: string, payload: unknown, status: string }>>`
        SELECT status, lease_owner, payload FROM memory_jobs
        WHERE id = ${jobId} AND namespace = ${namespace} AND job_type = 'scan_conflict_batch' FOR UPDATE
      `
      const job = jobs[0]
      if (!job || job.status !== 'running' || job.lease_owner !== owner)
        throw new Error('Conflict scan job lease is no longer owned by this worker')
      const payload = conflictScanPayload(job.payload)
      const seedId = nextConflictSeed(payload)
      if (!seedId || payload.currentBatchIds.length < 2)
        throw new Error('Conflict scan has no prepared batch')
      const validated = validateConflictBatch(payload.currentBatchIds, pairs)
      for (const pair of validated.actionablePairs) {
        const conflictId = stableId('conflict', pair.leftId, pair.rightId)
        const inserted = await transaction`
          INSERT INTO memory_conflicts (
            id, namespace, left_memory_id, right_memory_id, detection_method, status, classification
          ) VALUES (${conflictId}, ${namespace}, ${pair.leftId}, ${pair.rightId},
            ${`batch_llm:${payload.policyVersion}`}, 'awaiting_user', ${pair.classification})
          ON CONFLICT DO NOTHING RETURNING *
        `
        if (inserted[0])
          await recordChange(transaction, 'conflict', conflictId, 'batch_detect', null, inserted[0], 'conflict-scan-worker')
      }
      const removable = new Set(validated.removableIds)
      payload.pendingIds = payload.pendingIds.filter(id => !removable.has(id))
      payload.attemptedIds = [...new Set([...payload.attemptedIds, seedId])]
      payload.batches.push({
        memberIds: payload.currentBatchIds,
        pairs: validated.validatedPairs,
        seedId,
        validated: true,
      })
      payload.currentBatchIds = []
      const nextSeedId = nextConflictSeed(payload)
      const completed = !nextSeedId
      const nextRows = nextSeedId
        ? await transaction<{ title: string }[]>`SELECT title FROM canonical_memories WHERE id = ${nextSeedId} AND namespace = ${namespace}`
        : []
      await transaction`
        UPDATE memory_jobs SET payload = ${transaction.json(toJsonValue(payload))},
          status = ${completed ? 'succeeded' : 'running'}, lease_owner = ${completed ? null : owner},
          lease_until = CASE WHEN ${completed} THEN NULL ELSE NOW() + INTERVAL '90 seconds' END, updated_at = NOW()
        WHERE id = ${jobId}
      `
      return { completed, nextSeedId, nextSeedTitle: nextRows[0]?.title ?? '' }
    }))
  }

  async function listConflicts(namespace: string) {
    return await withDatabase(sql => sql`
      SELECT c.*, l.title AS left_title, l.value_text AS left_value, r.title AS right_title,
        r.value_text AS right_value, q.value_text AS candidate_value
      FROM memory_conflicts c JOIN canonical_memories l ON l.id = c.left_memory_id
      LEFT JOIN canonical_memories r ON r.id = c.right_memory_id
      LEFT JOIN memory_claims q ON q.id = c.candidate_claim_id
      WHERE c.namespace = ${namespace} ORDER BY c.created_at DESC
    `)
  }

  async function resolveConflict(namespace: string, conflictId: string, decision: 'accept_candidate' | 'dismiss' | 'keep_left' | 'keep_right'): Promise<void> {
    await withDatabase(async sql => await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
      const conflicts = await transaction<Array<Record<string, unknown> & {
        candidate_claim_id?: string
        id: string
        left_memory_id: string
        right_memory_id?: string
        status: string
      }>>`SELECT * FROM memory_conflicts WHERE id = ${conflictId} AND namespace = ${namespace} FOR UPDATE`
      const conflict = conflicts[0]
      if (!conflict)
        throw new Error('Conflict not found')
      if (conflict.status === 'resolved' || conflict.status === 'dismissed')
        return
      const transactionId = randomUUID()

      if (decision === 'dismiss') {
        const after = (await transaction`UPDATE memory_conflicts SET status = 'dismissed', resolution = 'dismiss', revision = revision + 1, resolved_at = NOW() WHERE id = ${conflictId} RETURNING *`)[0]
        await recordChange(transaction, 'conflict', conflictId, 'dismiss', conflict, after, 'user', transactionId)
        return
      }

      if (conflict.candidate_claim_id) {
        const claims = await transaction<ClaimRow[]>`SELECT c.*, e.source_type FROM memory_claims c JOIN memory_evidence e ON e.id = c.evidence_id WHERE c.id = ${conflict.candidate_claim_id} FOR UPDATE OF c`
        const claim = claims[0]
        if (!claim)
          throw new Error('Candidate claim not found')
        if (decision === 'keep_left') {
          const claimAfter = (await transaction`UPDATE memory_claims SET status = 'rejected', promoted_memory_id = NULL, revision = revision + 1, updated_at = NOW() WHERE id = ${claim.id} RETURNING *`)[0]
          const conflictAfter = (await transaction`UPDATE memory_conflicts SET status = 'resolved', resolution = 'keep_left', revision = revision + 1, resolved_at = NOW() WHERE id = ${conflictId} RETURNING *`)[0]
          await recordChange(transaction, 'claim', claim.id, 'reject_conflict', claim, claimAfter, 'user', transactionId)
          await recordChange(transaction, 'conflict', conflictId, 'resolve', conflict, conflictAfter, 'user', transactionId)
          return
        }
        if (decision !== 'accept_candidate')
          throw new Error('This conflict requires keep_left or accept_candidate')

        const leftBefore = (await transaction`SELECT * FROM canonical_memories WHERE id = ${conflict.left_memory_id} FOR UPDATE`)[0]
        const leftAfter = (await transaction`UPDATE canonical_memories SET status = 'superseded', revision = revision + 1, updated_at = NOW() WHERE id = ${conflict.left_memory_id} RETURNING *`)[0]
        const memoryId = stableId('memory', claim.id)
        await transaction`
          INSERT INTO canonical_memories (
            id, namespace, title, kind, subject, predicate, scope, fact_key, polarity,
            value_text, importance, confidence, status, valid_from, valid_until, created_by, supersedes_id
          ) VALUES (${memoryId}, ${namespace}, ${claim.evidence_quote.slice(0, 120)}, ${claim.kind}, ${claim.subject},
            ${claim.predicate}, ${claim.scope}, ${claim.fact_key}, ${claim.polarity}, ${claim.value_text},
            ${initialImportance(claim.kind, claim.assertion_mode, claim.predicate)}, NULL, 'active', ${claim.valid_from ?? null},
            ${claim.valid_until ?? null}, 'user-conflict-resolution', ${conflict.left_memory_id})
          ON CONFLICT (id) DO NOTHING
        `
        await linkClaim(transaction, memoryId, claim)
        await recalculateConfidence(transaction, memoryId)
        const claimAfter = (await transaction`UPDATE memory_claims SET status = 'promoted', promoted_memory_id = ${memoryId}, revision = revision + 1, updated_at = NOW() WHERE id = ${claim.id} RETURNING *`)[0]
        const conflictAfter = (await transaction`UPDATE memory_conflicts SET status = 'resolved', resolution = 'accept_candidate', revision = revision + 1, resolved_at = NOW() WHERE id = ${conflictId} RETURNING *`)[0]
        await enqueueEmbeddingJobs(transaction, namespace, memoryId, 1)
        await recordChange(transaction, 'memory', conflict.left_memory_id, 'supersede_conflict', leftBefore, leftAfter, 'user', transactionId)
        await recordChange(transaction, 'memory', memoryId, 'create_conflict_winner', null, { id: memoryId, revision: 1 }, 'user', transactionId)
        await recordChange(transaction, 'claim', claim.id, 'promote_conflict', claim, claimAfter, 'user', transactionId)
        await recordChange(transaction, 'conflict', conflictId, 'resolve', conflict, conflictAfter, 'user', transactionId)
        return
      }

      const losingId = decision === 'keep_right' ? conflict.left_memory_id : conflict.right_memory_id
      if (!losingId || !['keep_left', 'keep_right'].includes(decision))
        throw new Error('Memory conflict requires keep_left or keep_right')
      const losingBefore = (await transaction`SELECT * FROM canonical_memories WHERE id = ${losingId} FOR UPDATE`)[0]
      const losingAfter = (await transaction`UPDATE canonical_memories SET status = 'superseded', revision = revision + 1, updated_at = NOW() WHERE id = ${losingId} RETURNING *`)[0]
      const conflictAfter = (await transaction`UPDATE memory_conflicts SET status = 'resolved', resolution = ${decision}, revision = revision + 1, resolved_at = NOW() WHERE id = ${conflictId} RETURNING *`)[0]
      await recordChange(transaction, 'memory', losingId, 'supersede_conflict', losingBefore, losingAfter, 'user', transactionId)
      await recordChange(transaction, 'conflict', conflictId, 'resolve', conflict, conflictAfter, 'user', transactionId)
    }))
  }

  async function listChanges(namespace: string) {
    return await withDatabase(sql => sql`
      SELECT c.* FROM memory_changes c
      WHERE c.entity_id IN (
        SELECT id FROM canonical_memories WHERE namespace = ${namespace}
        UNION SELECT id FROM memory_instructions WHERE namespace = ${namespace}
        UNION SELECT id FROM memory_claims WHERE namespace = ${namespace}
        UNION SELECT id FROM memory_evidence WHERE namespace = ${namespace}
      ) OR (c.entity_type = 'embedding_schema_state' AND c.entity_id = ${namespace})
        OR c.before_state->>'namespace' = ${namespace} OR c.after_state->>'namespace' = ${namespace}
      ORDER BY c.created_at DESC LIMIT 200
    `)
  }

  async function rollbackTransaction(namespace: string, transactionId: string): Promise<void> {
    await withDatabase(async sql => await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
      const changes = await transaction<Array<Record<string, unknown> & {
        after_state?: Record<string, unknown>
        before_state?: Record<string, unknown>
        entity_id: string
        entity_revision_after?: null | number
        entity_type: string
        id: string
        rolled_back_by?: string
      }>>`
        SELECT * FROM memory_changes WHERE transaction_id = ${transactionId}
        ORDER BY created_at DESC, id DESC FOR UPDATE
      `
      if (changes.length === 0)
        throw new Error('Audit transaction not found')
      if (changes.some(change => change.rolled_back_by))
        return

      const lockOrder = [...changes].sort((left, right) => `${left.entity_type}:${left.entity_id}`.localeCompare(`${right.entity_type}:${right.entity_id}`))
      for (const change of lockOrder)
        await lockRollbackEntity(transaction, change.entity_type, change.entity_id)

      for (const change of changes) {
        const expectedRevision = change.entity_revision_after
        if (expectedRevision !== undefined && expectedRevision !== null) {
          const currentRevision = await currentEntityRevision(transaction, change.entity_type, change.entity_id)
          if (currentRevision !== expectedRevision)
            throw new Error(`Rollback rejected because ${change.entity_type}:${change.entity_id} has a newer revision`)
        }
      }

      const rollbackTransactionId = randomUUID()
      for (const change of changes) {
        const beforeRollback = await snapshotEntity(transaction, change.entity_type, change.entity_id)
        await applyInverseState(transaction, change.entity_type, change.entity_id, objectState(change.before_state))
        const afterRollback = await snapshotEntity(transaction, change.entity_type, change.entity_id)
        const rollbackChangeId = await recordChange(
          transaction,
          change.entity_type,
          change.entity_id,
          `rollback:${change.id}`,
          beforeRollback,
          afterRollback,
          'user',
          rollbackTransactionId,
        )
        await transaction`UPDATE memory_changes SET rolled_back_by = ${rollbackChangeId} WHERE id = ${change.id}`
      }
    }))
  }

  return {
    activateEmbeddingSchema,
    applyConflictBatch,
    archiveEvidence,
    archiveFallbackSchema,
    claimConflictScanJobs,
    claimEmbeddingJobs,
    createClaim,
    createEmbeddingSchema,
    enqueueConflictScan,
    failJob,
    feedback,
    health,
    ingestEvidence,
    instructions,
    list,
    listChanges,
    listClaims,
    listConflicts,
    listEmbeddingSchemas,
    listEvidence,
    listJobs,
    prepareConflictBatch,
    promoteClaim,
    putEmbedding,
    recall,
    remove: archive,
    resolveConflict,
    rollbackTransaction,
    upsert,
    validateClaim,
  }
}

async function applyInverseState(sql: postgres.ISql, entityType: string, entityId: string, state: null | Record<string, unknown>): Promise<void> {
  if (entityType === 'memory') {
    if (!state) {
      await sql`UPDATE canonical_memories SET status = 'archived', revision = revision + 1, updated_at = NOW() WHERE id = ${entityId}`
      return
    }
    await sql`
      UPDATE canonical_memories SET title = ${stringFrom(state.title)}, value_text = ${stringFrom(state.value_text)},
        status = ${stringFrom(state.status)}, confidence = ${numberOrNull(state.confidence)},
        importance = ${numberFrom(state.importance)}, valid_from = ${stringOrNull(state.valid_from)},
        valid_until = ${stringOrNull(state.valid_until)}, supersedes_id = ${stringOrNull(state.supersedes_id)},
        revision = revision + 1, updated_at = NOW() WHERE id = ${entityId}
    `
    return
  }
  if (entityType === 'claim') {
    if (!state)
      throw new Error('Created claims are immutable evidence and cannot be removed by rollback')
    await sql`UPDATE memory_claims SET status = ${stringFrom(state.status)}, promoted_memory_id = ${stringOrNull(state.promoted_memory_id)}, revision = revision + 1, updated_at = NOW() WHERE id = ${entityId}`
    return
  }
  if (entityType === 'conflict') {
    if (!state)
      throw new Error('Created conflicts must be dismissed rather than deleted')
    await sql`UPDATE memory_conflicts SET status = ${stringFrom(state.status)}, resolution = ${stringOrNull(state.resolution)}, resolved_at = ${stringOrNull(state.resolved_at)}, revision = revision + 1 WHERE id = ${entityId}`
    return
  }
  if (entityType === 'instruction') {
    if (!state) {
      await sql`UPDATE memory_instructions SET status = 'archived', revision = revision + 1, updated_at = NOW() WHERE id = ${entityId}`
      return
    }
    await sql`UPDATE memory_instructions SET title = ${stringFrom(state.title)}, content = ${stringFrom(state.content)}, status = ${stringFrom(state.status)}, priority = ${numberFrom(state.priority)}, revision = revision + 1, updated_at = NOW() WHERE id = ${entityId}`
    return
  }
  if (entityType === 'feedback') {
    if (!state)
      await sql`UPDATE memory_feedback SET reverted_at = NOW() WHERE id = ${entityId}`
    else
      await sql`UPDATE memory_feedback SET reverted_at = ${stringOrNull(state.reverted_at)} WHERE id = ${entityId}`
    const rows = await sql<{ feedback: string, memoryId: string, source: string }[]>`
      SELECT memory_id AS "memoryId", feedback, source FROM memory_feedback WHERE id = ${entityId}
    `
    if (rows[0]) {
      if (!state && rows[0].feedback === 'wrong' && rows[0].source === 'user') {
        const remaining = await sql<{ found: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM memory_feedback WHERE memory_id = ${rows[0].memoryId}
            AND feedback = 'wrong' AND source = 'user' AND reverted_at IS NULL) AS found
        `
        if (!remaining[0]?.found) {
          await sql`UPDATE memory_evidence_links SET valid = TRUE WHERE memory_id = ${rows[0].memoryId} AND relation = 'supports'`
          await recalculateConfidence(sql, rows[0].memoryId)
        }
      }
      await recalculateUtility(sql, rows[0].memoryId)
    }
    return
  }
  throw new Error(`Rollback is not supported for ${entityType}`)
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : undefined
}

function bounded(value: number, min: number, max: number): number {
  const parsed = Number.isFinite(value) ? Math.trunc(value) : min
  return Math.min(max, Math.max(min, parsed))
}

function canonicalKind(kind: MemoryKind): 'fact' | 'preference' | 'summary' {
  return kind === 'preference' || kind === 'summary' ? kind : 'fact'
}

function canonicalStatus(status: MemoryStatus): Exclude<MemoryStatus, 'stale'> {
  return status === 'stale' ? 'quarantined' : status
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))]
}

function conflictScanPayload(value: unknown): ConflictScanPayload {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Conflict scan job payload is invalid')
  const record = parsed as Record<string, unknown>
  const stringArray = (key: string): string[] => {
    const field = record[key]
    if (!Array.isArray(field) || field.some(item => typeof item !== 'string'))
      throw new Error(`Conflict scan payload ${key} is invalid`)
    return field as string[]
  }
  return {
    attemptedIds: stringArray('attemptedIds'),
    batches: Array.isArray(record.batches) ? record.batches.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>> : [],
    currentBatchIds: stringArray('currentBatchIds'),
    memoryIds: stringArray('memoryIds'),
    pendingIds: stringArray('pendingIds'),
    policyVersion: stringFrom(record.policyVersion),
    schemaId: stringFrom(record.schemaId),
  }
}

async function currentEntityRevision(sql: postgres.ISql, entityType: string, entityId: string): Promise<number | undefined> {
  const snapshot = await snapshotEntity(sql, entityType, entityId)
  return revisionFrom(snapshot) ?? undefined
}

async function enqueueEmbedding(sql: postgres.ISql, namespace: string, memoryId: string, schemaId: string, revision: number): Promise<void> {
  await sql`
    INSERT INTO memory_embeddings (memory_id, schema_id, build_status)
    VALUES (${memoryId}, ${schemaId}, 'pending')
    ON CONFLICT (memory_id, schema_id) DO UPDATE SET build_status = 'pending', vector = NULL, last_error = NULL, updated_at = NOW()
  `
  await enqueueJob(sql, namespace, embeddingJobKey(memoryId, schemaId, revision), 'build_embedding', { memoryId, revision, schemaId })
}

async function enqueueEmbeddingJobs(sql: postgres.ISql, namespace: string, memoryId: string, revision: number): Promise<void> {
  const eligible = await sql<{ found: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM canonical_memories WHERE id = ${memoryId} AND namespace = ${namespace}
      AND status IN ('active','disputed') AND kind IN ('fact','preference','summary')) AS found
  `
  if (!eligible[0]?.found)
    return
  const schemas = await sql<{ id: string }[]>`
    SELECT DISTINCT s.id FROM embedding_schemas s
    LEFT JOIN embedding_schema_state state ON state.namespace = s.namespace
    WHERE s.namespace = ${namespace} AND s.status <> 'archived'
      AND (s.status = 'building' OR s.id = state.active_schema_id OR s.id = state.fallback_schema_id)
  `
  for (const schema of schemas)
    await enqueueEmbedding(sql, namespace, memoryId, schema.id, revision)
}

async function enqueueJob(sql: postgres.ISql, namespace: string, jobKey: string, jobType: string, payload: unknown): Promise<void> {
  await sql`
    INSERT INTO memory_jobs (id, namespace, job_key, job_type, payload, status)
    VALUES (${stableId('job', jobKey)}, ${namespace}, ${jobKey}, ${jobType}, ${sql.json(toJsonValue(payload))}, 'pending')
    ON CONFLICT (job_key) DO NOTHING
  `
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function initialImportance(kind: string, assertionMode: string, predicate: string): number {
  const base = kind === 'preference'
    ? (assertionMode === 'explicit' ? 0.65 : 0.45)
    : 0.6
  // PRD v2 §6.3: importance is clamped by the fixed predicate policy so the
  // extractor hint can never push identity below/above the code-fixed bounds.
  const policy = importancePolicyFor(predicate)
  return bounded(base, policy.min ?? 0, policy.max ?? 1)
}

function instructionStatus(status: MemoryStatus): 'active' | 'archived' | 'superseded' {
  return status === 'archived' || status === 'superseded' ? status : 'active'
}

async function linkClaim(sql: postgres.ISql, memoryId: string, claim: ClaimRow): Promise<void> {
  const weight = supportWeight(claim.source_type, claim.assertion_mode)
  await sql`
    INSERT INTO memory_evidence_links (id, memory_id, claim_id, evidence_id, relation, support_weight)
    VALUES (${stableId('link', memoryId, claim.id, claim.evidence_id)}, ${memoryId}, ${claim.id}, ${claim.evidence_id}, 'supports', ${weight})
    ON CONFLICT DO NOTHING
  `
}

async function lockRollbackEntity(sql: postgres.ISql, entityType: string, entityId: string): Promise<void> {
  const table = rollbackTable(entityType)
  if (!table)
    throw new Error(`Rollback is not supported for ${entityType}`)
  await sql.unsafe(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [entityId])
}

function memoryProjection(sql: postgres.Sql, namespaces: string[], status: string, search: string) {
  return sql`
    SELECT id AS "memoryId", namespace, title, value_text AS content, kind, tags,
      importance, confidence, status, NULL::TEXT AS "sourceSessionId", ARRAY[]::TEXT[] AS "sourceMessageIds",
      ''::TEXT AS "embeddingProvider", ''::TEXT AS "embeddingModel", supersedes_id AS "supersedesId",
      'global'::TEXT AS "instructionScope", 0 AS "instructionPriority", NULL::TEXT AS "instructionRuleKey",
      valid_from::TEXT AS "effectiveFrom", valid_until::TEXT AS "effectiveUntil", created_by AS "createdBy",
      revision, created_at::TEXT AS "createdAt", updated_at::TEXT AS "updatedAt"
    FROM canonical_memories WHERE namespace = ANY(${namespaces})
      AND (${status} = 'all' OR status = ${status})
      AND (${search} = '' OR title ILIKE ${`%${search}%`} OR value_text ILIKE ${`%${search}%`} OR array_to_string(tags, ' ') ILIKE ${`%${search}%`})
    UNION ALL
    SELECT id, namespace, title, content, 'instruction', tags, 1::REAL, 1::REAL, status,
      NULL, ARRAY[]::TEXT[], '', '', NULL, scope, priority, rule_key,
      valid_from::TEXT, valid_until::TEXT, created_by, revision, created_at::TEXT, updated_at::TEXT
    FROM memory_instructions WHERE namespace = ANY(${namespaces})
      AND (${status} = 'all' OR status = ${status})
      AND (${search} = '' OR title ILIKE ${`%${search}%`} OR content ILIKE ${`%${search}%`} OR array_to_string(tags, ' ') ILIKE ${`%${search}%`})
  `
}

function nextConflictSeed(payload: ConflictScanPayload): string | undefined {
  const attempted = new Set(payload.attemptedIds)
  return payload.pendingIds.find(id => !attempted.has(id))
}

function normalizedScore(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
}

function numberFrom(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed))
    throw new Error('Rollback state is missing a required number')
  return parsed
}

function numberOrNull(value: unknown): null | number {
  return value === null || value === undefined ? null : numberFrom(value)
}

function objectState(value: unknown): null | Record<string, unknown> {
  if (value === null || value === undefined)
    return null
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Rollback state is not a JSON object')
  return parsed as Record<string, unknown>
}

async function oneForUpdate(sql: postgres.ISql, table: 'memory_claims', namespace: string, id: string): Promise<Record<string, unknown>> {
  const rows = await sql.unsafe(`SELECT * FROM ${table} WHERE namespace = $1 AND id = $2 FOR UPDATE`, [namespace, id])
  if (!rows[0])
    throw new Error('Entity not found')
  return rows[0] as Record<string, unknown>
}

async function putCompatibilityEmbedding(sql: postgres.ISql, memory: PgvectorMemoryRecord, revision: number): Promise<void> {
  const embedding = memory.embedding
  if (!embedding)
    return
  const version = hash(`${memory.embeddingProvider}\u001F${memory.embeddingModel}\u001F${embedding.length}\u001Fcanonical-v1`).slice(0, 16)
  const schemaId = stableId('schema', memory.namespace, version)
  await sql`
    INSERT INTO embedding_schemas (
      id, namespace, schema_version, provider, model, dimensions, distance_metric,
      input_template_version, status, index_status
    ) VALUES (${schemaId}, ${memory.namespace}, ${version}, ${memory.embeddingProvider}, ${memory.embeddingModel},
      ${embedding.length}, 'cosine', 'canonical-v1', 'ready', 'ready')
    ON CONFLICT (namespace, schema_version) DO NOTHING
  `
  await sql`
    INSERT INTO embedding_schema_state (namespace, active_schema_id)
    VALUES (${memory.namespace}, ${schemaId}) ON CONFLICT (namespace) DO NOTHING
  `
  await sql`
    INSERT INTO memory_embeddings (memory_id, schema_id, vector, build_status)
    VALUES (${memory.memoryId}, ${schemaId}, ${vectorLiteral(embedding)}::vector, 'ready')
    ON CONFLICT (memory_id, schema_id) DO UPDATE SET vector = EXCLUDED.vector, build_status = 'ready', last_error = NULL, updated_at = NOW()
  `
  await sql`UPDATE memory_jobs SET status = 'succeeded', updated_at = NOW() WHERE job_key = ${embeddingJobKey(memory.memoryId, schemaId, revision)}`
}

async function recalculateConfidence(sql: postgres.ISql, memoryId: string): Promise<void> {
  // Computed empty support is 0. NULL is reserved for rows whose aggregation has
  // not run yet (for example, while a migration is still in progress).
  await sql`
    UPDATE canonical_memories m SET confidence = COALESCE((
      SELECT MAX(l.support_weight) FROM memory_evidence_links l
      WHERE l.memory_id = m.id AND l.relation = 'supports' AND l.valid
    ), 0), updated_at = NOW() WHERE m.id = ${memoryId}
  `
}

async function recalculateUtility(sql: postgres.ISql, memoryId: string): Promise<void> {
  await sql`
    UPDATE canonical_memories m SET utility = (
      SELECT (COUNT(*) FILTER (WHERE feedback = 'useful') + 1.0)
        / (COUNT(*) FILTER (WHERE feedback IN ('useful','irrelevant')) + 2.0)
      FROM memory_feedback WHERE memory_id = m.id AND reverted_at IS NULL
    ), updated_at = NOW() WHERE m.id = ${memoryId}
  `
}

async function recordChange(sql: postgres.ISql, entityType: string, entityId: string, operation: string, before: unknown, after: unknown, actor: string, transactionId = randomUUID()): Promise<string> {
  const changeId = randomUUID()
  await sql`
    INSERT INTO memory_changes (
      id, transaction_id, entity_type, entity_id, entity_revision_before, entity_revision_after,
      operation, before_state, after_state, inverse_operation, actor
    ) VALUES (${changeId}, ${transactionId}, ${entityType}, ${entityId}, ${revisionFrom(before)}, ${revisionFrom(after)}, ${operation},
      ${before === null ? null : sql.json(toJsonValue(before))}, ${after === null ? null : sql.json(toJsonValue(after))},
      ${sql.json(toJsonValue({ operation: before === null ? 'archive' : 'restore', state: before }))}, ${actor})
  `
  return changeId
}

function revisionFrom(value: unknown): null | number {
  if (!value || typeof value !== 'object' || !('revision' in value))
    return null
  return typeof value.revision === 'number' ? value.revision : Number(value.revision) || null
}

function rollbackTable(entityType: string): string | undefined {
  if (entityType === 'memory')
    return 'canonical_memories'
  if (entityType === 'claim')
    return 'memory_claims'
  if (entityType === 'conflict')
    return 'memory_conflicts'
  if (entityType === 'instruction')
    return 'memory_instructions'
  if (entityType === 'feedback')
    return 'memory_feedback'
  return undefined
}

async function snapshotEntity(sql: postgres.ISql, entityType: string, entityId: string): Promise<null | Record<string, unknown>> {
  const table = rollbackTable(entityType)
  if (!table)
    throw new Error(`Rollback is not supported for ${entityType}`)
  const rows = await sql.unsafe(`SELECT * FROM ${table} WHERE id = $1`, [entityId])
  return rows[0] ? { ...rows[0] } : null
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${hash(parts.join('\u001F')).slice(0, 32)}`
}

function stringFrom(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('Rollback state is missing a required string')
  return value
}

function stringOrNull(value: unknown): null | string {
  if (value instanceof Date)
    return value.toISOString()
  return typeof value === 'string' ? value : null
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue
}

function vectorLiteral(embedding: number[]): string {
  if (embedding.length === 0 || !embedding.every(Number.isFinite))
    throw new Error('Embedding must be a non-empty array of finite numbers')
  return `[${embedding.join(',')}]`
}

export type AssertionMode = 'explicit' | 'implicit' | 'none'
export type CanonicalMemoryKind = 'fact' | 'preference' | 'summary'
export type CanonicalMemoryStatus = 'active' | 'archived' | 'disputed' | 'expired' | 'quarantined' | 'stale' | 'superseded'
export interface ClaimInput {
  assertionMode: AssertionMode
  evidenceId: string
  factKey: string
  kind: Exclude<CanonicalMemoryKind, 'summary'>
  namespace: string
  polarity: Polarity
  predicate: string
  quote: string
  quoteEnd: number
  quoteStart: number
  scope: string
  subject: string
  validFrom?: string
  validUntil?: string
  value: string
}
export type ClaimStatus = 'promoted' | 'proposed' | 'quarantined' | 'rejected' | 'validated'
export type ConflictStatus = 'awaiting_user' | 'classified' | 'dismissed' | 'open' | 'resolved'
export interface EmbeddingSchemaInput {
  dimensions: number
  distanceMetric: 'cosine'
  inputTemplateVersion: string
  model: string
  namespace: string
  provider: string
  schemaVersion: string
}
export interface EvidenceInput {
  content: string
  metadata?: Record<string, unknown>
  namespace: string
  observedAt?: string
  sourceId: string
  sourceMessageId?: string
  sourceRole: 'assistant' | 'system' | 'tool' | 'user' | 'vision'
  sourceSessionId?: string
  sourceType: EvidenceSourceType
}
export type EvidenceSourceType = 'assistant_inference' | 'document_text' | 'tool_result' | 'user_assertion' | 'vision_observation'
export type FeedbackValue = 'irrelevant' | 'outdated' | 'useful' | 'wrong'
export type InstructionScope = 'artistry' | 'chat' | 'global' | 'memory' | 'speech' | 'vision'
export type MemoryKind = 'conversation' | 'instruction' | CanonicalMemoryKind

export type MemoryStatus = CanonicalMemoryStatus

export interface PgvectorMemoryListOptions {
  limit: number
  namespaces: string[]
  offset: number
  search?: string
  status?: 'all' | MemoryStatus
}

/** A manual memory command accepted by the desktop management boundary. */
export interface PgvectorMemoryRecord {
  confidence: number
  content: string
  createdBy?: string
  effectiveFrom?: string
  effectiveUntil?: string
  embedding?: number[]
  embeddingModel: string
  embeddingProvider: string
  importance: number
  instructionPriority?: number
  /** Optional conflict group; instructions without a key remain independent. */
  instructionRuleKey?: string
  instructionScope?: InstructionScope
  kind: MemoryKind
  memoryId: string
  namespace: string
  sourceAssistantText?: string
  sourceMessageIds: string[]
  sourceSessionId?: string
  sourceUserText?: string
  status: MemoryStatus
  supersedesId?: string
  tags: string[]
  title: string
}

/** Human-readable projection used by the management UI. */
export interface PgvectorMemoryView extends Omit<PgvectorMemoryRecord, 'confidence' | 'embedding' | 'instructionRuleKey'> {
  confidence: null | number
  createdAt: string
  instructionRuleKey: null | string
  revision: number
  updatedAt: string
}

export interface PgvectorRecallCandidate {
  /** Pure-similarity rank across merged candidates (1-based); missing when the memory was not in the merged set. */
  baselineRank?: number
  filterReason?: 'confidence' | 'duplicate_fact_key' | 'expired' | 'similarity' | 'status'
  /** Post-filter injection rank (1-based); present only when the memory was injected. */
  finalRank?: number
  injected: boolean
  /** Full-text (`ts_rank`) rank within the term's lexical leg (1-based); missing when the memory was not in that term's lexical top-K. */
  lexicalRank?: number
  memoryId: string
  similarity: number
  term: string
  /** Vector-similarity rank within the term (1-based); missing when the memory was found only by the lexical leg. */
  termRank?: number
}

export interface PgvectorRecalledMemory extends PgvectorMemoryView {
  retrievalId: string
  similarity: number
}

export interface PgvectorRecallOptions {
  maxResults: number
  namespace: string
  originalText: string
  queryPolicyVersion?: string
  sessionId?: string
  similarityThreshold: number
  terms: Array<{
    embedding: number[]
    text: string
  }>
  /** Neighbors fetched per retrieval term (default 5); a wider window feeds ranking diagnostics without raising maxResults. */
  topKPerTerm?: number
  /**
   * Escape hatch that disables the lexical (full-text) leg and restores pure
   * vector-similarity ordering. Hybrid vector + lexical reciprocal-rank fusion
   * is the default.
   * @default false
   */
  vectorOnly?: boolean
}

export interface PgvectorRecallResult {
  memories: PgvectorRecalledMemory[]
  trace: {
    candidates: PgvectorRecallCandidate[]
    originalText: string
    queryPolicyVersion?: string
    retrievalId: string
    schemaId?: string
    terms: string[]
  }
}

export type Polarity = 'negative' | 'positive'

export type SchemaStatus = 'archived' | 'building' | 'failed' | 'ready'

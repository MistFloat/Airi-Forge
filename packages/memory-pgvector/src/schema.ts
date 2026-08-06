import type postgres from 'postgres'

/** Applies the authoritative long-term-memory schema and its database-enforced state invariants. */
export async function migrateMemorySchema(sql: postgres.Sql): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS memory_evidence (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('user_assertion','assistant_inference','tool_result','vision_observation','document_text')),
      source_id TEXT NOT NULL,
      source_role TEXT NOT NULL CHECK (source_role IN ('user','assistant','tool','vision','system')),
      source_session_id TEXT,
      source_message_id TEXT,
      content TEXT NOT NULL CHECK (btrim(content) <> ''),
      content_hash TEXT NOT NULL,
      observed_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(namespace, source_type, source_id, content_hash)
    );

    CREATE TABLE IF NOT EXISTS canonical_memories (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      title TEXT NOT NULL CHECK (btrim(title) <> ''),
      kind TEXT NOT NULL CHECK (kind IN ('fact','preference','summary')),
      subject TEXT,
      predicate TEXT,
      scope TEXT,
      fact_key TEXT,
      polarity TEXT CHECK (polarity IN ('positive','negative')),
      value_text TEXT NOT NULL CHECK (btrim(value_text) <> ''),
      tags TEXT[] NOT NULL DEFAULT '{}',
      importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
      confidence REAL CHECK (confidence >= 0 AND confidence <= 1),
      utility REAL NOT NULL DEFAULT 0.5 CHECK (utility >= 0 AND utility <= 1),
      status TEXT NOT NULL CHECK (status IN ('active','quarantined','disputed','superseded','expired','archived','stale')),
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      created_by TEXT NOT NULL,
      supersedes_id TEXT REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until),
      CHECK ((kind = 'summary' AND polarity IS NULL) OR (kind IN ('fact','preference') AND polarity IS NOT NULL)),
      CHECK (kind = 'summary' OR status <> 'stale')
    );

    CREATE TABLE IF NOT EXISTS memory_instructions (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      title TEXT NOT NULL CHECK (btrim(title) <> ''),
      content TEXT NOT NULL CHECK (btrim(content) <> ''),
      scope TEXT NOT NULL CHECK (scope IN ('global','chat','speech','memory','vision','artistry')),
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
      rule_key TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      status TEXT NOT NULL CHECK (status IN ('active','archived','superseded')),
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_by TEXT NOT NULL CHECK (created_by = 'user'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until)
    );

    CREATE TABLE IF NOT EXISTS memory_claims (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      evidence_id TEXT NOT NULL REFERENCES memory_evidence(id) ON DELETE RESTRICT,
      kind TEXT NOT NULL CHECK (kind IN ('fact','preference')),
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      scope TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      polarity TEXT NOT NULL CHECK (polarity IN ('positive','negative')),
      value_text TEXT NOT NULL CHECK (btrim(value_text) <> ''),
      assertion_mode TEXT NOT NULL CHECK (assertion_mode IN ('explicit','implicit','none')),
      evidence_quote TEXT NOT NULL,
      quote_start INTEGER NOT NULL CHECK (quote_start >= 0),
      quote_end INTEGER NOT NULL CHECK (quote_end > quote_start),
      valid_from TIMESTAMPTZ,
      valid_until TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','validated','quarantined','promoted','rejected')),
      promoted_memory_id TEXT REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      schema_version TEXT NOT NULL,
      claim_hash TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from < valid_until),
      CHECK ((status = 'promoted') = (promoted_memory_id IS NOT NULL)),
      UNIQUE(evidence_id, schema_version, claim_hash)
    );

    CREATE TABLE IF NOT EXISTS memory_evidence_links (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      claim_id TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE RESTRICT,
      evidence_id TEXT REFERENCES memory_evidence(id) ON DELETE RESTRICT,
      relation TEXT NOT NULL CHECK (relation IN ('supports','derived_from')),
      support_weight REAL CHECK (support_weight >= 0 AND support_weight <= 1),
      valid BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((relation = 'supports' AND evidence_id IS NOT NULL AND support_weight IS NOT NULL)
          OR (relation = 'derived_from' AND evidence_id IS NULL AND support_weight IS NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_evidence_links_evidence_unique
      ON memory_evidence_links(memory_id, claim_id, evidence_id, relation) WHERE evidence_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_evidence_links_derived_unique
      ON memory_evidence_links(memory_id, claim_id, relation) WHERE evidence_id IS NULL;

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      memory_id TEXT NOT NULL REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      retrieval_id TEXT,
      feedback TEXT NOT NULL CHECK (feedback IN ('useful','irrelevant','outdated','wrong')),
      source TEXT NOT NULL CHECK (source IN ('automatic','user')),
      source_event_id TEXT NOT NULL,
      evidence_quote TEXT,
      reason_code TEXT,
      model_info JSONB,
      reverted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source, source_event_id, memory_id)
    );

    CREATE TABLE IF NOT EXISTS memory_retrievals (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      session_id TEXT,
      query_text TEXT NOT NULL,
      schema_id TEXT,
      trace JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS memory_retrieval_items (
      retrieval_id TEXT NOT NULL REFERENCES memory_retrievals(id) ON DELETE RESTRICT,
      memory_id TEXT NOT NULL REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      rank INTEGER NOT NULL CHECK (rank > 0),
      similarity REAL,
      injected BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY(retrieval_id, memory_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_schemas (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL CHECK (dimensions > 0),
      distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
      input_template_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('building','ready','failed','archived')),
      index_name TEXT,
      index_status TEXT NOT NULL DEFAULT 'pending' CHECK (index_status IN ('pending','ready','failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(namespace, schema_version),
      UNIQUE(namespace, id)
    );
    CREATE TABLE IF NOT EXISTS embedding_schema_state (
      namespace TEXT PRIMARY KEY,
      active_schema_id TEXT,
      fallback_schema_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY(namespace, active_schema_id) REFERENCES embedding_schemas(namespace, id) ON DELETE RESTRICT,
      FOREIGN KEY(namespace, fallback_schema_id) REFERENCES embedding_schemas(namespace, id) ON DELETE RESTRICT,
      CHECK (fallback_schema_id IS NULL OR active_schema_id IS NOT NULL),
      CHECK (active_schema_id IS NULL OR fallback_schema_id IS NULL OR active_schema_id <> fallback_schema_id)
    );
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT NOT NULL REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      schema_id TEXT NOT NULL REFERENCES embedding_schemas(id) ON DELETE RESTRICT,
      vector vector,
      build_status TEXT NOT NULL CHECK (build_status IN ('pending','ready','failed')),
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(memory_id, schema_id)
    );

    CREATE TABLE IF NOT EXISTS memory_conflicts (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      fact_key TEXT,
      left_memory_id TEXT NOT NULL REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      right_memory_id TEXT REFERENCES canonical_memories(id) ON DELETE RESTRICT,
      candidate_claim_id TEXT REFERENCES memory_claims(id) ON DELETE RESTRICT,
      detection_method TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','classified','awaiting_user','resolved','dismissed')),
      classification TEXT,
      importance TEXT CHECK (importance IS NULL OR importance IN ('trivial','normal','important','critical')),
      resolution TEXT,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      CHECK ((right_memory_id IS NOT NULL) <> (candidate_claim_id IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_conflicts_claim_unique
      ON memory_conflicts(left_memory_id, candidate_claim_id) WHERE candidate_claim_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS memory_conflicts_memory_unique
      ON memory_conflicts(LEAST(left_memory_id, right_memory_id), GREATEST(left_memory_id, right_memory_id)) WHERE right_memory_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS memory_changes (
      id TEXT PRIMARY KEY,
      transaction_id TEXT NOT NULL,
      batch_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_revision_before INTEGER,
      entity_revision_after INTEGER,
      operation TEXT NOT NULL,
      before_state JSONB,
      after_state JSONB,
      inverse_operation JSONB NOT NULL,
      actor TEXT NOT NULL,
      rolled_back_by TEXT REFERENCES memory_changes(id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS memory_jobs (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      job_key TEXT NOT NULL UNIQUE,
      job_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_owner TEXT,
      lease_until TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS canonical_memories_lookup_idx ON canonical_memories(namespace, fact_key, status);
    CREATE INDEX IF NOT EXISTS canonical_memories_search_idx ON canonical_memories USING gin(to_tsvector('simple', title || ' ' || value_text));
    CREATE INDEX IF NOT EXISTS memory_claims_review_idx ON memory_claims(namespace, status, created_at);
    CREATE INDEX IF NOT EXISTS memory_jobs_poll_idx ON memory_jobs(status, run_after);

    -- Rule keys group competing instructions during deterministic prompt
    -- compilation. They are optional, and multiple rows must be allowed in one
    -- group so priority and recency can select the active winner.
    ALTER TABLE memory_instructions ALTER COLUMN rule_key DROP NOT NULL;
    ALTER TABLE memory_instructions DROP CONSTRAINT IF EXISTS memory_instructions_namespace_rule_key_key;
    ALTER TABLE memory_retrievals ADD COLUMN IF NOT EXISTS trace JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Evidence is immutable but not unbounded: unreferenced rows older than the
    -- retention window are soft-archived (status + archived_at), never deleted.
    ALTER TABLE memory_evidence ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active','archived'));
    ALTER TABLE memory_evidence ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS memory_evidence_archive_idx
      ON memory_evidence(namespace, status, created_at);

    DO $$ BEGIN
      ALTER TABLE memory_feedback ADD CONSTRAINT memory_feedback_retrieval_fk
        FOREIGN KEY(retrieval_id) REFERENCES memory_retrievals(id) ON DELETE RESTRICT;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN
      ALTER TABLE memory_retrievals ADD CONSTRAINT memory_retrievals_schema_fk
        FOREIGN KEY(schema_id) REFERENCES embedding_schemas(id) ON DELETE RESTRICT;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `)
}

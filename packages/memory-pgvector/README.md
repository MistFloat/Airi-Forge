# @proj-airi/memory-pgvector

Authoritative PostgreSQL/pgvector persistence for AIRI long-term memory. This package owns database invariants, evidence provenance, candidate claims, canonical facts/preferences, permanent instructions, feedback, conflict isolation, embedding schema migration, jobs, audit history, and transactional rollback.

## Data model

The implementation deliberately separates three semantic layers:

1. `memory_evidence` stores immutable user, assistant, tool, document, and vision observations. User and assistant messages are never merged into one source row.
2. `memory_claims` stores atomic Fact/Preference proposals produced by a low-cost LLM. Exact evidence quotes and UTF-16 half-open offsets are validated before insertion.
3. `canonical_memories` stores the current formal projection. `memory_evidence_links` keeps every formal memory traceable to its claims and evidence.

Permanent instructions live in `memory_instructions`. Only management operations with `created_by=user` may write them; vector search and candidate extraction cannot create instructions.

Confidence is not an LLM probability. It is the maximum valid support weight, with explicit user assertions at `0.85` and manual confirmation at `1.00`. A completed calculation with no valid support is `0`; `NULL` means not calculated. Useful/Irrelevant feedback updates a separate smoothed Utility score. Wrong/Outdated changes lifecycle state and never deletes evidence.

## Conflict and time policy

Predicate aliases are normalized through a versioned TypeScript registry before constructing `subject/predicate/scope` keys. The registry declares `single`, `set`, or `temporal_single` cardinality. Structured key conflicts are the primary detector; high embedding similarity remains only an optional candidate source.

Validity uses `[valid_from, valid_until)`. Unknown bounds stay `NULL`, so code cannot invent dates or prove non-overlap from missing information. Existing quarantined memories are excluded from later automatic conflict discovery until a user restores them.

## Embedding schemas

Text evidence remains authoritative when an embedding model changes. `embedding_schemas` identifies provider, model, dimensions, metric, and input template. `embedding_schema_state` holds one Active and at most one Fallback pointer per namespace. Every eligible memory revision queues embeddings for the deduplicated Active, Fallback, and Building schemas.

Activation requires 100% eligible coverage. The pointer switch is protected by a namespace advisory lock and one PostgreSQL transaction. Archiving a Fallback first clears the pointer, then archives the schema and cancels pending work. Foreign keys use `ON DELETE RESTRICT` so a referenced schema or provenance row cannot disappear.

## Desktop flow

The Electron loopback gateway is the only browser-facing database boundary. Its management APIs expose:

- connection health and memory browsing;
- evidence and candidate review/promotion;
- Useful/Irrelevant/Outdated/Wrong feedback;
- conflict listing and user resolution;
- embedding schema creation, activation, Fallback archival, and pending jobs;
- audit changes and cross-entity rollback.

Rollback locks all affected entities in stable order and rejects the whole transaction if any revision changed after the audited operation. Created authoritative rows are archived instead of physically deleted.

## Tests

Deterministic unit tests run without a database:

```sh
pnpm exec vitest run --config packages/memory-pgvector/vitest.config.ts
```

Set `AIRI_MEMORY_TEST_URL` for the guarded integration suite. It verifies schema migration, manual instructions, vector recall, Evidence→Claim promotion, conflict quarantine/resolution, and cross-entity rollback against a real pgvector database.

The PostgreSQL role needs permission to create the `vector` and `pgcrypto` extensions and the memory tables during first initialization. A production deployment can provision these objects ahead of time and then reduce runtime privileges.

## When to use it

Use this package for durable cross-session memory and auditable knowledge governance. Use browser-local DuckDB short-term memory for recent conversational context that should remain entirely inside one browser profile.

Do not import this package into a renderer. Database credentials and operational APIs belong behind the Electron/server boundary, and operational endpoints must not be exposed as Agent or MCP tools.

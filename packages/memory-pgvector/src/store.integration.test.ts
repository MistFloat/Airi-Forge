import { describe, expect, it } from 'vitest'

import { createPgvectorMemoryStore } from './store'

const connectionString = process.env.AIRI_MEMORY_TEST_URL

describe.runIf(connectionString)('pgvector knowledge memory integration', () => {
  it('creates, lists, recalls, and deletes a structured memory', async () => {
    const store = createPgvectorMemoryStore(connectionString!)
    const memoryId = `integration-${Date.now()}`
    const namespace = `integration:test-model:${memoryId}`

    try {
      await store.upsert({
        confidence: 0.95,
        content: 'The user prefers blue.',
        embedding: [1, 0, 0],
        embeddingModel: 'test-3d',
        embeddingProvider: 'integration',
        importance: 0.9,
        kind: 'preference',
        memoryId,
        namespace,
        sourceMessageIds: [],
        status: 'active',
        tags: ['profile', 'color'],
        title: 'Favorite color',
      })

      const listed = await store.list({
        limit: 20,
        namespaces: [namespace],
        offset: 0,
        search: 'blue',
        status: 'active',
      })
      expect(listed.total).toBe(1)
      expect(listed.memories[0]?.memoryId).toBe(memoryId)
      expect(listed.memories[0]?.tags).toEqual(['profile', 'color'])

      const recalled = await store.recall({
        maxResults: 5,
        namespace,
        originalText: 'blue',
        similarityThreshold: 0.9,
        terms: [{ embedding: [1, 0, 0], text: 'blue' }],
      })
      expect(recalled.memories).toHaveLength(1)
      expect(recalled.memories[0]?.similarity).toBe(1)
      expect(recalled.trace.terms).toEqual(['blue'])
      expect(recalled.memories[0]?.retrievalId).toBeTruthy()

      await store.feedback({
        evidenceQuote: 'blue',
        feedback: 'wrong',
        memoryId,
        namespace,
        retrievalId: recalled.memories[0]!.retrievalId,
        source: 'automatic',
        sourceEventId: `feedback-${memoryId}`,
      })
      const quarantined = await store.list({ limit: 20, namespaces: [namespace], offset: 0, status: 'quarantined' })
      expect(quarantined.total).toBe(1)
      const changes = await store.listChanges(namespace) as Array<{ operation?: string, transaction_id?: string }>
      const feedbackChange = changes.find(change => change.operation === 'feedback:wrong')
      await store.rollbackTransaction(namespace, feedbackChange!.transaction_id!)
      const restored = await store.list({ limit: 20, namespaces: [namespace], offset: 0, status: 'active' })
      expect(restored.total).toBe(1)
    }
    finally {
      await store.remove(namespace, memoryId)
    }
  })

  it('stores optional and competing instruction rule keys without embeddings', async () => {
    const store = createPgvectorMemoryStore(connectionString!)
    const memoryId = `instruction-${Date.now()}`
    const competingMemoryId = `${memoryId}-competing`
    const independentMemoryId = `${memoryId}-independent`
    const namespace = `integration:instructions:${memoryId}`

    try {
      await store.upsert({
        confidence: 1,
        content: 'Use SSML for speech output.',
        createdBy: 'user',
        embeddingModel: '',
        embeddingProvider: '',
        importance: 1,
        instructionPriority: 90,
        instructionRuleKey: 'speech.format',
        instructionScope: 'speech',
        kind: 'instruction',
        memoryId,
        namespace,
        sourceMessageIds: [],
        status: 'active',
        tags: ['speech'],
        title: 'Speech format',
      })
      await store.upsert({
        confidence: 1,
        content: 'Prefer plain text when SSML is unavailable.',
        createdBy: 'user',
        embeddingModel: '',
        embeddingProvider: '',
        importance: 1,
        instructionPriority: 50,
        instructionRuleKey: 'speech.format',
        instructionScope: 'speech',
        kind: 'instruction',
        memoryId: competingMemoryId,
        namespace,
        sourceMessageIds: [],
        status: 'active',
        tags: ['speech'],
        title: 'Speech format fallback',
      })
      // ROOT CAUSE:
      //
      // The management UI and public record type treated rule keys as optional,
      // but the database column and store rejected an instruction without one.
      // The same uniqueness constraint also prevented the compiler from applying
      // its documented priority policy to multiple instructions in one group.
      //
      // We fixed this by persisting a missing key as NULL and allowing grouped
      // rows to coexist for deterministic compilation.
      await store.upsert({
        confidence: 1,
        content: 'Keep replies concise.',
        createdBy: 'user',
        embeddingModel: '',
        embeddingProvider: '',
        importance: 1,
        instructionPriority: 80,
        instructionScope: 'chat',
        kind: 'instruction',
        memoryId: independentMemoryId,
        namespace,
        sourceMessageIds: [],
        status: 'active',
        tags: ['chat'],
        title: 'Concise replies',
      })

      const instructions = await store.instructions(namespace)
      expect(instructions.find(item => item.memoryId === memoryId)).toMatchObject({
        instructionPriority: 90,
        instructionRuleKey: 'speech.format',
        instructionScope: 'speech',
      })
      expect(instructions.find(item => item.memoryId === competingMemoryId)?.instructionRuleKey).toBe('speech.format')
      expect(instructions.find(item => item.memoryId === independentMemoryId)?.instructionRuleKey).toBeNull()
    }
    finally {
      await store.remove(namespace, memoryId)
      await store.remove(namespace, competingMemoryId)
      await store.remove(namespace, independentMemoryId)
    }
  })

  it('promotes evidence-backed claims, quarantines conflicts, and rolls back a resolution transaction', async () => {
    const store = createPgvectorMemoryStore(connectionString!)
    const namespace = `integration:claims:${Date.now()}`
    const firstText = '我现在住在上海。'
    const secondText = '我现在住在北京。'

    const firstEvidence = await store.ingestEvidence({
      content: firstText,
      namespace,
      sourceId: 'message-1',
      sourceRole: 'user',
      sourceType: 'user_assertion',
    })
    const firstClaim = await store.createClaim({
      assertionMode: 'explicit',
      evidenceId: firstEvidence.evidenceId,
      factKey: '',
      kind: 'fact',
      namespace,
      polarity: 'positive',
      predicate: '住在',
      quote: firstText,
      quoteEnd: firstText.length,
      quoteStart: 0,
      scope: 'global',
      subject: 'user',
      value: '上海',
    })
    await store.validateClaim(namespace, firstClaim.claimId)
    const firstPromotion = await store.promoteClaim(namespace, firstClaim.claimId)
    expect(firstPromotion.outcome).toBe('promoted')

    const activeAfterFirst = await store.list({ limit: 20, namespaces: [namespace], offset: 0, status: 'active' })
    expect(activeAfterFirst.memories[0]?.confidence).toBe(0.85)

    const secondEvidence = await store.ingestEvidence({
      content: secondText,
      namespace,
      sourceId: 'message-2',
      sourceRole: 'user',
      sourceType: 'user_assertion',
    })
    const secondClaim = await store.createClaim({
      assertionMode: 'explicit',
      evidenceId: secondEvidence.evidenceId,
      factKey: '',
      kind: 'fact',
      namespace,
      polarity: 'positive',
      predicate: 'residence_city',
      quote: secondText,
      quoteEnd: secondText.length,
      quoteStart: 0,
      scope: 'global',
      subject: 'user',
      value: '北京',
    })
    await store.validateClaim(namespace, secondClaim.claimId)
    expect((await store.promoteClaim(namespace, secondClaim.claimId)).outcome).toBe('conflict')

    const conflicts = await store.listConflicts(namespace)
    const conflict = conflicts[0] as { id?: string }
    expect(conflict.id).toBeTruthy()
    await store.resolveConflict(namespace, conflict.id!, 'accept_candidate')

    const changes = await store.listChanges(namespace) as Array<{ operation?: string, transaction_id?: string }>
    const resolution = changes.find(change => change.operation === 'supersede_conflict')
    expect(resolution?.transaction_id).toBeTruthy()
    await store.rollbackTransaction(namespace, resolution!.transaction_id!)

    const restored = await store.list({ limit: 20, namespaces: [namespace], offset: 0, status: 'active' })
    expect(restored.memories.map(memory => memory.content)).toContain('上海')
    expect(restored.memories.map(memory => memory.content)).not.toContain('北京')
  })

  it('quarantines an auto-promoted claim whose predicate cardinality is not registered', async () => {
    const store = createPgvectorMemoryStore(connectionString!)
    const namespace = `integration:unknown-predicate:${Date.now()}`
    const content = 'The user stores private files on a local device.'
    const evidence = await store.ingestEvidence({
      content,
      namespace,
      sourceId: 'message-1',
      sourceRole: 'user',
      sourceType: 'user_assertion',
    })
    const claim = await store.createClaim({
      assertionMode: 'explicit',
      evidenceId: evidence.evidenceId,
      factKey: '',
      kind: 'fact',
      namespace,
      polarity: 'positive',
      predicate: 'uses_local_storage_device',
      quote: content,
      quoteEnd: content.length,
      quoteStart: 0,
      scope: 'global',
      subject: 'user',
      value: 'The user stores private files on a local device.',
    })

    await store.validateClaim(namespace, claim.claimId)
    expect((await store.promoteClaim(namespace, claim.claimId, 'auto')).outcome).toBe('quarantined')
    expect((await store.list({ limit: 20, namespaces: [namespace], offset: 0, status: 'active' })).total).toBe(0)
    expect((await store.listClaims(namespace, 'quarantined'))[0]?.id).toBe(claim.claimId)
  })

  it('promotes a manually confirmed claim whose predicate cardinality is not registered', async () => {
    // ROOT CAUSE:
    //
    // Unknown predicates (predicate not in predicateRegistry) used to be
    // quarantined unconditionally in promoteClaim, so a user clicking Promote
    // in the governance UI got no canonical memory and the claim stayed stuck.
    //
    // We fixed this by only quarantining unknown predicates on the 'auto' path;
    // the user path falls through and treats them with single semantics.
    const store = createPgvectorMemoryStore(connectionString!)
    const namespace = `integration:unknown-predicate-user:${Date.now()}`
    const content = 'The user prefers walking to work.'
    const evidence = await store.ingestEvidence({
      content,
      namespace,
      sourceId: 'message-1',
      sourceRole: 'user',
      sourceType: 'user_assertion',
    })
    const claim = await store.createClaim({
      assertionMode: 'explicit',
      evidenceId: evidence.evidenceId,
      factKey: '',
      kind: 'preference',
      namespace,
      polarity: 'positive',
      predicate: 'commute_habit',
      quote: content,
      quoteEnd: content.length,
      quoteStart: 0,
      scope: 'global',
      subject: 'user',
      value: 'The user prefers walking to work.',
    })

    await store.validateClaim(namespace, claim.claimId)
    expect((await store.promoteClaim(namespace, claim.claimId)).outcome).toBe('promoted')
    expect((await store.list({ limit: 20, namespaces: [namespace], offset: 0, status: 'active' })).total).toBe(1)
    expect((await store.listClaims(namespace, 'promoted'))[0]?.id).toBe(claim.claimId)
  })

  it('keeps active and fallback embedding schemas current after an atomic switch', async () => {
    const store = createPgvectorMemoryStore(connectionString!)
    const namespace = `integration:schemas:${Date.now()}`
    const memoryId = `schema-memory-${Date.now()}`
    const first = await store.createEmbeddingSchema({
      dimensions: 3,
      distanceMetric: 'cosine',
      inputTemplateVersion: 'canonical-v1',
      model: 'test-model-v1',
      namespace,
      provider: 'integration',
      schemaVersion: 'v1',
    })
    await store.activateEmbeddingSchema(namespace, first.schemaId)
    await store.upsert({
      confidence: 1,
      content: 'The user likes blue.',
      embeddingModel: 'test-model-v1',
      embeddingProvider: 'integration',
      importance: 0.8,
      kind: 'preference',
      memoryId,
      namespace,
      sourceMessageIds: [],
      status: 'active',
      tags: [],
      title: 'Color preference',
    })
    const firstJobs = await store.claimEmbeddingJobs(namespace, 'worker-1') as Array<{ payload?: { memoryId?: string, schemaId?: string } }>
    expect(firstJobs.some(job => job.payload?.schemaId === first.schemaId)).toBe(true)
    await store.putEmbedding(memoryId, first.schemaId, [1, 0, 0])

    const second = await store.createEmbeddingSchema({
      dimensions: 3,
      distanceMetric: 'cosine',
      inputTemplateVersion: 'canonical-v1',
      model: 'test-model-v2',
      namespace,
      provider: 'integration',
      schemaVersion: 'v2',
    })
    await store.putEmbedding(memoryId, second.schemaId, [0, 1, 0])
    await store.activateEmbeddingSchema(namespace, second.schemaId)

    await store.upsert({
      confidence: 1,
      content: 'The user strongly likes blue.',
      embeddingModel: 'test-model-v2',
      embeddingProvider: 'integration',
      importance: 0.8,
      kind: 'preference',
      memoryId,
      namespace,
      sourceMessageIds: [],
      status: 'active',
      tags: [],
      title: 'Color preference',
    })
    const activeJobs = await store.claimEmbeddingJobs(namespace, 'worker-2', {
      model: 'test-model-v2',
      provider: 'integration',
    }) as Array<{ payload?: { schemaId?: string } }>
    expect(activeJobs.map(job => job.payload?.schemaId)).toEqual([second.schemaId])

    const fallbackJobs = await store.claimEmbeddingJobs(namespace, 'worker-3', {
      model: 'test-model-v1',
      provider: 'integration',
    }) as Array<{ payload?: { schemaId?: string } }>
    expect(fallbackJobs.map(job => job.payload?.schemaId)).toEqual([first.schemaId])
  })

  it('persists and resumes a strict conflict scan batch', async () => {
    const store = createPgvectorMemoryStore(connectionString!)
    const namespace = `integration:conflict-scan:${Date.now()}`
    const memoryIds = [`scan-a-${Date.now()}`, `scan-b-${Date.now()}`]
    try {
      for (const [index, memoryId] of memoryIds.entries()) {
        await store.upsert({
          confidence: 0.85,
          content: index === 0 ? 'The user uses local storage.' : 'The user does not use cloud storage.',
          embedding: index === 0 ? [1, 0, 0] : [0.9, 0.1, 0],
          embeddingModel: 'test-3d',
          embeddingProvider: 'integration',
          importance: 0.6,
          kind: 'fact',
          memoryId,
          namespace,
          sourceMessageIds: [],
          status: 'active',
          tags: [],
          title: index === 0 ? 'Local storage' : 'No cloud storage',
        })
      }

      const { jobId } = await store.enqueueConflictScan(namespace)
      const jobs = await store.claimConflictScanJobs(namespace, 'conflict-worker') as Array<{ seedTitle?: string }>
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.seedTitle).toBeTruthy()
      const batch = await store.prepareConflictBatch(namespace, jobId, 'conflict-worker', [1, 0, 0])
      expect(batch.members).toHaveLength(2)
      const [left, right] = batch.members
      const applied = await store.applyConflictBatch(namespace, jobId, 'conflict-worker', [{
        classification: 'compatible',
        leftId: left!.id,
        rightId: right!.id,
      }])
      expect(applied.completed).toBe(true)
      const listedJobs = await store.listJobs(namespace, 'all') as Array<{ id?: string, status?: string }>
      expect(listedJobs.find(job => job.id === jobId)?.status).toBe('succeeded')
    }
    finally {
      for (const memoryId of memoryIds)
        await store.remove(namespace, memoryId)
    }
  })
})

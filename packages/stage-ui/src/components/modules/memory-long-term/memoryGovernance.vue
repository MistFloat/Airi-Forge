<script setup lang="ts">
import type { LongTermMemoryClaim, LongTermMemoryEvidence } from '../../../stores/modules/memory-long-term'

import { errorMessageFrom } from '@moeru/std'
import { Button } from '@proj-airi/ui'
import { onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMemoryLongTermStore } from '../../../stores/modules/memory-long-term'

const { t } = useI18n()
const store = useMemoryLongTermStore()
const evidence = shallowRef<LongTermMemoryEvidence[]>([])
const claims = shallowRef<LongTermMemoryClaim[]>([])
const conflicts = shallowRef<Record<string, unknown>[]>([])
const schemas = shallowRef<Record<string, unknown>[]>([])
const jobs = shallowRef<Record<string, unknown>[]>([])
const changes = shallowRef<Record<string, unknown>[]>([])
const schemaState = shallowRef<Record<string, unknown> | null>(null)
const loading = shallowRef(false)
const error = shallowRef('')

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const [nextEvidence, nextClaims, governance] = await Promise.all([
      store.listEvidence(),
      store.listClaims(),
      store.listGovernance(),
    ])
    evidence.value = nextEvidence
    claims.value = nextClaims
    conflicts.value = governance.conflicts
    schemas.value = governance.schemas
    jobs.value = governance.jobs
    changes.value = governance.changes
    schemaState.value = governance.schemaState
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to load memory governance data'
  }
  finally {
    loading.value = false
  }
}

async function processJobs() {
  loading.value = true
  error.value = ''
  try {
    await store.processEmbeddingJobs()
    await refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to process embedding jobs'
    loading.value = false
  }
}

async function scanConflicts() {
  loading.value = true
  error.value = ''
  try {
    await store.startConflictScan()
    await refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to scan memory conflicts'
    loading.value = false
  }
}

async function validateAndPromote(claim: LongTermMemoryClaim) {
  loading.value = true
  error.value = ''
  try {
    // Claims must be validated before promotion. If the user clicks the button
    // on an already-validated claim, skip validation and promote directly.
    if (claim.status === 'proposed' || claim.status === 'quarantined')
      await store.validateClaim(claim.id)
    else if (claim.status !== 'validated')
      throw new Error(`Claim cannot be promoted from status '${claim.status}'`)
    await store.promoteClaim(claim.id)
    await refresh()
  }
  catch (cause) {
    const message = errorMessageFrom(cause) ?? `Failed to promote claim ${claim.id}`
    console.error('[MemoryGovernance] validateAndPromote failed:', { claimId: claim.id, status: claim.status, message }, cause)
    error.value = message
  }
  finally {
    loading.value = false
  }
}

async function createSchema() {
  await store.createEmbeddingSchema()
  await refresh()
}

async function activateSchema(schema: Record<string, unknown>) {
  if (typeof schema.id !== 'string')
    return
  await store.activateEmbeddingSchema(schema.id)
  await refresh()
}

async function archiveFallback() {
  await store.archiveFallbackSchema()
  await refresh()
}

async function archiveEvidence() {
  loading.value = true
  error.value = ''
  try {
    const archived = await store.archiveEvidence()
    await refresh()
    if (archived === 0)
      error.value = 'No unreferenced evidence older than the retention window was found'
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to archive old evidence'
  }
  finally {
    loading.value = false
  }
}

async function resolveConflict(conflict: Record<string, unknown>, decision: 'accept_candidate' | 'dismiss' | 'keep_left' | 'keep_right') {
  if (typeof conflict.id !== 'string')
    return
  await store.resolveConflict(conflict.id, decision)
  await refresh()
}

async function rollbackChange(change: Record<string, unknown>) {
  if (typeof change.transaction_id !== 'string')
    return
  await store.rollbackTransaction(change.transaction_id)
  await refresh()
}

function text(value: unknown): string {
  if (value === null || value === undefined)
    return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function rollbackSupported(change: Record<string, unknown>): boolean {
  return !change.rolled_back_by
    && typeof change.entity_type === 'string'
    && ['claim', 'conflict', 'feedback', 'instruction', 'memory'].includes(change.entity_type)
}

onMounted(refresh)
</script>

<template>
  <section :class="['flex flex-col gap-5']">
    <div :class="['flex flex-wrap items-center justify-between gap-3']">
      <div>
        <h2 :class="['text-lg font-semibold']">
          {{ t('settings.pages.modules.memory-long-term.governance.title') }}
        </h2>
        <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.modules.memory-long-term.governance.description') }}
        </p>
      </div>
      <Button :label="t('settings.pages.modules.memory-long-term.manager.refresh')" :loading="loading" variant="secondary" @click="refresh" />
    </div>

    <p v-if="error" :class="['rounded-lg bg-red-100 p-3 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200']">
      {{ error }}
    </p>

    <div :class="['grid gap-4 xl:grid-cols-2']">
      <section :class="['rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
        <div :class="['flex flex-wrap items-center justify-between gap-2']">
          <h3 :class="['font-semibold']">
            {{ t('settings.pages.modules.memory-long-term.governance.evidence') }} · {{ evidence.length }}
          </h3>
          <Button :label="t('settings.pages.modules.memory-long-term.governance.archive-evidence')" size="sm" variant="secondary" @click="archiveEvidence" />
        </div>
        <div :class="['mt-3 max-h-80 flex flex-col gap-2 overflow-auto']">
          <article v-for="item in evidence" :key="item.id" :class="['rounded-lg bg-white/60 p-3 text-sm dark:bg-black/20']">
            <div :class="['text-xs text-neutral-500']">
              {{ item.sourceType }} · {{ item.sourceRole }} · {{ item.id }}
            </div>
            <p :class="['mt-1 whitespace-pre-wrap']">
              {{ item.content }}
            </p>
          </article>
        </div>
      </section>

      <section :class="['rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
        <h3 :class="['font-semibold']">
          {{ t('settings.pages.modules.memory-long-term.governance.claims') }} · {{ claims.length }}
        </h3>
        <div :class="['mt-3 max-h-80 flex flex-col gap-2 overflow-auto']">
          <article v-for="claim in claims" :key="claim.id" :class="['rounded-lg bg-white/60 p-3 text-sm dark:bg-black/20']">
            <div :class="['flex flex-wrap items-center justify-between gap-2']">
              <span>{{ claim.kind }} · {{ claim.assertionMode }} · {{ claim.status }}</span>
              <Button v-if="['proposed', 'quarantined', 'validated'].includes(claim.status)" :label="t('settings.pages.modules.memory-long-term.governance.promote')" size="sm" @click="validateAndPromote(claim)" />
            </div>
            <div :class="['mt-1 font-mono text-xs']">
              {{ claim.factKey }}
            </div>
            <p :class="['mt-1']">
              {{ claim.polarity === 'negative' ? '¬ ' : '' }}{{ claim.value }}
            </p>
            <blockquote :class="['mt-1 border-l-2 border-primary-400 pl-2 text-xs text-neutral-500']">
              {{ claim.quote }}
            </blockquote>
          </article>
        </div>
      </section>
    </div>

    <section :class="['rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
      <div :class="['flex flex-wrap items-center justify-between gap-2']">
        <h3 :class="['font-semibold']">
          {{ t('settings.pages.modules.memory-long-term.governance.embeddings') }}
        </h3>
        <div :class="['flex flex-wrap gap-2']">
          <Button :label="t('settings.pages.modules.memory-long-term.governance.create-schema')" size="sm" @click="createSchema" />
          <Button :label="t('settings.pages.modules.memory-long-term.governance.process-jobs')" size="sm" variant="secondary" @click="processJobs" />
          <Button :label="t('settings.pages.modules.memory-long-term.governance.archive-fallback')" size="sm" variant="secondary" @click="archiveFallback" />
        </div>
      </div>
      <div :class="['mt-2 break-all text-xs text-neutral-500']">
        {{ text(schemaState) }}
      </div>
      <div :class="['mt-3 grid gap-2 md:grid-cols-2']">
        <article v-for="schema in schemas" :key="text(schema.id)" :class="['rounded-lg bg-white/60 p-3 text-sm dark:bg-black/20']">
          <div>{{ text(schema.provider) }} / {{ text(schema.model) }} · {{ text(schema.dimensions) }}d</div>
          <div :class="['mt-1 text-xs text-neutral-500']">
            {{ text(schema.status) }} · {{ text(schema.ready_count) }}/{{ text(schema.eligible_count) }} · failed {{ text(schema.failed_count) }}
          </div>
          <Button :label="t('settings.pages.modules.memory-long-term.governance.activate')" size="sm" class="mt-2" @click="activateSchema(schema)" />
        </article>
      </div>
    </section>

    <div :class="['grid gap-4 xl:grid-cols-3']">
      <section :class="['rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
        <h3 :class="['font-semibold']">
          {{ t('settings.pages.modules.memory-long-term.governance.conflicts') }} · {{ conflicts.length }}
        </h3>
        <Button :label="t('settings.pages.modules.memory-long-term.governance.scan-conflicts')" size="sm" variant="secondary" @click="scanConflicts" />
        <div :class="['mt-3 max-h-72 flex flex-col gap-2 overflow-auto']">
          <article v-for="conflict in conflicts" :key="text(conflict.id)" :class="['rounded-lg bg-white/60 p-2 text-xs dark:bg-black/20']">
            <pre :class="['whitespace-pre-wrap break-all']">{{ text(conflict) }}</pre>
            <div v-if="conflict.status !== 'resolved' && conflict.status !== 'dismissed'" :class="['mt-2 flex flex-wrap gap-2']">
              <Button :label="t('settings.pages.modules.memory-long-term.governance.keep-left')" size="sm" @click="resolveConflict(conflict, 'keep_left')" />
              <Button v-if="conflict.candidate_claim_id" :label="t('settings.pages.modules.memory-long-term.governance.accept-candidate')" size="sm" @click="resolveConflict(conflict, 'accept_candidate')" />
              <Button v-if="conflict.right_memory_id" :label="t('settings.pages.modules.memory-long-term.governance.keep-right')" size="sm" @click="resolveConflict(conflict, 'keep_right')" />
              <Button :label="t('settings.pages.modules.memory-long-term.governance.dismiss')" size="sm" variant="ghost" @click="resolveConflict(conflict, 'dismiss')" />
            </div>
          </article>
        </div>
      </section>
      <section :class="['rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
        <h3 :class="['font-semibold']">
          {{ t('settings.pages.modules.memory-long-term.governance.jobs') }} · {{ jobs.length }}
        </h3>
        <div :class="['mt-3 max-h-72 flex flex-col gap-2 overflow-auto']">
          <pre v-for="(item, index) in jobs" :key="index" :class="['whitespace-pre-wrap break-all rounded-lg bg-white/60 p-2 text-xs dark:bg-black/20']">{{ text(item) }}</pre>
        </div>
      </section>
      <section :class="['rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
        <h3 :class="['font-semibold']">
          {{ t('settings.pages.modules.memory-long-term.governance.changes') }} · {{ changes.length }}
        </h3>
        <div :class="['mt-3 max-h-72 flex flex-col gap-2 overflow-auto']">
          <article v-for="(change, index) in changes" :key="index" :class="['rounded-lg bg-white/60 p-2 text-xs dark:bg-black/20']">
            <pre :class="['whitespace-pre-wrap break-all']">{{ text(change) }}</pre>
            <Button v-if="rollbackSupported(change)" :label="t('settings.pages.modules.memory-long-term.governance.rollback')" size="sm" class="mt-2" variant="secondary" @click="rollbackChange(change)" />
          </article>
        </div>
      </section>
    </div>
  </section>
</template>

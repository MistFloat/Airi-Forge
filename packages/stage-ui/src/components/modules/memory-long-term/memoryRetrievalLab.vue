<script setup lang="ts">
import type { RecallCaseMetrics, RecallEvaluationSummary } from '@proj-airi/memory-pgvector/evaluation'

import type { LongTermMemoryDraft, LongTermMemoryRecallResult, LongTermMemoryRecallTrace } from '../../../stores/modules/memory-long-term'
import type { MemoryEvaluationCase } from '../../../stores/modules/memoryTestDataset'

import { errorMessageFrom } from '@moeru/std'
import { evaluateRecallCase, summarizeRecallEvaluation } from '@proj-airi/memory-pgvector/evaluation'
import { Button, FieldInput, FieldInputFile, FieldSelect } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMemoryLongTermStore } from '../../../stores/modules/memory-long-term'
import { memoryDraftsFromEvaluationDataset, memoryEvaluationCasesFromDataset } from '../../../stores/modules/memoryTestDataset'

interface EvaluationCaseDetail {
  caseId: string
  error?: string
  original: { metrics: RecallCaseMetrics, traceTerms: string[] } | null
  query: string
  sceneSubType: string
  terms: { metrics: RecallCaseMetrics, traceTerms: string[] } | null
}

interface EvaluationRunResult {
  cases: EvaluationCaseDetail[]
  original: RecallEvaluationSummary
  terms: RecallEvaluationSummary
}

const emit = defineEmits<{
  imported: []
}>()

const { t } = useI18n()
const memoryStore = useMemoryLongTermStore()
const selectedFiles = shallowRef<File[]>()
const drafts = shallowRef<LongTermMemoryDraft[]>([])
const evaluationCases = shallowRef<MemoryEvaluationCase[]>([])
const query = shallowRef('')
const queryScope = shallowRef<'evaluation' | 'memory'>('memory')
const results = shallowRef<LongTermMemoryRecallResult[]>([])
const trace = shallowRef<LongTermMemoryRecallTrace>()
const loadingFile = shallowRef(false)
const importing = shallowRef(false)
const searching = shallowRef(false)
const evaluating = shallowRef(false)
const importedCount = shallowRef(0)
const status = shallowRef('')
const error = shallowRef('')
const evaluationProgress = shallowRef(0)
const evaluationTotal = shallowRef(0)
const evaluationResult = shallowRef<EvaluationRunResult>()
const queryScopeOptions = computed(() => [
  { label: t('settings.pages.modules.memory-long-term.lab.query-scopes.memory'), value: 'memory' },
  { label: t('settings.pages.modules.memory-long-term.lab.query-scopes.evaluation'), value: 'evaluation' },
])

function evaluationNamespace(): string {
  return `${memoryStore.memoryNamespace.trim()}:evaluation`
}

function queryNamespace(): string {
  return queryScope.value === 'evaluation'
    ? evaluationNamespace()
    : memoryStore.memoryNamespace.trim()
}

function percent(value: null | number): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(0)}%`
}

async function inspectDataset() {
  const file = selectedFiles.value?.[0]
  if (!file)
    return
  loadingFile.value = true
  error.value = ''
  status.value = ''
  drafts.value = []
  evaluationCases.value = []
  evaluationResult.value = undefined
  try {
    if (file.size > 5 * 1024 * 1024)
      throw new Error('Memory evaluation JSON must be smaller than 5 MB')
    const parsed = JSON.parse(await file.text()) as unknown
    drafts.value = memoryDraftsFromEvaluationDataset(parsed)
    evaluationCases.value = memoryEvaluationCasesFromDataset(parsed)
    status.value = t('settings.pages.modules.memory-long-term.lab.dataset-ready', { count: drafts.value.length })
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.modules.memory-long-term.lab.dataset-invalid')
  }
  finally {
    loadingFile.value = false
  }
}

async function importDataset() {
  if (drafts.value.length === 0)
    return
  importing.value = true
  importedCount.value = 0
  error.value = ''
  status.value = ''
  try {
    // Sequential writes keep hosted embedding APIs inside conservative rate
    // limits. Stable memory ids make retries and repeated imports idempotent.
    for (const draft of drafts.value) {
      await memoryStore.saveMemory(draft, { namespace: evaluationNamespace() })
      importedCount.value++
    }
    status.value = t('settings.pages.modules.memory-long-term.lab.import-success', {
      count: importedCount.value,
    })
    emit('imported')
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.modules.memory-long-term.lab.import-failed')
  }
  finally {
    importing.value = false
  }
}

async function searchMemories() {
  if (!query.value.trim())
    return
  searching.value = true
  error.value = ''
  results.value = []
  trace.value = undefined
  try {
    // A zero threshold intentionally exposes the nearest results even when
    // they would not pass the production chat threshold.
    const recalled = await memoryStore.recallMemories(query.value, {
      maxResults: 10,
      namespace: queryNamespace(),
      similarityThreshold: 0,
    })
    results.value = recalled.memories
    trace.value = recalled.trace
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.modules.memory-long-term.lab.search-failed')
  }
  finally {
    searching.value = false
  }
}

async function runEvaluation() {
  const cases = evaluationCases.value
  if (cases.length === 0 || importedCount.value === 0)
    return
  evaluating.value = true
  evaluationProgress.value = 0
  evaluationTotal.value = cases.length
  error.value = ''
  evaluationResult.value = undefined
  const details: EvaluationCaseDetail[] = []
  const termsMetrics: RecallCaseMetrics[] = []
  const originalMetrics: RecallCaseMetrics[] = []
  try {
    // Sequential recall keeps hosted embedding APIs inside conservative rate
    // limits. Each case runs both the short-term path and the full-sentence
    // fallback so the two modes can be compared on identical golden targets.
    for (const testCase of cases) {
      evaluationProgress.value++
      const detail: EvaluationCaseDetail = {
        caseId: testCase.caseId,
        original: null,
        query: testCase.query,
        sceneSubType: testCase.sceneSubType,
        terms: null,
      }
      if (testCase.query) {
        try {
          const terms = await memoryStore.recallMemories(testCase.query, {
            maxResults: 10,
            namespace: evaluationNamespace(),
            similarityThreshold: 0,
          })
          detail.terms = {
            metrics: evaluateRecallCase(testCase.expectedIds, testCase.forbiddenIds, terms.memories.map(memory => memory.memoryId)),
            traceTerms: terms.trace.terms,
          }
          termsMetrics.push(detail.terms.metrics)
          const original = await memoryStore.recallMemories(testCase.query, {
            maxResults: 10,
            mode: 'original',
            namespace: evaluationNamespace(),
            similarityThreshold: 0,
          })
          detail.original = {
            metrics: evaluateRecallCase(testCase.expectedIds, testCase.forbiddenIds, original.memories.map(memory => memory.memoryId)),
            traceTerms: original.trace.terms,
          }
          originalMetrics.push(detail.original.metrics)
        }
        catch (cause) {
          // A single failing case must not abort the whole evaluation run.
          detail.error = errorMessageFrom(cause) ?? 'recall failed'
        }
      }
      details.push(detail)
    }
    evaluationResult.value = {
      cases: details,
      original: summarizeRecallEvaluation(originalMetrics),
      terms: summarizeRecallEvaluation(termsMetrics),
    }
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? t('settings.pages.modules.memory-long-term.lab.evaluate-failed')
  }
  finally {
    evaluating.value = false
  }
}
</script>

<template>
  <section :class="['flex flex-col gap-5 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800']">
    <div>
      <h2 :class="['text-lg font-semibold']">
        {{ t('settings.pages.modules.memory-long-term.lab.title') }}
      </h2>
      <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.memory-long-term.lab.description') }}
      </p>
    </div>

    <div :class="['grid items-end gap-3 md:grid-cols-[1fr_auto_auto]']">
      <FieldInputFile
        v-model="selectedFiles"
        accept="application/json,.json"
        :label="t('settings.pages.modules.memory-long-term.lab.dataset-file')"
        :description="t('settings.pages.modules.memory-long-term.lab.dataset-file-description')"
      />
      <Button
        :label="t('settings.pages.modules.memory-long-term.lab.inspect')"
        :loading="loadingFile"
        variant="secondary"
        @click="inspectDataset"
      />
      <Button
        :disabled="drafts.length === 0"
        :label="t('settings.pages.modules.memory-long-term.lab.import', { count: drafts.length })"
        :loading="importing"
        @click="importDataset"
      />
    </div>

    <div v-if="importing" :class="['text-sm text-neutral-500 dark:text-neutral-400']">
      {{ t('settings.pages.modules.memory-long-term.lab.import-progress', { completed: importedCount, total: drafts.length }) }}
    </div>

    <div :class="['grid items-end gap-3 md:grid-cols-[minmax(12rem,0.3fr)_1fr_auto]']">
      <FieldSelect
        v-model="queryScope"
        layout="vertical"
        :label="t('settings.pages.modules.memory-long-term.lab.query-scope')"
        :options="queryScopeOptions"
      />
      <FieldInput
        v-model="query"
        :label="t('settings.pages.modules.memory-long-term.lab.query')"
        :description="t('settings.pages.modules.memory-long-term.lab.query-description')"
        :placeholder="t('settings.pages.modules.memory-long-term.lab.query-placeholder')"
        @keyup.enter="searchMemories"
      />
      <Button
        icon="i-solar:magnifer-bold-duotone"
        :label="t('settings.pages.modules.memory-long-term.lab.search')"
        :loading="searching"
        @click="searchMemories"
      />
    </div>

    <div v-if="status" :class="['rounded-lg bg-green-100 p-3 text-sm text-green-800 dark:bg-green-900/40 dark:text-green-200']">
      {{ status }}
    </div>
    <div v-if="error" :class="['rounded-lg bg-red-100 p-3 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200']">
      {{ error }}
    </div>

    <div v-if="!searching && query.trim() && results.length === 0" :class="['text-sm text-neutral-500 dark:text-neutral-400']">
      {{ t('settings.pages.modules.memory-long-term.lab.no-results', { namespace: queryNamespace() }) }}
    </div>
    <section v-if="trace" :class="['rounded-lg bg-neutral-100 p-3 text-sm dark:bg-neutral-900']">
      <h3 :class="['font-semibold']">
        Retrieval Trace
      </h3>
      <p :class="['mt-1']">
        Terms: {{ trace.terms.join(' / ') }}
      </p>
      <div :class="['mt-2 grid gap-2 md:grid-cols-2']">
        <article
          v-for="candidate in trace.candidates"
          :key="`${candidate.term}:${candidate.memoryId}`"
          :class="['rounded bg-white/70 p-2 text-xs dark:bg-black/20']"
        >
          <div>{{ candidate.term }} #{{ candidate.termRank }} 路 {{ candidate.similarity.toFixed(4) }}</div>
          <div>{{ candidate.injected ? 'injected' : candidate.filterReason ?? 'merged out' }} 路 {{ candidate.memoryId }}</div>
          <div>基线 #{{ candidate.baselineRank ?? '—' }} · 注入 #{{ candidate.finalRank ?? '—' }}</div>
        </article>
      </div>
    </section>
    <ol v-if="results.length" :class="['flex flex-col gap-3']">
      <li
        v-for="(memory, index) in results"
        :key="memory.memoryId"
        :class="['rounded-lg bg-neutral-100 p-3 dark:bg-neutral-900']"
      >
        <div :class="['flex items-center justify-between gap-3']">
          <strong>{{ index + 1 }}. {{ memory.title }}</strong>
          <span :class="['font-mono text-xs']">{{ memory.similarity.toFixed(4) }}</span>
        </div>
        <p :class="['mt-2 whitespace-pre-wrap text-sm']">
          {{ memory.content }}
        </p>
        <p :class="['mt-1 break-all font-mono text-xs text-neutral-500']">
          {{ memory.memoryId }}
        </p>
      </li>
    </ol>

    <section
      v-if="evaluationCases.length"
      :class="['flex flex-col gap-4 rounded-xl border border-dashed border-neutral-300 p-4 dark:border-neutral-700']"
    >
      <div :class="['flex flex-wrap items-center justify-between gap-3']">
        <div>
          <h3 :class="['font-semibold']">
            {{ t('settings.pages.modules.memory-long-term.lab.evaluate-title') }}
          </h3>
          <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
            {{ t('settings.pages.modules.memory-long-term.lab.evaluate-description', { count: evaluationCases.length }) }}
          </p>
        </div>
        <Button
          :disabled="importedCount === 0"
          :label="t('settings.pages.modules.memory-long-term.lab.evaluate-run')"
          :loading="evaluating"
          @click="runEvaluation"
        />
      </div>

      <div v-if="evaluating" :class="['text-sm text-neutral-500 dark:text-neutral-400']">
        {{ t('settings.pages.modules.memory-long-term.lab.evaluate-progress', { completed: evaluationProgress, total: evaluationTotal }) }}
      </div>

      <div v-if="evaluationResult" :class="['overflow-x-auto rounded-lg bg-neutral-100 p-3 text-sm dark:bg-neutral-900']">
        <table :class="['w-full border-collapse text-left']">
          <thead>
            <tr :class="['border-b border-neutral-300 dark:border-neutral-700']">
              <th :class="['py-1 pr-3']">
                {{ t('settings.pages.modules.memory-long-term.lab.evaluate-metric') }}
              </th>
              <th :class="['py-1 pr-3']">
                {{ t('settings.pages.modules.memory-long-term.lab.evaluate-terms') }}
              </th>
              <th :class="['py-1']">
                {{ t('settings.pages.modules.memory-long-term.lab.evaluate-original') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td :class="['py-1 pr-3']">
                {{ t('settings.pages.modules.memory-long-term.lab.evaluate-recall') }}
              </td>
              <td :class="['py-1 pr-3 font-mono']">
                {{ percent(evaluationResult.terms.recallAtKAvg) }}
              </td>
              <td :class="['py-1 font-mono']">
                {{ percent(evaluationResult.original.recallAtKAvg) }}
              </td>
            </tr>
            <tr>
              <td :class="['py-1 pr-3']">
                {{ t('settings.pages.modules.memory-long-term.lab.evaluate-forbidden') }}
              </td>
              <td :class="['py-1 pr-3 font-mono']">
                {{ percent(evaluationResult.terms.forbiddenHitRateAvg) }}
              </td>
              <td :class="['py-1 font-mono']">
                {{ percent(evaluationResult.original.forbiddenHitRateAvg) }}
              </td>
            </tr>
            <tr>
              <td :class="['py-1 pr-3']">
                {{ t('settings.pages.modules.memory-long-term.lab.evaluate-fully-recalled') }}
              </td>
              <td :class="['py-1 pr-3 font-mono']">
                {{ percent(evaluationResult.terms.fullyRecalledRate) }}
              </td>
              <td :class="['py-1 font-mono']">
                {{ percent(evaluationResult.original.fullyRecalledRate) }}
              </td>
            </tr>
            <tr>
              <td :class="['py-1 pr-3']">
                {{ t('settings.pages.modules.memory-long-term.lab.evaluate-clean') }}
              </td>
              <td :class="['py-1 pr-3 font-mono']">
                {{ percent(evaluationResult.terms.cleanRate) }}
              </td>
              <td :class="['py-1 font-mono']">
                {{ percent(evaluationResult.original.cleanRate) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <ol v-if="evaluationResult" :class="['flex flex-col gap-2']">
        <li
          v-for="detail in evaluationResult.cases"
          :key="detail.caseId"
          :class="['rounded-lg bg-neutral-100 p-3 text-sm dark:bg-neutral-900']"
        >
          <div :class="['flex items-baseline justify-between gap-3']">
            <div>
              <strong>{{ detail.caseId }} · {{ detail.sceneSubType }}</strong>
              <p v-if="detail.query" :class="['mt-1 line-clamp-2 text-xs text-neutral-500']">
                {{ detail.query }}
              </p>
              <p v-if="detail.error" :class="['mt-1 text-xs text-red-600 dark:text-red-400']">
                {{ detail.error }}
              </p>
            </div>
            <div :class="['shrink-0 text-right font-mono text-xs']">
              <div v-if="detail.terms">
                <span :class="['mr-2 text-neutral-500']">{{ detail.terms.traceTerms.join('/') }}</span>
                recall {{ percent(detail.terms.metrics.recallAtK) }}
                <span v-if="detail.terms.metrics.erroneouslyRecalledIds.length" :class="['ml-2 text-red-600 dark:text-red-400']">
                  leak {{ detail.terms.metrics.erroneouslyRecalledIds.length }}
                </span>
              </div>
              <div v-if="detail.original" :class="['mt-1 text-neutral-500']">
                原句 recall {{ percent(detail.original.metrics.recallAtK) }}
                <span v-if="detail.original.metrics.erroneouslyRecalledIds.length" :class="['ml-2 text-red-600 dark:text-red-400']">
                  leak {{ detail.original.metrics.erroneouslyRecalledIds.length }}
                </span>
              </div>
            </div>
          </div>
        </li>
      </ol>
    </section>
  </section>
</template>

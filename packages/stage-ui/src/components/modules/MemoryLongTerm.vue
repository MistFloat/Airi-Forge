<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldCheckbox, FieldInput, FieldRange, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import MemoryGovernance from './memory-long-term/memoryGovernance.vue'
import MemoryManager from './memory-long-term/memoryManager.vue'
import MemoryRetrievalLab from './memory-long-term/memoryRetrievalLab.vue'

import { useMemoryLongTermStore } from '../../stores/modules/memory-long-term'

const { t } = useI18n()
const memoryStore = useMemoryLongTermStore()
const { enabled, connectionString, embeddingSource, embeddingProvider, embeddingModel, jinaApiKey, jinaModel, jinaDimensions, similarityThreshold, maxResults, memoryNamespace, instructionTokenBudget, configured, databaseConfigured } = storeToRefs(memoryStore)
const testingDatabase = shallowRef(false)
const testingEmbedding = shallowRef(false)
const databaseStatus = shallowRef('')
const embeddingStatus = shallowRef('')
const healthError = shallowRef('')
const managerRevision = shallowRef(0)
const embeddingSourceOptions = computed(() => [
  { value: 'airi-provider', label: t('settings.pages.modules.memory-long-term.embedding-sources.airi-provider') },
  { value: 'jina-api', label: t('settings.pages.modules.memory-long-term.embedding-sources.jina-api') },
])

function saveSettings() {
  memoryStore.saveSettings()
}

async function testDatabase() {
  testingDatabase.value = true
  healthError.value = ''
  databaseStatus.value = ''
  try {
    const result = await memoryStore.testConnection()
    databaseStatus.value = t('settings.pages.modules.memory-long-term.health.database-success', {
      count: result.memoryCount,
      version: result.pgvectorVersion,
    })
  }
  catch (error) {
    healthError.value = errorMessageFrom(error) ?? t('settings.pages.modules.memory-long-term.health.failed')
  }
  finally {
    testingDatabase.value = false
  }
}

async function testEmbedding() {
  testingEmbedding.value = true
  healthError.value = ''
  embeddingStatus.value = ''
  try {
    const result = await memoryStore.testEmbedding()
    embeddingStatus.value = t('settings.pages.modules.memory-long-term.health.embedding-success', { dimensions: result.dimensions })
  }
  catch (error) {
    healthError.value = errorMessageFrom(error) ?? t('settings.pages.modules.memory-long-term.health.failed')
  }
  finally {
    testingEmbedding.value = false
  }
}
</script>

<template>
  <div flex="~ col gap-6">
    <div class="rounded-xl bg-neutral-100 p-4 dark:bg-[rgba(0,0,0,0.3)]">
      <p class="text-sm text-neutral-500 dark:text-neutral-400">
        {{ t('settings.pages.modules.memory-long-term.page.description') }}
      </p>
    </div>

    <FieldCheckbox
      v-model="enabled"
      :label="t('settings.pages.modules.memory-long-term.enable')"
      :description="t('settings.pages.modules.memory-long-term.enable-description')"
    />

    <FieldInput
      v-model="connectionString"
      type="password"
      :label="t('settings.pages.modules.memory-long-term.connection-string')"
      :description="t('settings.pages.modules.memory-long-term.connection-string-description')"
      placeholder="postgresql://user:password@localhost:5432/airi_memory"
    />

    <FieldInput
      v-model="memoryNamespace"
      :label="t('settings.pages.modules.memory-long-term.namespace')"
      :description="t('settings.pages.modules.memory-long-term.namespace-description')"
      placeholder="default"
    />

    <FieldSelect
      v-model="embeddingSource"
      layout="vertical"
      :label="t('settings.pages.modules.memory-long-term.embedding-source')"
      :options="embeddingSourceOptions"
    />

    <FieldInput
      v-if="embeddingSource === 'airi-provider'"
      v-model="embeddingProvider"
      :label="t('settings.pages.modules.memory-long-term.embedding-provider')"
      :description="t('settings.pages.modules.memory-long-term.embedding-provider-description')"
      :placeholder="t('settings.pages.modules.memory-long-term.embedding-provider-placeholder')"
    />

    <FieldInput
      v-if="embeddingSource === 'airi-provider'"
      v-model="embeddingModel"
      :label="t('settings.pages.modules.memory-long-term.embedding-model')"
      :description="t('settings.pages.modules.memory-long-term.embedding-model-description')"
      :placeholder="t('settings.pages.modules.memory-long-term.embedding-model-placeholder')"
    />

    <template v-if="embeddingSource === 'jina-api'">
      <FieldInput
        v-model="jinaModel"
        :label="t('settings.pages.modules.memory-long-term.embedding-model')"
        :description="t('settings.pages.modules.memory-long-term.embedding-model-description')"
        placeholder="jina-embeddings-v5-text-small"
      />

      <FieldInput
        v-model="jinaApiKey"
        type="password"
        :label="t('settings.pages.modules.memory-long-term.jina-api-key')"
        :description="t('settings.pages.modules.memory-long-term.jina-api-key-description')"
        placeholder="jina_..."
      />

      <FieldInput
        v-model="jinaDimensions"
        type="number"
        :label="t('settings.pages.modules.memory-long-term.jina-dimensions')"
        :description="t('settings.pages.modules.memory-long-term.jina-dimensions-description')"
        placeholder="1024"
      />
    </template>

    <FieldRange
      v-model="similarityThreshold"
      :label="t('settings.pages.modules.memory-long-term.similarity-threshold')"
      :description="t('settings.pages.modules.memory-long-term.similarity-threshold-description')"
      :min="0"
      :max="1"
      :step="0.05"
    />

    <FieldInput
      v-model="maxResults"
      type="number"
      :label="t('settings.pages.modules.memory-long-term.max-results')"
      :description="t('settings.pages.modules.memory-long-term.max-results-description')"
      placeholder="5"
    />

    <FieldInput
      v-model="instructionTokenBudget"
      type="number"
      :label="t('settings.pages.modules.memory-long-term.instruction-token-budget')"
      :description="t('settings.pages.modules.memory-long-term.instruction-token-budget-description')"
      placeholder="1200"
    />

    <div>
      <div :class="['flex flex-wrap gap-3']">
        <Button
          :label="t('settings.common.save')"
          variant="primary"
          @click="saveSettings"
        />
        <Button
          icon="i-solar:database-bold-duotone"
          :label="t('settings.pages.modules.memory-long-term.health.test-database')"
          :loading="testingDatabase"
          variant="secondary"
          @click="testDatabase"
        />
        <Button
          icon="i-solar:magic-stick-3-bold-duotone"
          :label="t('settings.pages.modules.memory-long-term.health.test-embedding')"
          :loading="testingEmbedding"
          variant="secondary"
          @click="testEmbedding"
        />
      </div>
    </div>

    <div v-if="databaseStatus || embeddingStatus" :class="['rounded-lg bg-green-100 p-4 text-sm text-green-800 dark:bg-green-900/40 dark:text-green-200']">
      <p v-if="databaseStatus">
        {{ databaseStatus }}
      </p>
      <p v-if="embeddingStatus">
        {{ embeddingStatus }}
      </p>
    </div>

    <div v-if="healthError" :class="['rounded-lg bg-red-100 p-4 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200']">
      {{ healthError }}
    </div>

    <div v-if="configured" class="mt-4 rounded-lg bg-green-100 p-4 text-green-800 dark:bg-green-900 dark:text-green-200">
      {{ t('settings.pages.modules.memory-long-term.configured') }}
    </div>

    <MemoryRetrievalLab v-if="configured" @imported="managerRevision++" />
    <MemoryManager v-if="databaseConfigured" :key="managerRevision" />
    <MemoryGovernance v-if="databaseConfigured" />
  </div>
</template>

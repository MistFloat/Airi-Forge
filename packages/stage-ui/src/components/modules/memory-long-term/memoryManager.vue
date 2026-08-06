<script setup lang="ts">
import type { LongTermMemoryDraft, LongTermMemoryItem, LongTermMemoryStatus } from '../../../stores/modules/memory-long-term'

import { errorMessageFrom } from '@moeru/std'
import { Button, DoubleCheckButton, FieldInput, FieldSelect } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'

import MemoryEditor from './memoryEditor.vue'

import { useMemoryLongTermStore } from '../../../stores/modules/memory-long-term'

const memoryStore = useMemoryLongTermStore()
const { configured } = storeToRefs(memoryStore)
const { t } = useI18n()
const memories = shallowRef<LongTermMemoryItem[]>([])
const total = shallowRef(0)
const search = shallowRef('')
const status = shallowRef<LongTermMemoryStatus | 'all'>('all')
const offset = shallowRef(0)
const loading = shallowRef(false)
const saving = shallowRef(false)
const error = shallowRef('')
const editorOpen = shallowRef(false)
const selectedMemory = shallowRef<LongTermMemoryItem>()
const pageSize = 20

const page = computed(() => Math.floor(offset.value / pageSize) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

async function refresh(resetPage = false) {
  if (resetPage)
    offset.value = 0
  loading.value = true
  error.value = ''
  try {
    const result = await memoryStore.listMemories({
      search: search.value,
      status: status.value,
      limit: pageSize,
      offset: offset.value,
    })
    memories.value = result.memories
    total.value = result.total
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to load memories'
  }
  finally {
    loading.value = false
  }
}

function createMemory() {
  selectedMemory.value = undefined
  editorOpen.value = true
}

function editMemory(memory: LongTermMemoryItem) {
  selectedMemory.value = memory
  editorOpen.value = true
}

async function saveMemory(draft: LongTermMemoryDraft) {
  saving.value = true
  error.value = ''
  try {
    await memoryStore.saveMemory(draft)
    editorOpen.value = false
    await refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to save memory'
  }
  finally {
    saving.value = false
  }
}

async function deleteMemory(memory: LongTermMemoryItem) {
  error.value = ''
  try {
    await memoryStore.deleteMemory(memory.memoryId, memory.namespace)
    await refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to delete memory'
  }
}

async function addFeedback(memory: LongTermMemoryItem, feedback: 'outdated' | 'useful' | 'wrong') {
  error.value = ''
  try {
    await memoryStore.addFeedback(memory.memoryId, feedback)
    await refresh()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Failed to save feedback'
  }
}

async function previousPage() {
  offset.value = Math.max(0, offset.value - pageSize)
  await refresh()
}

async function nextPage() {
  offset.value += pageSize
  await refresh()
}

onMounted(() => refresh())
</script>

<template>
  <section :class="['flex flex-col gap-5']">
    <div :class="['flex flex-wrap items-end justify-between gap-3']">
      <div>
        <h2 :class="['text-lg font-semibold']">
          {{ t('settings.pages.modules.memory-long-term.manager.title') }}
        </h2>
        <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.modules.memory-long-term.manager.description', { count: total }) }}
        </p>
      </div>
      <Button
        icon="i-solar:add-circle-bold-duotone"
        :label="t('settings.pages.modules.memory-long-term.manager.create')"
        @click="createMemory"
      />
    </div>

    <div :class="['grid items-end gap-3 md:grid-cols-[1fr_14rem_auto]']">
      <FieldInput
        v-model="search"
        :label="t('settings.pages.modules.memory-long-term.manager.search')"
        :placeholder="t('settings.pages.modules.memory-long-term.manager.search-placeholder')"
        @keyup.enter="refresh(true)"
      />
      <FieldSelect
        v-model="status"
        layout="vertical"
        :label="t('settings.pages.modules.memory-long-term.manager.fields.status')"
        :options="[
          { value: 'all', label: t('settings.pages.modules.memory-long-term.manager.statuses.all') },
          { value: 'active', label: t('settings.pages.modules.memory-long-term.manager.statuses.active') },
          { value: 'archived', label: t('settings.pages.modules.memory-long-term.manager.statuses.archived') },
          { value: 'quarantined', label: t('settings.pages.modules.memory-long-term.manager.statuses.quarantined') },
          { value: 'disputed', label: t('settings.pages.modules.memory-long-term.manager.statuses.disputed') },
          { value: 'expired', label: t('settings.pages.modules.memory-long-term.manager.statuses.expired') },
          { value: 'superseded', label: t('settings.pages.modules.memory-long-term.manager.statuses.superseded') },
        ]"
      />
      <Button
        icon="i-solar:magnifer-bold-duotone"
        :label="t('settings.pages.modules.memory-long-term.manager.refresh')"
        :loading="loading"
        variant="secondary"
        @click="refresh(true)"
      />
    </div>

    <div v-if="error" :class="['rounded-lg bg-red-100 p-3 text-sm text-red-800 dark:bg-red-900/40 dark:text-red-200']">
      {{ error }}
    </div>

    <MemoryEditor
      v-if="editorOpen"
      :memory="selectedMemory"
      :semantic-memory-enabled="configured"
      :saving="saving"
      @cancel="editorOpen = false"
      @save="saveMemory"
    />

    <div v-if="!loading && memories.length === 0" :class="['rounded-xl border border-neutral-200 border-dashed p-8 text-center text-sm text-neutral-500 dark:border-neutral-800']">
      {{ t('settings.pages.modules.memory-long-term.manager.empty') }}
    </div>

    <div v-else :class="['flex flex-col gap-3']">
      <article
        v-for="memory in memories"
        :key="memory.memoryId"
        :class="['flex flex-col gap-3', 'rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']"
      >
        <div :class="['flex flex-wrap items-start justify-between gap-3']">
          <div :class="['min-w-0 flex-1']">
            <div :class="['flex flex-wrap items-center gap-2']">
              <h3 :class="['truncate font-semibold']">
                {{ memory.title }}
              </h3>
              <span :class="['rounded-full bg-primary-500/10 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300']">
                {{ t(`settings.pages.modules.memory-long-term.manager.kinds.${memory.kind}`) }}
              </span>
              <span :class="['rounded-full bg-neutral-500/10 px-2 py-0.5 text-xs']">
                {{ t(`settings.pages.modules.memory-long-term.manager.statuses.${memory.status}`) }}
              </span>
            </div>
            <p :class="['mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-300']">
              {{ memory.content }}
            </p>
          </div>
          <div :class="['flex items-center gap-2']">
            <Button
              icon="i-solar:pen-new-square-bold-duotone"
              :label="t('settings.pages.modules.memory-long-term.manager.edit')"
              size="sm"
              variant="secondary"
              @click="editMemory(memory)"
            />
            <DoubleCheckButton size="sm" @confirm="deleteMemory(memory)">
              {{ t('settings.pages.modules.memory-long-term.manager.delete') }}
              <template #confirm>
                {{ t('settings.pages.modules.memory-long-term.manager.confirm-delete') }}
              </template>
              <template #cancel>
                {{ t('settings.pages.modules.memory-long-term.manager.cancel') }}
              </template>
            </DoubleCheckButton>
            <Button
              :label="t('settings.pages.modules.memory-long-term.manager.feedback.useful')"
              size="sm"
              variant="ghost"
              @click="addFeedback(memory, 'useful')"
            />
            <Button
              :label="t('settings.pages.modules.memory-long-term.manager.feedback.outdated')"
              size="sm"
              variant="ghost"
              @click="addFeedback(memory, 'outdated')"
            />
            <Button
              :label="t('settings.pages.modules.memory-long-term.manager.feedback.wrong')"
              size="sm"
              variant="ghost"
              @click="addFeedback(memory, 'wrong')"
            />
          </div>
        </div>
        <div :class="['flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500']">
          <span>{{ t('settings.pages.modules.memory-long-term.manager.importance-value', { value: memory.importance.toFixed(2) }) }}</span>
          <span>{{ t('settings.pages.modules.memory-long-term.manager.confidence-value', { value: memory.confidence === null ? '—' : memory.confidence.toFixed(2) }) }}</span>
          <span>{{ new Date(memory.updatedAt).toLocaleString() }}</span>
          <span v-for="tag in memory.tags" :key="tag">#{{ tag }}</span>
        </div>
      </article>
    </div>

    <div :class="['flex items-center justify-between gap-3']">
      <Button
        :label="t('settings.pages.modules.memory-long-term.manager.previous')"
        variant="secondary"
        :disabled="offset === 0 || loading"
        @click="previousPage"
      />
      <span :class="['text-sm text-neutral-500']">
        {{ t('settings.pages.modules.memory-long-term.manager.page', { page, pages: pageCount }) }}
      </span>
      <Button
        :label="t('settings.pages.modules.memory-long-term.manager.next')"
        variant="secondary"
        :disabled="offset + pageSize >= total || loading"
        @click="nextPage"
      />
    </div>
  </section>
</template>

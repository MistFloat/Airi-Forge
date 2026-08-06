<script setup lang="ts">
import type { LongTermMemoryDraft, LongTermMemoryItem, LongTermMemoryKind, LongTermMemoryStatus } from '../../../stores/modules/memory-long-term'

import { Button, FieldInput, FieldRange, FieldSelect, FieldTextArea } from '@proj-airi/ui'
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  memory?: LongTermMemoryItem
  saving?: boolean
  semanticMemoryEnabled?: boolean
}>()

const emit = defineEmits<{
  cancel: []
  save: [draft: LongTermMemoryDraft]
}>()

const { t } = useI18n()
const draft = reactive({
  memoryId: undefined as string | undefined,
  title: '',
  content: '',
  kind: 'fact' as LongTermMemoryKind,
  tagsText: '',
  importance: 0.7,
  confidence: 0.8,
  status: 'active' as LongTermMemoryStatus,
  supersedesId: undefined as string | undefined,
  effectiveFrom: '',
  effectiveUntil: '',
})
const canSave = computed(() => !!draft.title.trim()
  && !!draft.content.trim()
  && props.semanticMemoryEnabled)

watch(() => props.memory, (memory) => {
  Object.assign(draft, memory
    ? {
        memoryId: memory.memoryId,
        title: memory.title,
        content: memory.content,
        kind: memory.kind,
        tagsText: memory.tags.join(', '),
        importance: memory.importance,
        confidence: memory.confidence ?? 0,
        status: memory.status,
        supersedesId: memory.supersedesId,
        effectiveFrom: memory.effectiveFrom?.slice(0, 16) ?? '',
        effectiveUntil: memory.effectiveUntil?.slice(0, 16) ?? '',
      }
    : {
        memoryId: undefined,
        title: '',
        content: '',
        kind: 'fact',
        tagsText: '',
        importance: 0.7,
        confidence: 0.8,
        status: 'active',
        supersedesId: undefined,
        effectiveFrom: '',
        effectiveUntil: '',
      })
}, { immediate: true })

function submit() {
  if (!canSave.value)
    return

  emit('save', {
    memoryId: draft.memoryId,
    title: draft.title.trim(),
    content: draft.content.trim(),
    kind: draft.kind,
    tags: draft.tagsText.split(',').map(tag => tag.trim()).filter(Boolean),
    importance: draft.importance,
    confidence: draft.confidence,
    status: draft.status,
    supersedesId: draft.supersedesId?.trim() || undefined,
    effectiveFrom: draft.effectiveFrom ? new Date(draft.effectiveFrom).toISOString() : undefined,
    effectiveUntil: draft.effectiveUntil ? new Date(draft.effectiveUntil).toISOString() : undefined,
  })
}
</script>

<template>
  <div :class="['flex flex-col gap-5', 'rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
    <div :class="['flex items-center justify-between gap-3']">
      <h3 :class="['text-base font-semibold']">
        {{ memory ? t('settings.pages.modules.memory-long-term.manager.edit-title') : t('settings.pages.modules.memory-long-term.manager.create-title') }}
      </h3>
      <Button
        :label="t('settings.pages.modules.memory-long-term.manager.cancel')"
        variant="ghost"
        size="sm"
        @click="emit('cancel')"
      />
    </div>
    <FieldInput
      v-model="draft.title"
      required
      :label="t('settings.pages.modules.memory-long-term.manager.fields.title')"
    />
    <FieldTextArea
      v-model="draft.content"
      required
      :rows="8"
      :label="t('settings.pages.modules.memory-long-term.manager.fields.content')"
      :description="t('settings.pages.modules.memory-long-term.manager.fields.content-description')"
    />
    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldSelect
        v-model="draft.kind"
        layout="vertical"
        :label="t('settings.pages.modules.memory-long-term.manager.fields.kind')"
        :options="[
          { value: 'fact', label: t('settings.pages.modules.memory-long-term.manager.kinds.fact') },
          { value: 'preference', label: t('settings.pages.modules.memory-long-term.manager.kinds.preference') },
          { value: 'summary', label: t('settings.pages.modules.memory-long-term.manager.kinds.summary') },
          { value: 'conversation', label: t('settings.pages.modules.memory-long-term.manager.kinds.conversation') },
        ]"
      />
      <FieldSelect
        v-model="draft.status"
        layout="vertical"
        :label="t('settings.pages.modules.memory-long-term.manager.fields.status')"
        :options="[
          { value: 'active', label: t('settings.pages.modules.memory-long-term.manager.statuses.active') },
          { value: 'archived', label: t('settings.pages.modules.memory-long-term.manager.statuses.archived') },
          { value: 'superseded', label: t('settings.pages.modules.memory-long-term.manager.statuses.superseded') },
        ]"
      />
    </div>
    <FieldInput
      v-model="draft.tagsText"
      :label="t('settings.pages.modules.memory-long-term.manager.fields.tags')"
      :description="t('settings.pages.modules.memory-long-term.manager.fields.tags-description')"
    />
    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldRange
        v-model="draft.importance"
        :label="t('settings.pages.modules.memory-long-term.manager.fields.importance')"
        :min="0"
        :max="1"
        :step="0.05"
      />
      <FieldRange
        v-model="draft.confidence"
        :label="t('settings.pages.modules.memory-long-term.manager.fields.confidence')"
        :min="0"
        :max="1"
        :step="0.05"
      />
    </div>
    <FieldInput
      v-model="draft.supersedesId"
      :label="t('settings.pages.modules.memory-long-term.manager.fields.supersedes')"
      :description="t('settings.pages.modules.memory-long-term.manager.fields.supersedes-description')"
    />
    <Button
      :label="t('settings.pages.modules.memory-long-term.manager.save-memory')"
      :loading="saving"
      :disabled="!canSave"
      @click="submit"
    />
    <p v-if="!semanticMemoryEnabled" :class="['text-sm text-amber-700 dark:text-amber-300']">
      {{ t('settings.pages.modules.memory-long-term.manager.embedding-required') }}
    </p>
  </div>
</template>

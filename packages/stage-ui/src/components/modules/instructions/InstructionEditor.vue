<script setup lang="ts">
import type { InstructionDraft } from '../../../stores/modules/instruction-store'
import type { CompilableInstruction, InstructionScope } from '../../../stores/modules/instructionCompiler'

import { Button, FieldInput, FieldRange, FieldSelect, FieldTextArea } from '@proj-airi/ui'
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  instruction?: CompilableInstruction
  saving?: boolean
}>()

const emit = defineEmits<{
  cancel: []
  save: [draft: InstructionDraft]
}>()

const { t } = useI18n()
const draft = reactive({
  title: '',
  content: '',
  status: 'active' as 'active' | 'archived' | 'superseded',
  instructionScope: 'global' as InstructionScope,
  instructionPriority: 50,
  instructionRuleKey: '',
  effectiveFrom: '',
  effectiveUntil: '',
})
const canSave = computed(() => !!draft.title.trim() && !!draft.content.trim())

watch(() => props.instruction, (instruction) => {
  Object.assign(draft, instruction
    ? {
        title: instruction.title,
        content: instruction.content,
        status: instruction.status,
        instructionScope: instruction.instructionScope,
        instructionPriority: instruction.instructionPriority,
        instructionRuleKey: instruction.instructionRuleKey ?? '',
        effectiveFrom: instruction.effectiveFrom?.slice(0, 16) ?? '',
        effectiveUntil: instruction.effectiveUntil?.slice(0, 16) ?? '',
      }
    : {
        title: '',
        content: '',
        status: 'active',
        instructionScope: 'global',
        instructionPriority: 50,
        instructionRuleKey: '',
        effectiveFrom: '',
        effectiveUntil: '',
      })
}, { immediate: true })

function submit() {
  if (!canSave.value)
    return

  emit('save', {
    title: draft.title.trim(),
    content: draft.content.trim(),
    status: draft.status,
    instructionScope: draft.instructionScope,
    instructionPriority: draft.instructionPriority,
    instructionRuleKey: draft.instructionRuleKey.trim() || undefined,
    effectiveFrom: draft.effectiveFrom ? new Date(draft.effectiveFrom).toISOString() : undefined,
    effectiveUntil: draft.effectiveUntil ? new Date(draft.effectiveUntil).toISOString() : undefined,
  })
}
</script>

<template>
  <div :class="['flex flex-col gap-5', 'rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']">
    <div :class="['flex items-center justify-between gap-3']">
      <h3 :class="['text-base font-semibold']">
        {{ instruction ? t('settings.pages.modules.instructions.editor.edit-title') : t('settings.pages.modules.instructions.editor.create-title') }}
      </h3>
      <Button
        :label="t('settings.pages.modules.instructions.editor.cancel')"
        variant="ghost"
        size="sm"
        @click="emit('cancel')"
      />
    </div>

    <FieldInput
      v-model="draft.title"
      required
      :label="t('settings.pages.modules.instructions.editor.fields.title')"
    />
    <FieldTextArea
      v-model="draft.content"
      required
      :rows="8"
      :label="t('settings.pages.modules.instructions.editor.fields.content')"
      :description="t('settings.pages.modules.instructions.editor.fields.content-description')"
    />
    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldSelect
        v-model="draft.instructionScope"
        layout="vertical"
        :label="t('settings.pages.modules.instructions.editor.fields.instruction-scope')"
        :options="[
          { value: 'global', label: t('settings.pages.modules.instructions.editor.scopes.global') },
          { value: 'chat', label: t('settings.pages.modules.instructions.editor.scopes.chat') },
          { value: 'speech', label: t('settings.pages.modules.instructions.editor.scopes.speech') },
          { value: 'memory', label: t('settings.pages.modules.instructions.editor.scopes.memory') },
          { value: 'vision', label: t('settings.pages.modules.instructions.editor.scopes.vision') },
          { value: 'artistry', label: t('settings.pages.modules.instructions.editor.scopes.artistry') },
        ]"
      />
      <FieldRange
        v-model="draft.instructionPriority"
        :label="t('settings.pages.modules.instructions.editor.fields.instruction-priority')"
        :min="0"
        :max="100"
        :step="5"
      />
    </div>
    <FieldInput
      v-model="draft.instructionRuleKey"
      :label="t('settings.pages.modules.instructions.editor.fields.instruction-rule-key')"
      :description="t('settings.pages.modules.instructions.editor.fields.instruction-rule-key-description')"
      placeholder="response.style"
    />
    <div :class="['grid gap-4 md:grid-cols-2']">
      <FieldSelect
        v-model="draft.status"
        layout="vertical"
        :label="t('settings.pages.modules.instructions.editor.fields.status')"
        :options="[
          { value: 'active', label: t('settings.pages.modules.instructions.editor.statuses.active') },
          { value: 'archived', label: t('settings.pages.modules.instructions.editor.statuses.archived') },
          { value: 'superseded', label: t('settings.pages.modules.instructions.editor.statuses.superseded') },
        ]"
      />
      <FieldInput
        v-model="draft.effectiveFrom"
        type="datetime-local"
        :label="t('settings.pages.modules.instructions.editor.fields.effective-from')"
      />
      <FieldInput
        v-model="draft.effectiveUntil"
        type="datetime-local"
        :label="t('settings.pages.modules.instructions.editor.fields.effective-until')"
      />
    </div>
    <Button
      :label="t('settings.pages.modules.instructions.editor.save')"
      :loading="saving"
      :disabled="!canSave"
      @click="submit"
    />
  </div>
</template>

<script setup lang="ts">
import type { InstructionDraft } from '../../../stores/modules/instruction-store'
import type { CompilableInstruction } from '../../../stores/modules/instructionCompiler'

import { errorMessageFrom } from '@moeru/std'
import { Button, DoubleCheckButton } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import InstructionEditor from './InstructionEditor.vue'

import { useInstructionStore } from '../../../stores/modules/instruction-store'

const instructionStore = useInstructionStore()
const { compiled } = storeToRefs(instructionStore)
const { t } = useI18n()
const editorOpen = ref(false)
const selected = ref<CompilableInstruction>()

const instructions = computed(() => instructionStore.instructions)

function createInstruction() {
  selected.value = undefined
  editorOpen.value = true
}

function editInstruction(instruction: CompilableInstruction) {
  selected.value = instruction
  editorOpen.value = true
}

function saveInstruction(draft: InstructionDraft) {
  try {
    instructionStore.saveInstruction(draft, selected.value?.memoryId)
    editorOpen.value = false
  }
  catch (cause) {
    console.error(errorMessageFrom(cause) ?? 'Failed to save instruction')
  }
}

function deleteInstruction(instruction: CompilableInstruction) {
  instructionStore.deleteInstruction(instruction.memoryId)
}
</script>

<template>
  <section :class="['flex flex-col gap-5']">
    <div :class="['flex flex-wrap items-end justify-between gap-3']">
      <div>
        <h2 :class="['text-lg font-semibold']">
          {{ t('settings.pages.modules.instructions.title') }}
        </h2>
        <p :class="['text-sm text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.modules.instructions.description') }}
        </p>
        <p v-if="compiled?.prompt" :class="['mt-1 text-xs text-neutral-500 dark:text-neutral-400']">
          {{ t('settings.pages.modules.instructions.estimated-tokens', { tokens: compiled.estimatedTokens }) }}
        </p>
      </div>
      <Button
        icon="i-solar:add-circle-bold-duotone"
        :label="t('settings.pages.modules.instructions.create')"
        @click="createInstruction"
      />
    </div>

    <InstructionEditor
      v-if="editorOpen"
      :instruction="selected"
      @cancel="editorOpen = false"
      @save="saveInstruction"
    />

    <div v-if="instructions.length === 0" :class="['rounded-xl border border-neutral-200 border-dashed p-8 text-center text-sm text-neutral-500 dark:border-neutral-800']">
      {{ t('settings.pages.modules.instructions.empty') }}
    </div>

    <div v-else :class="['flex flex-col gap-3']">
      <article
        v-for="instruction in instructions"
        :key="instruction.memoryId"
        :class="['flex flex-col gap-3', 'rounded-xl bg-neutral-100/70 p-4 dark:bg-neutral-900/50']"
      >
        <div :class="['flex flex-wrap items-start justify-between gap-3']">
          <div :class="['min-w-0 flex-1']">
            <div :class="['flex flex-wrap items-center gap-2']">
              <h3 :class="['truncate font-semibold']">
                {{ instruction.title }}
              </h3>
              <span :class="['rounded-full bg-primary-500/10 px-2 py-0.5 text-xs text-primary-700 dark:text-primary-300']">
                {{ t(`settings.pages.modules.instructions.scopes.${instruction.instructionScope}`) }}
              </span>
              <span :class="['rounded-full bg-neutral-500/10 px-2 py-0.5 text-xs']">
                {{ t(`settings.pages.modules.instructions.statuses.${instruction.status}`) }}
              </span>
            </div>
            <p :class="['mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-300']">
              {{ instruction.content }}
            </p>
          </div>
          <div :class="['flex items-center gap-2']">
            <Button
              icon="i-solar:pen-new-square-bold-duotone"
              :label="t('settings.pages.modules.instructions.edit')"
              size="sm"
              variant="secondary"
              @click="editInstruction(instruction)"
            />
            <DoubleCheckButton size="sm" @confirm="deleteInstruction(instruction)">
              {{ t('settings.pages.modules.instructions.delete') }}
              <template #confirm>
                {{ t('settings.pages.modules.instructions.confirm-delete') }}
              </template>
              <template #cancel>
                {{ t('settings.pages.modules.instructions.cancel') }}
              </template>
            </DoubleCheckButton>
          </div>
        </div>
        <div :class="['flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500']">
          <span>{{ t('settings.pages.modules.instructions.priority-value', { value: instruction.instructionPriority }) }}</span>
          <span v-if="instruction.instructionRuleKey">{{ instruction.instructionRuleKey }}</span>
          <span>{{ new Date(instruction.updatedAt).toLocaleString() }}</span>
        </div>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

import { useMemoryShortTermStore } from '../../stores/modules/memory-short-term'

const { t } = useI18n()
const memoryStore = useMemoryShortTermStore()
const { enabled, maxItems, contextItems, contextCharacterBudget, configured } = storeToRefs(memoryStore)

function saveSettings() {
  memoryStore.saveSettings()
}
</script>

<template>
  <div flex="~ col gap-6">
    <div class="rounded-xl bg-neutral-100 p-4 dark:bg-[rgba(0,0,0,0.3)]">
      <p class="text-sm text-neutral-500 dark:text-neutral-400">
        {{ t('settings.pages.modules.memory-short-term.page.description') }}
      </p>
    </div>

    <FieldCheckbox
      v-model="enabled"
      :label="t('settings.pages.modules.memory-short-term.enable')"
      :description="t('settings.pages.modules.memory-short-term.enable-description')"
    />

    <FieldInput
      v-model="maxItems"
      type="number"
      :label="t('settings.pages.modules.memory-short-term.max-items')"
      :description="t('settings.pages.modules.memory-short-term.max-items-description')"
      placeholder="100"
    />

    <FieldInput
      v-model="contextItems"
      type="number"
      :label="t('settings.pages.modules.memory-short-term.context-items')"
      :description="t('settings.pages.modules.memory-short-term.context-items-description')"
      placeholder="8"
    />

    <FieldInput
      v-model="contextCharacterBudget"
      type="number"
      :label="t('settings.pages.modules.memory-short-term.context-character-budget')"
      :description="t('settings.pages.modules.memory-short-term.context-character-budget-description')"
      placeholder="6000"
    />

    <div>
      <Button
        :label="t('settings.common.save')"
        variant="primary"
        @click="saveSettings"
      />
    </div>

    <div v-if="configured" class="mt-4 rounded-lg bg-green-100 p-4 text-green-800 dark:bg-green-900 dark:text-green-200">
      {{ t('settings.pages.modules.memory-short-term.configured') }}
    </div>
  </div>
</template>

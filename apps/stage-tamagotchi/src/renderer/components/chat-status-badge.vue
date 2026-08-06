<script setup lang="ts">
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const chatOrchestrator = useChatOrchestratorStore()
const chatStream = useChatStreamStore()
const consciousnessStore = useConsciousnessStore()

const { sending } = storeToRefs(chatOrchestrator)
const { pendingQueuedSendCount } = storeToRefs(chatOrchestrator)
const { streamingMessage } = storeToRefs(chatStream)
const { activeModel, activeProvider } = storeToRefs(consciousnessStore)

// Tool calls already issued in the current round vs. how many settled, so a
// stuck agent loop is visible (calls keep growing while results stay flat).
// Issued calls live in `slices`; settled results live in `tool_results` (the
// orchestrator pushes tool-call-result entries there, not into `slices`).
const toolCallCount = computed(() => streamingMessage.value.slices.filter(slice => slice.type === 'tool-call').length)
const toolResultCount = computed(() => streamingMessage.value.tool_results.length)
const modelLabel = computed(() => {
  if (!activeProvider.value)
    return undefined
  return activeModel.value
    ? t('stage.api-status.model', { provider: activeProvider.value, model: activeModel.value })
    : activeProvider.value
})
</script>

<template>
  <div
    :class="[
      'flex items-center gap-2 px-1 text-[11px] leading-none font-medium',
      'text-neutral-500 dark:text-neutral-400',
    ]"
  >
    <span
      :class="[
        'h-2 w-2 rounded-full',
        sending ? 'animate-pulse bg-emerald-500' : 'bg-neutral-400',
      ]"
    />
    <span>{{ sending ? t('stage.api-status.running') : t('stage.api-status.stopped') }}</span>
    <span v-if="pendingQueuedSendCount > 0" class="rounded bg-primary-500/10 px-1.5 py-0.5">
      {{ t('stage.api-status.queued', { count: pendingQueuedSendCount }) }}
    </span>
    <span v-if="toolCallCount > 0" class="rounded bg-violet-500/10 px-1.5 py-0.5">
      {{ t('stage.api-status.tools', { done: toolResultCount, total: toolCallCount }) }}
    </span>
    <span v-if="modelLabel" class="min-w-0 truncate">{{ modelLabel }}</span>
  </div>
</template>

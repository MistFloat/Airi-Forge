<script setup lang="ts">
import type { AgentToolExecutionProjection } from '@proj-airi/core-agent'

import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

interface Props {
  /** Tool executions whose durable outcome is still unknown. */
  tools: AgentToolExecutionProjection[]
}

const props = defineProps<Props>()

const { t } = useI18n()
const visibleTools = computed(() => props.tools.slice(0, 6))
</script>

<template>
  <!--
    A crashed or restarted renderer can leave a tool call without a durable
    outcome. Those calls are never retried automatically, so they stay visible
    until the user decides what to do with them.
  -->
  <aside
    :class="[
      'min-h-0 flex flex-col gap-3 rounded-2xl p-3',
      'border border-amber-200/40 bg-white/55 shadow-sm backdrop-blur-md',
      'dark:border-amber-800/30 dark:bg-neutral-900/55',
    ]"
    data-testid="unsettled-tool-calls-panel"
  >
    <header>
      <div :class="['flex items-center gap-2', 'text-sm font-semibold']">
        <div :class="['i-solar:danger-triangle-bold-duotone', 'text-amber-500']" />
        <span>{{ t('stage.unsettled-tool-calls.title') }}</span>
      </div>
      <p :class="['mt-1 text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('stage.unsettled-tool-calls.description') }}
      </p>
    </header>

    <div :class="['max-h-72 flex flex-col gap-2 overflow-y-auto pr-1']">
      <article
        v-for="tool in visibleTools"
        :key="`${tool.turnId}:${tool.callId}`"
        :class="[
          'flex flex-col gap-1 rounded-xl p-2.5 text-xs',
          'border border-red-200/60 bg-red-50/70',
          'dark:border-red-900/50 dark:bg-red-950/25',
        ]"
      >
        <div :class="['flex items-center justify-between gap-2']">
          <span :class="['truncate font-medium', 'text-neutral-800 dark:text-neutral-100']">
            {{ tool.toolName }}
          </span>
          <span
            :class="[
              'shrink-0 rounded-full px-2 py-0.5 text-[10px]',
              'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
            ]"
          >
            {{ t(`stage.unsettled-tool-calls.status.${tool.status}`) }}
          </span>
        </div>
        <p :class="['truncate font-mono text-[10px]', 'text-neutral-500 dark:text-neutral-400']">
          {{ tool.callId }}
        </p>
      </article>
    </div>
  </aside>
</template>

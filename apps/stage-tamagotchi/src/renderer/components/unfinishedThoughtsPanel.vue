<script setup lang="ts">
import type {
  AgentToolExecutionProjection,
  AgentUnfinishedSelfTurnProjection,
} from '@proj-airi/core-agent'

import { Button } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

interface Props {
  busy?: boolean
  thoughts: AgentUnfinishedSelfTurnProjection[]
  tools: AgentToolExecutionProjection[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  resume: [turnId: string]
}>()

const { t } = useI18n()
const visibleThoughts = computed(() => props.thoughts.slice(0, 6))
const visibleTools = computed(() => props.tools.slice(0, 6))

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))
}
</script>

<template>
  <aside
    :class="[
      'min-h-0 flex flex-col gap-3 rounded-2xl p-3',
      'border border-amber-200/40 bg-white/55 shadow-sm backdrop-blur-md',
      'dark:border-amber-800/30 dark:bg-neutral-900/55',
    ]"
    data-testid="unfinished-thoughts-panel"
  >
    <header>
      <div :class="['flex items-center gap-2', 'text-sm font-semibold']">
        <div :class="['i-solar:lightbulb-bolt-bold-duotone', 'text-amber-500']" />
        <span>{{ t('stage.unfinished-thoughts.title') }}</span>
      </div>
      <p :class="['mt-1 text-xs', 'text-neutral-500 dark:text-neutral-400']">
        {{ t('stage.unfinished-thoughts.description') }}
      </p>
    </header>

    <div
      v-if="visibleThoughts.length === 0 && visibleTools.length === 0"
      :class="[
        'rounded-xl border border-dashed border-neutral-300/60 p-3 text-center text-xs text-neutral-500',
        'dark:border-neutral-700/60 dark:text-neutral-400',
      ]"
    >
      {{ t('stage.unfinished-thoughts.empty') }}
    </div>

    <section v-if="visibleTools.length > 0" :class="['flex flex-col gap-2']">
      <h3 :class="['flex items-center gap-1.5', 'text-xs text-red-600 font-semibold dark:text-red-400']">
        <div class="i-solar:danger-triangle-bold-duotone" />
        <span>{{ t('stage.unfinished-thoughts.tools.title') }}</span>
      </h3>
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
            {{ t(`stage.unfinished-thoughts.tools.status.${tool.status}`) }}
          </span>
        </div>
        <p :class="['truncate font-mono text-[10px]', 'text-neutral-500 dark:text-neutral-400']">
          {{ tool.callId }}
        </p>
        <p :class="['text-[11px]', 'text-red-700/80 dark:text-red-300/80']">
          {{ t('stage.unfinished-thoughts.tools.description') }}
        </p>
      </article>
    </section>

    <div
      v-if="visibleThoughts.length > 0"
      :class="['max-h-72 flex flex-col gap-2 overflow-y-auto pr-1']"
    >
      <article
        v-for="thought in visibleThoughts"
        :key="thought.turnId"
        :class="[
          'flex flex-col gap-2 rounded-xl p-2.5',
          thought.state === 'open'
            ? 'bg-amber-50/75 dark:bg-amber-950/25'
            : 'bg-neutral-100/70 opacity-70 dark:bg-neutral-800/60',
        ]"
      >
        <div :class="['flex items-center justify-between gap-2', 'text-[10px] text-neutral-500 dark:text-neutral-400']">
          <span>{{ formatTime(thought.interruptedAt) }}</span>
          <span :class="['rounded-full bg-black/5 px-2 py-0.5', 'dark:bg-white/5']">
            {{ t(`stage.unfinished-thoughts.status.${thought.state}`) }}
          </span>
        </div>
        <p :class="['line-clamp-3 whitespace-pre-wrap break-words text-xs', 'text-neutral-700 dark:text-neutral-200']">
          {{ thought.text }}
        </p>
        <p
          v-if="thought.assistantText"
          :class="[
            'line-clamp-2 whitespace-pre-wrap break-words border-l-2 pl-2 text-[11px]',
            'border-amber-300 text-neutral-500 dark:border-amber-700 dark:text-neutral-400',
          ]"
        >
          {{ thought.assistantText }}
        </p>
        <Button
          v-if="thought.state === 'open'"
          block
          size="sm"
          icon="i-solar:play-bold-duotone"
          :disabled="busy"
          :label="t('stage.unfinished-thoughts.resume')"
          @click="emit('resume', thought.turnId)"
        />
      </article>
    </div>
  </aside>
</template>

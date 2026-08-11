<script setup lang="ts">
import type { SelfPromptLoopStatus } from '@proj-airi/stage-ui/stores/chat'

import { Button } from '@proj-airi/ui'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

interface Props {
  canRestart: boolean
  canSend: boolean
  capturedAt?: string
  countdownSeconds?: number
  error?: string
  prompt?: string
  status: SelfPromptLoopStatus
}

const props = defineProps<Props>()

const emit = defineEmits<{
  discard: []
  restart: []
  send: []
}>()

const { t } = useI18n()

const statusLabel = computed(() => t(`stage.self-prompt-loop.status.${props.status}`))
const capturedTime = computed(() => {
  if (!props.capturedAt)
    return undefined

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(props.capturedAt))
})

const statusClasses = computed(() => {
  if (props.status === 'countdown')
    return ['bg-primary-500/10 text-primary-700', 'dark:bg-primary-400/10 dark:text-primary-200']
  if (props.status.startsWith('blocked'))
    return ['bg-amber-500/10 text-amber-700', 'dark:bg-amber-400/10 dark:text-amber-200']
  if (props.status === 'sending')
    return ['bg-sky-500/10 text-sky-700', 'dark:bg-sky-400/10 dark:text-sky-200']
  return ['bg-neutral-500/10 text-neutral-600', 'dark:text-neutral-300']
})
</script>

<template>
  <aside
    :class="[
      'min-h-0 flex flex-col gap-3 overflow-hidden rounded-2xl p-3',
      'border border-primary-200/30 bg-white/55 shadow-sm backdrop-blur-md',
      'dark:border-primary-800/30 dark:bg-neutral-900/55',
    ]"
    data-testid="self-prompt-loop-panel"
  >
    <header class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-sm font-semibold">
          <div class="i-solar:refresh-circle-bold-duotone shrink-0 text-primary-500" />
          <span>{{ t('stage.self-prompt-loop.title') }}</span>
        </div>
        <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          {{ t('stage.self-prompt-loop.description') }}
        </p>
      </div>
      <span :class="['shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold', ...statusClasses]">
        {{ statusLabel }}
      </span>
    </header>

    <template v-if="prompt">
      <section
        :class="[
          'flex items-center justify-between rounded-xl px-3 py-2',
          'bg-primary-50/70 dark:bg-primary-950/35',
        ]"
      >
        <div>
          <div class="text-[10px] text-neutral-500 tracking-wide uppercase dark:text-neutral-400">
            {{ t('stage.self-prompt-loop.auto-send') }}
          </div>
          <div class="mt-0.5 text-xs text-neutral-600 dark:text-neutral-300">
            {{ statusLabel }}
          </div>
        </div>
        <div class="min-w-16 text-right text-2xl text-primary-600 font-semibold font-mono dark:text-primary-300">
          {{ countdownSeconds == null ? '—' : `${countdownSeconds}s` }}
        </div>
      </section>

      <section class="min-h-0 flex flex-1 flex-col gap-1">
        <div class="flex items-center justify-between gap-2 text-[10px] text-neutral-500 dark:text-neutral-400">
          <span>{{ t('stage.self-prompt-loop.pending-prompt') }}</span>
          <span v-if="capturedTime">{{ t('stage.self-prompt-loop.captured-at', { time: capturedTime }) }}</span>
        </div>
        <pre
          :class="[
            'min-h-24 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-xl p-3',
            'bg-neutral-100/70 text-xs leading-relaxed text-neutral-700',
            'dark:bg-neutral-800/70 dark:text-neutral-200',
          ]"
        >{{ prompt }}</pre>
      </section>

      <div
        v-if="error"
        :class="[
          'rounded-xl px-3 py-2 text-xs',
          'bg-red-500/10 text-red-700 dark:text-red-200',
        ]"
      >
        {{ t('stage.self-prompt-loop.last-error', { error }) }}
      </div>

      <div class="flex flex-col gap-2">
        <Button
          block
          size="sm"
          icon="i-solar:play-bold-duotone"
          :disabled="!canSend"
          :label="t('stage.self-prompt-loop.send-now')"
          @click="emit('send')"
        />
        <div class="grid grid-cols-2 gap-2">
          <Button
            block
            size="sm"
            variant="secondary"
            icon="i-solar:restart-bold-duotone"
            :disabled="!canRestart"
            :label="t('stage.self-prompt-loop.restart')"
            @click="emit('restart')"
          />
          <Button
            block
            size="sm"
            variant="danger"
            icon="i-solar:trash-bin-trash-bold-duotone"
            :label="t('stage.self-prompt-loop.discard')"
            @click="emit('discard')"
          />
        </div>
      </div>
    </template>

    <div
      v-else
      :class="[
        'min-h-32 flex flex-1 flex-col items-center justify-center gap-2 rounded-xl p-4 text-center',
        'border border-dashed border-neutral-300/60 text-neutral-500',
        'dark:border-neutral-700/60 dark:text-neutral-400',
      ]"
    >
      <div class="i-solar:chat-round-dots-bold-duotone text-3xl opacity-60" />
      <span class="text-xs">{{ t('stage.self-prompt-loop.empty') }}</span>
    </div>
  </aside>
</template>

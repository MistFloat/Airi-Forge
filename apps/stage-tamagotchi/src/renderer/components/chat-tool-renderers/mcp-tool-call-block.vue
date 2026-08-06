<script setup lang="ts">
import type { ChatToolCallRendererProps } from '@proj-airi/stage-ui/components'

import { ChatToolCallBlock } from '@proj-airi/stage-ui/components'
import { sanitizeMcpToolName } from '@proj-airi/stage-ui/tools/mcp'
import { computed } from 'vue'

import { useTamagotchiMcpToolsStore } from '../../stores/mcp-tools'

const props = defineProps<ChatToolCallRendererProps & { toolCallId: string }>()

const emit = defineEmits<{
  (e: 'toolCallRerun', payload: { args: string, toolCallId: string, toolName: string }): void
}>()

const mcpTools = useTamagotchiMcpToolsStore()

// The main process emits progress with the MCP qualified name (containing "::"),
// but the provider-facing tool name is sanitized ("::" → "__"). Sanitize the
// progress name before comparing so direct tool calls show progress correctly.
const progress = computed(() => {
  if (props.state !== 'executing')
    return undefined

  const current = mcpTools.lastToolProgress
  return current && sanitizeMcpToolName(current.name) === props.toolName ? current : undefined
})

const progressPercent = computed(() => {
  const current = progress.value
  if (!current || !current.total)
    return undefined
  return Math.max(0, Math.min(100, Math.round((current.progress / current.total) * 100)))
})
</script>

<template>
  <div class="w-full flex flex-col gap-1">
    <ChatToolCallBlock
      :tool-call-id="toolCallId"
      :tool-name="toolName"
      :args="args"
      :state="state"
      :result="result"
      @tool-call-rerun="emit('toolCallRerun', $event)"
    />
    <div v-if="progress" class="px-1">
      <div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <div class="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            class="h-full rounded-full bg-primary-500 transition-all duration-200"
            :style="{ width: progressPercent !== undefined ? `${progressPercent}%` : '35%' }"
          />
        </div>
        <span class="shrink-0 whitespace-nowrap">
          {{ progress.message ?? (progressPercent !== undefined ? `${progress.progress} / ${progress.total}` : progress.progress) }}
        </span>
      </div>
    </div>
  </div>
</template>

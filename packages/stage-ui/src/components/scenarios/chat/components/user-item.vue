<script setup lang="ts">
import type { ChatHistoryItem, ChatMessage } from '../../../../types/chat'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { computed } from 'vue'

import { MarkdownRenderer } from '../../../markdown'
import { ChatActionMenu } from '../components/action-menu'
import { projectUserMessage } from '../userMessageProjection'
import { getChatHistoryItemCopyText } from '../utils'

const props = withDefaults(defineProps<{
  message: Extract<ChatMessage, { role: 'user' }>
  label: string
  variant?: 'desktop' | 'mobile'
}>(), {
  variant: 'desktop',
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'delete'): void
}>()

const rawContent = computed(() => {
  const raw = props.message.content
  if (typeof raw === 'string')
    return raw

  if (Array.isArray(raw)) {
    const textPart = raw.find(part => 'type' in part && part.type === 'text') as { text?: string } | undefined
    if (textPart?.text)
      return textPart.text

    return raw.map(entry => JSON.stringify(entry)).join('\n')
  }

  return ''
})

const projection = computed(() => projectUserMessage(rawContent.value))

const containerClasses = computed(() => [
  'flex',
  props.variant === 'mobile' ? 'ml-0 flex-row' : 'ml-12 flex-row-reverse',
])

const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-neutral-100/90 dark:bg-neutral-800/90' : 'px-3 py-3 bg-neutral-100/80 dark:bg-neutral-800/80',
])
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
</script>

<template>
  <div v-if="message.role === 'user'" :class="containerClasses" class="ph-no-capture">
    <ChatActionMenu
      :copy-text="copyText"
      placement="left"
      @copy="emit('copy')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          flex="~ col" shadow="sm neutral-200/50 dark:none"
          min-w-20 rounded-xl h="unset <sm:fit"
          :class="[
            boxClasses,
            (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
          ]"
        >
          <div>
            <span text-sm text="black/60 dark:white/65" font-normal class="inline <sm:hidden">{{ label }}</span>
          </div>
          <MarkdownRenderer
            v-if="projection.visibleText"
            :content="projection.visibleText"
            class="break-words"
          />
          <div v-if="projection.attachments.length" :class="['mt-2 flex flex-col gap-1.5']">
            <div
              v-for="attachment in projection.attachments"
              :key="`${attachment.kind}:${attachment.name}`"
              :class="[
                'flex items-center gap-2 rounded-lg px-2.5 py-2',
                'bg-white/60 text-xs text-neutral-600 dark:bg-neutral-900/45 dark:text-neutral-300',
              ]"
            >
              <div :class="attachment.kind === 'document' ? 'i-solar:document-text-bold-duotone' : 'i-solar:gallery-bold-duotone'" class="shrink-0 text-base" />
              <span class="min-w-0 flex-1 truncate">{{ attachment.name }}</span>
              <span v-if="attachment.truncated" class="shrink-0 text-amber-600 dark:text-amber-400">内容已截断</span>
            </div>
          </div>
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>

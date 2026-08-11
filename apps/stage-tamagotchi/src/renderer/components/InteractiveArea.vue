<script setup lang="ts">
import type { ChatToolCallRendererRegistry } from '@proj-airi/stage-ui/components'
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import type { PendingChatFile } from '../utils/chat-file-ingestion'

import { errorMessageFrom } from '@moeru/std'
import { useStopSpeakingButton } from '@proj-airi/stage-layouts/composables/useStopSpeakingButton'
import { ChatHistory, JournalPreviewModal } from '@proj-airi/stage-ui/components'
import { useAnalytics } from '@proj-airi/stage-ui/composables/use-analytics'
import { useVisionInference } from '@proj-airi/stage-ui/composables/vision'
import { useBackgroundStore } from '@proj-airi/stage-ui/stores/background'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useJournalPreviewStore } from '@proj-airi/stage-ui/stores/journal-preview'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useSelfPromptStore } from '@proj-airi/stage-ui/stores/modules/self-prompt'
import { BasicTextarea } from '@proj-airi/ui'
import { useLocalStorage, useNow } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'

import ChatStatusBadge from './chat-status-badge.vue'
import JournalToolCallBlock from './chat-tool-renderers/journal-tool-call-block.vue'
import SelfPromptLoopPanel from './selfPromptLoopPanel.vue'

import { useChatSyncStore } from '../stores/chat-sync'
import { useTamagotchiMcpToolsStore } from '../stores/mcp-tools'
import { buildChatFileContext, disposePendingChatFiles, prepareChatFiles } from '../utils/chat-file-ingestion'

const router = useRouter()
const messageInput = ref('')
const lastEnterTime = ref(0)
const attachments = ref<PendingChatFile[]>([])

const chatOrchestrator = useChatOrchestratorStore()
const chatSession = useChatSessionStore()
const chatStream = useChatStreamStore()
const chatSyncStore = useChatSyncStore()
const backgroundStore = useBackgroundStore()
const journalPreviewStore = useJournalPreviewStore()
const airiCardStore = useAiriCardStore()
const mcpToolsStore = useTamagotchiMcpToolsStore()
const selfPromptStore = useSelfPromptStore()

const { messages } = storeToRefs(chatSession)
const { streamingMessage } = storeToRefs(chatStream)
const {
  selfWakeDeadline,
  selfWakeLastError,
  selfWakeStatus,
  sending,
} = storeToRefs(chatOrchestrator)
const { pendingPrompt: pendingSelfPrompt } = storeToRefs(selfPromptStore)
const { activeCard, activeCardId } = storeToRefs(airiCardStore)
const { t } = useI18n()
const { openImagePreview } = journalPreviewStore
const isComposing = ref(false)
const DOUBLE_ENTER_INTERVAL_MS = 300
const TRAILING_NEWLINES_REGEX = /[\r\n]+$/
const SEND_MODES = ['enter', 'ctrl-enter', 'double-enter'] as const
type SendMode = (typeof SEND_MODES)[number]
type ToolCallRerunToolset = 'widgets' | 'artistry'
const sendMode = useLocalStorage<SendMode>('ui/chat/settings/send-mode', 'enter')
// MCP tool names are only known after `refresh()`, so MCP renderers are merged
// dynamically instead of being hardcoded like the journal tools.
const toolCallRenderers = computed<ChatToolCallRendererRegistry>(() => ({
  image_journal: JournalToolCallBlock,
  text_journal: JournalToolCallBlock,
  ...mcpToolsStore.mcpToolCallRenderers,
}))
const sendModeLabels = computed<Record<SendMode, string>>(() => ({
  'enter': t('stage.send-mode.enter'),
  'ctrl-enter': t('stage.send-mode.ctrl-enter'),
  'double-enter': t('stage.send-mode.double-enter'),
}))
const {
  trackChatMessageDeleted,
  trackChatMessageRetried,
  trackChatMessagesCleared,
} = useAnalytics()
const { showStopSpeakingButton, stopSpeakingFromChat } = useStopSpeakingButton()
const { runVisionInference } = useVisionInference()
const selfPromptClock = useNow({ interval: 1_000 })

const selfPromptCountdownSeconds = computed(() => {
  if (!selfWakeDeadline.value)
    return undefined

  return Math.max(0, Math.ceil((selfWakeDeadline.value - selfPromptClock.value.getTime()) / 1_000))
})
const canControlSelfPrompt = computed(() => selfWakeStatus.value === 'countdown' || selfWakeStatus.value === 'ready')

const latestImageEntries = computed(() => {
  if (!activeCardId.value)
    return []
  return backgroundStore.journalEntries.slice(0, 3)
})

function navigateToImageJournal() {
  if (!activeCardId.value)
    return
  router.push(`/settings/airi-card?cardId=${activeCardId.value}&tab=gallery`)
}

async function handleSend() {
  if (isComposing.value) {
    return
  }

  if (!messageInput.value.trim() && !attachments.value.length) {
    return
  }

  const textToSend = messageInput.value
  const attachmentsToSend = [...attachments.value]

  // optimistic clear
  messageInput.value = ''
  attachments.value = []

  try {
    const fileContext = await buildChatFileContext(attachmentsToSend, {
      analyzeImage: (imageDataUrl, promptOverride) => runVisionInference({
        imageDataUrl,
        workloadId: 'screen:understand',
        promptOverride,
      }),
    })
    const composedText = [textToSend.trim(), fileContext].filter(Boolean).join('\n\n')
    await chatSyncStore.requestIngest({
      text: composedText,
      toolset: 'artistry',
    })

    disposePendingChatFiles(attachmentsToSend)
  }
  catch (error) {
    // restore on failure
    messageInput.value = textToSend
    attachments.value = attachmentsToSend
    chatSession.setSessionMessages(chatSession.activeSessionId, [
      ...messages.value,
      {
        role: 'error',
        content: errorMessageFrom(error) ?? 'Failed to send message',
      },
    ])
  }
}

function sendFromKeyboard() {
  messageInput.value = messageInput.value.replace(TRAILING_NEWLINES_REGEX, '')
  void handleSend()
}

const fileInput = ref<HTMLInputElement | null>(null)

function handleManualAttach() {
  fileInput.value?.click()
}

function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement
  if (target.files?.length)
    handleFilePaste(Array.from(target.files))
  target.value = ''
}

function handleMessageInputKeydown(event: KeyboardEvent) {
  if (isComposing.value || event.key !== 'Enter')
    return

  const hasControl = event.ctrlKey || event.metaKey
  const hasShift = event.shiftKey

  switch (sendMode.value) {
    case 'enter':
      if (!hasShift && !hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'ctrl-enter':
      if (hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'double-enter':
      if (!hasShift && !hasControl) {
        const now = Date.now()
        if (now - lastEnterTime.value < DOUBLE_ENTER_INTERVAL_MS) {
          event.preventDefault()
          sendFromKeyboard()
          lastEnterTime.value = 0
        }
        else {
          lastEnterTime.value = now
        }
      }
  }
}

function handleFilePaste(files: File[]) {
  try {
    attachments.value.push(...prepareChatFiles(files))
  }
  catch (error) {
    toast.error(errorMessageFrom(error) ?? 'Failed to attach file')
  }
}

function removeAttachment(index: number) {
  const attachment = attachments.value[index]
  if (attachment) {
    disposePendingChatFiles([attachment])
    attachments.value.splice(index, 1)
  }
}

watch(sendMode, () => {
  lastEnterTime.value = 0
})

const historyMessages = computed(() => messages.value as unknown as ChatHistoryItem[])
const assistantLabel = computed(() => activeCard.value?.name?.trim() || undefined)

async function handleDeleteMessage(index: number) {
  const message = messages.value[index]
  await chatSyncStore.requestDeleteMessage({ index })
  trackChatMessageDeleted({
    source: 'history',
    message_role: message?.role ?? 'unknown',
  })
}

onMounted(() => {
  backgroundStore.initializeStore()
})

onUnmounted(() => disposePendingChatFiles(attachments.value))

async function handleRetryMessage(index: number) {
  await chatSyncStore.requestRetry({
    sessionId: chatSession.activeSessionId,
    index,
  })
  trackChatMessageRetried({
    source: 'history',
  })
}

function resolveToolCallRerunToolset(toolName: string): ToolCallRerunToolset | undefined {
  // TODO: Stop hardcoding tool names to app-local toolsets. Tool registration
  // should expose the owning runtime/toolset id so reruns can reuse the exact
  // source that created the original tool call.
  if (toolName === 'image_journal' || toolName === 'text_journal')
    return 'artistry'

  if (toolName === 'stage_widgets' || toolName === 'get_weather')
    return 'widgets'

  return undefined
}

async function handleToolCallRerun(payload: { message: ChatHistoryItem, index: number, key: string | number, toolCallId: string, toolName: string, args: string }) {
  await chatSyncStore.requestToolCallRerun({
    sessionId: chatSession.activeSessionId,
    messageId: payload.message.id,
    index: payload.index,
    toolset: resolveToolCallRerunToolset(payload.toolName),
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    args: payload.args,
  })
}

async function handleCleanupMessages() {
  const messageCount = messages.value.filter(message => message.role !== 'system').length
  await chatSyncStore.requestCleanup()
  trackChatMessagesCleared({
    source: 'chat_controls',
    message_count: messageCount,
  })
}
</script>

<template>
  <div :class="['h-full min-h-0 w-full', 'flex flex-row gap-2']">
    <div class="min-h-0 min-w-0 flex flex-1 flex-col gap-1">
      <div flex="~ col" min-h-0 w-full flex-1 overflow-hidden>
        <ChatStatusBadge class="mb-1" />
        <ChatHistory
          class="min-h-0 flex-1"
          :messages="historyMessages"
          :assistant-label="assistantLabel"
          :sending="sending"
          :streaming-message="streamingMessage"
          :tool-call-renderers="toolCallRenderers"
          @delete-message="handleDeleteMessage($event.index)"
          @retry-message="handleRetryMessage($event.index)"
          @tool-call-rerun="handleToolCallRerun"
        />
      </div>

      <!-- Journal Preview Chips -->
      <div v-if="latestImageEntries.length > 0" class="flex gap-2 overflow-x-auto px-2 py-1 scrollbar-none">
        <div
          v-for="entry in latestImageEntries"
          :key="entry.id"
          :class="[
            'group relative h-14 w-14 shrink-0 cursor-pointer of-hidden rounded-lg',
            'border border-primary-200/30 transition-all hover:border-primary-500',
            'dark:border-primary-800/30 dark:hover:border-primary-400',
          ]"
          @click="openImagePreview(entry)"
        >
          <img :src="entry.url || ''" class="h-full w-full object-cover">
          <div :class="['absolute inset-0 flex items-end p-1', 'bg-gradient-to-t from-black/60 to-transparent']">
            <span class="truncate text-[8px] text-white font-medium">{{ entry.title }}</span>
          </div>

          <!-- Save Button (Top Right, Hover Only) -->
          <button
            :class="[
              'absolute right-1 top-1 z-10 p-1 rounded-md bg-black/40 text-white backdrop-blur-sm',
              'opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/60',
            ]"
            title="Save to computer"
            @click.stop="journalPreviewStore.downloadImage(entry.url || '', entry.title)"
          >
            <div class="i-solar:download-minimalistic-bold-duotone text-[10px]" />
          </button>
        </div>
      </div>
      <div
        v-if="attachments.length > 0"
        :class="[
          'flex flex-wrap gap-2 border-t border-primary-100 p-2',
        ]"
      >
        <div
          v-for="(attachment, index) in attachments"
          :key="attachment.id"
          :class="['relative h-20 w-28 overflow-hidden rounded-md', 'bg-neutral-100 dark:bg-neutral-800']"
        >
          <img v-if="attachment.kind === 'image'" :src="attachment.previewUrl" :class="['h-full w-full object-cover']">
          <video v-else-if="attachment.kind === 'video'" :src="attachment.previewUrl" :class="['h-full w-full object-cover']" muted />
          <div v-else :class="['h-full w-full flex flex-col items-center justify-center gap-1 px-2', 'text-neutral-500 dark:text-neutral-300']">
            <div class="i-solar:document-text-bold-duotone text-2xl" />
            <span class="w-full truncate text-center text-xs">{{ attachment.file.name }}</span>
          </div>
          <button
            :class="[
              'absolute right-1 top-1 h-5 w-5 flex items-center justify-center rounded-full',
              'bg-red-500 text-xs text-white',
            ]"
            @click="removeAttachment(index)"
          >
            &times;
          </button>
        </div>
      </div>
      <div :class="['flex items-center justify-end gap-2 py-1']">
        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <button
              :class="[
                'max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 outline-none',
                'transition-colors transition-transform active:scale-95',
              ]"
              bg="neutral-100 dark:neutral-800"
              text="lg neutral-500 dark:neutral-400"
              :title="t('stage.send-mode.title')"
            >
              <div class="i-solar:keyboard-bold-duotone" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              align="end"
              side="top"
              :side-offset="8"
              :class="[
                'z-50 min-w-[180px] rounded-xl p-1 shadow',
                'bg-white dark:bg-neutral-800',
                'flex flex-col gap-1',
                'data-[side=top]:animate-slideDownAndFade',
                'data-[side=left]:animate-none',
                'data-[side=bottom]:animate-none',
                'data-[side=right]:animate-none',
              ]"
            >
              <DropdownMenuItem
                v-for="mode in SEND_MODES"
                :key="mode"
                :class="[
                  'w-full flex cursor-pointer items-center rounded-md px-3 py-2 text-left text-xs outline-none transition-colors',
                  'hover:bg-primary-50 dark:hover:bg-primary-900/20',
                  sendMode === mode ? 'bg-primary-50 text-primary-600 font-semibold dark:bg-primary-900/20 dark:text-primary-300' : 'text-neutral-500',
                ]"
                @select="sendMode = mode"
              >
                <div class="mr-2 h-4 w-4 flex shrink-0 items-center justify-center">
                  <div v-if="sendMode === mode" class="i-ph:check-bold text-base" />
                </div>
                <span>{{ sendModeLabels[mode] }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>

        <button
          v-if="showStopSpeakingButton"
          data-testid="stop-speaking-button"
          :class="[
            'max-h-[10lh] min-h-[1lh]',
          ]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="primary-500 dark:primary-400"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          title="停止语音播放"
          aria-label="停止语音播放"
          @click="stopSpeakingFromChat"
        >
          <div class="i-solar:stop-circle-bold-duotone" />
        </button>

        <button
          :class="[
            'max-h-[10lh] min-h-[1lh]',
          ]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="red-500 dark:red-400"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          @click="handleCleanupMessages"
        >
          <div class="i-solar:trash-bin-2-bold-duotone" />
        </button>

        <!-- Image Journal Deep Link -->
        <button
          class="max-h-[10lh] min-h-[1lh]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="primary-500 dark:primary-400"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          title="Image Journal"
          @click="navigateToImageJournal"
        >
          <div class="i-solar:gallery-bold-duotone" />
        </button>

        <!-- Attach document or media -->
        <button
          class="max-h-[10lh] min-h-[1lh]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="primary-500 dark:primary-400"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          title="Attach document or media"
          @click="handleManualAttach"
        >
          <div class="i-solar:paperclip-2-bold-duotone" />
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="text/*,.md,.markdown,.json,.csv,.tsv,.yaml,.yml,.toml,.xml,.log,image/*,video/*"
          class="hidden"
          multiple
          @change="handleFileSelect"
        >
      </div>
      <BasicTextarea
        v-model="messageInput"
        :submit-on-enter="false"
        :placeholder="t('stage.message')"
        class="ph-no-capture [scrollbar-gutter:stable]"
        text="primary-600 dark:primary-100  placeholder:primary-500 dark:placeholder:primary-200"
        border="solid 2 primary-200/20 dark:primary-400/20"
        bg="primary-100/50 dark:primary-900/70"
        max-h="[10lh]" min-h="[1lh]"
        w-full shrink-0 resize-none overflow-y-auto rounded-xl p-2 font-medium outline-none
        transition="all duration-250 ease-in-out placeholder:all placeholder:duration-250 placeholder:ease-in-out"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @keydown="handleMessageInputKeydown"
        @paste-file="handleFilePaste"
      />
    </div>

    <SelfPromptLoopPanel
      class="w-64 shrink-0"
      :can-restart="canControlSelfPrompt"
      :can-send="canControlSelfPrompt"
      :captured-at="pendingSelfPrompt?.capturedAt"
      :countdown-seconds="selfPromptCountdownSeconds"
      :error="selfWakeLastError"
      :prompt="pendingSelfPrompt?.prompt"
      :status="selfWakeStatus"
      @discard="chatOrchestrator.discardSelfPrompt()"
      @restart="chatOrchestrator.restartSelfWakeCountdown()"
      @send="chatOrchestrator.sendSelfPromptNow()"
    />

    <!-- Shared Preview Modal -->
    <JournalPreviewModal />
  </div>
</template>

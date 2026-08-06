import type { ChatOrchestratorRuntimeState, ChatOrchestratorSendOptions, StreamEvent, StreamOptions } from '@proj-airi/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'

import { createChatOrchestratorRuntime } from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { useAnalytics } from '../composables'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import { extractMessageText, isCloudSyncableMessage } from '../libs/chat-sync'
import { createMinecraftContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useContextObservabilityStore } from './devtools/context-observability'
import { useLLM } from './llm'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { useAiriCardStore } from './modules/airi-card'
import { useAutonomousArtistryStore } from './modules/artistry-autonomous'
import { useConsciousnessStore } from './modules/consciousness'
import { useInstructionStore } from './modules/instruction-store'
import { useMemoryLongTermStore } from './modules/memory-long-term'
import { useMemoryShortTermStore } from './modules/memory-short-term'

interface ForkOptions {
  atIndex?: number
  fromSessionId?: string
  hidden?: boolean
  reason?: string
}

type ProviderHistoryMessage = Exclude<ChatHistoryItem, { role: 'error' }>

function isTextDelta(event: StreamEvent): event is Extract<StreamEvent, { type: 'text-delta' }> {
  return event.type === 'text-delta'
}

function toProviderHistory(messages: ChatHistoryItem[]): Message[] {
  return messages.filter((message): message is ProviderHistoryMessage => message.role !== 'error')
}

export type { QueuedSendSnapshot, ChatOrchestratorSendOptions as SendOptions } from '@proj-airi/core-agent'

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const consciousnessStore = useConsciousnessStore()
  const artistryAutonomousStore = useAutonomousArtistryStore()
  const longTermMemoryStore = useMemoryLongTermStore()
  const shortTermMemoryStore = useMemoryShortTermStore()
  const instructionStore = useInstructionStore()
  // Standing rules (ACT / DELAY / CALL policy etc.) must be present even when
  // long-term memory is not configured, so seed them at runtime start.
  instructionStore.seedStageControl()
  const { activeModel, activeProvider } = storeToRefs(consciousnessStore)
  const {
    trackAssistantResponseRendered,
    trackChatActivationFailed,
    trackChatActivationStarted,
    trackChatActivationSucceeded,
    trackFirstMessage,
    trackLlmFirstToken,
    trackLlmRequestStarted,
    trackMessageRound,
    trackMessageRoundFailed,
    trackMessageSendStarted,
    trackMessageSent,
    trackSecondTurnStarted,
  } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const cardStore = useAiriCardStore()
  const contextObservability = useContextObservabilityStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const pendingQueuedSendCount = ref(0)
  let ownedActiveTurnSpan: typeof activeTurnSpan.value

  async function streamWithStageAdapters(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    let llmTextLength = 0

    const hadExistingTurn = !!activeTurnSpan.value
    if (!hadExistingTurn) {
      const turnSpan = startSpan(IOSpanNames.InteractionTurn)
      activeTurnSpan.value = turnSpan
      ownedActiveTurnSpan = turnSpan
    }

    const llmSpan = startSpan(IOSpanNames.LLMInference, activeTurnSpan.value, {
      [IOAttributes.GenAIRequestModel]: model,
      [IOAttributes.Subsystem]: IOSubsystems.LLM,
    })
    const llmRequestTs = performance.now()
    let llmFirstTokenEmitted = false

    try {
      await llmStore.stream(model, chatProvider, messages, {
        ...options,
        onStreamEvent: async (event: StreamEvent) => {
          if (isTextDelta(event)) {
            if (!llmFirstTokenEmitted) {
              llmFirstTokenEmitted = true
              llmSpan.addEvent(IOEvents.LLMFirstToken, {
                [IOAttributes.LLM_TTFT]: performance.now() - llmRequestTs,
              })
            }
            llmTextLength += event.text.length
          }

          await options?.onStreamEvent?.(event)
        },
      })

      llmSpan.setAttribute(IOAttributes.LLMTextLength, llmTextLength)
    }
    finally {
      llmSpan.end()
    }
  }

  function syncRuntimeState(state: ChatOrchestratorRuntimeState) {
    sending.value = state.sending
    pendingQueuedSendCount.value = state.pendingQueuedSendCount
  }

  function settleOwnedActiveTurnSpan() {
    if (!ownedActiveTurnSpan)
      return

    ownedActiveTurnSpan.end()
    if (activeTurnSpan.value === ownedActiveTurnSpan)
      activeTurnSpan.value = undefined
    ownedActiveTurnSpan = undefined
  }

  /**
   * Classifies configured chat providers into low-cardinality product analytics buckets.
   */
  function providerMode(providerId: string | undefined): 'custom' | 'official' | 'unknown' {
    if (!providerId)
      return 'unknown'
    return providerId.startsWith('official-provider') ? 'official' : 'custom'
  }

  let lastSendSource: 'text' | 'voice' = 'text'

  const runtime = createChatOrchestratorRuntime({
    context: {
      ingest: envelope => chatContext.ingestContextMessage(envelope),
      snapshot: () => chatContext.getContextsSnapshot(),
    },
    createId: nanoid,
    foregroundStream: {
      patch: (message) => {
        streamingMessage.value = message
      },
      reset: () => {
        streamingMessage.value = { content: '', role: 'assistant', slices: [], tool_results: [] }
      },
    },
    getActiveProvider: () => activeProvider.value,
    getActiveSessionId: () => activeSessionId.value,
    getSystemPrompt: () => cardStore.systemPrompt,
    getSystemPromptSupplement: () => [
      llmToolsetPromptsStore.activeToolsetPrompt,
      instructionStore.compiled.prompt,
    ].filter((value): value is string => !!value).join('\n\n'),
    llm: {
      stream: streamWithStageAdapters,
    },
    memory: {
      async recall(sessionId, query) {
        const prompts = await Promise.allSettled([
          shortTermMemoryStore.recallPrompt(sessionId),
          longTermMemoryStore.recallPrompt(sessionId, query),
        ])
        return prompts
          .filter((result): result is PromiseFulfilledResult<string | undefined> => result.status === 'fulfilled')
          .map(result => result.value?.trim())
          .filter((value): value is string => !!value)
          .join('\n\n') || undefined
      },
      async rememberTurn(turn) {
        const results = await Promise.allSettled([
          shortTermMemoryStore.rememberTurn(turn.sessionId, turn.userText, turn.assistantText),
          longTermMemoryStore.rememberTurn(turn.sessionId, turn.userText, turn.assistantText),
        ])
        const longTermResult = results[1]
        if (longTermResult?.status === 'rejected') {
          // NOTICE:
          // Long-term memory persistence is OPTIONAL — the chat flow must never
          // die because the database or gateway is unavailable. Previously this
          // re-threw the rejection "for diagnostics", but when PostgreSQL is
          // persistently down, every turn's rememberTurn rejects, the re-throw
          // aborts the orchestrator's turn, and the conversation dies.
          // The memory store's circuit breaker already logs a warning when it
          // opens; this boundary captures the rejection for observability only.
          console.warn('Long-term memory rememberTurn rejected (fail-open):', longTermResult.reason)
        }
      },
    },
    onAssistantMessageAppended: ({ message, sessionId }) => {
      if (isCloudSyncableMessage(message) && message.id) {
        void chatSession.pushMessageToCloud(sessionId, {
          content: extractMessageText(message),
          id: message.id,
          role: 'assistant',
        })
      }
    },
    onAssistantResponseRendered: ({ conversationId, latencyMs, model, roundId, turnIndex }) => {
      trackAssistantResponseRendered({
        conversation_id: conversationId,
        latency_ms: latencyMs,
        model,
        round_id: roundId,
        turn_index: turnIndex,
      })
    },
    onAssistantTurnReady: ({ messageText, sessionMessages }) => {
      const artistry = cardStore.activeCard?.extensions?.airi?.modules?.artistry
      if (artistry?.autonomousEnabled && artistry?.autonomousTarget === 'assistant')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
    onChatActivationFailed: ({ conversationId, errorCode, failureStage, model, provider, roundId, source, turnIndex }) => {
      trackChatActivationFailed({
        conversation_id: conversationId,
        error_code: errorCode,
        failure_stage: failureStage,
        model_id: model || 'unknown',
        provider_id: provider || 'unknown',
        provider_mode: providerMode(provider),
        round_id: roundId,
        source,
        turn_index: turnIndex,
      })
    },
    onChatActivationStarted: ({ conversationId, model, provider, roundId, source, turnIndex }) => {
      const mode = providerMode(provider)
      const providerId = provider || 'unknown'
      const modelId = model || 'unknown'

      trackChatActivationStarted({
        conversation_id: conversationId,
        model_id: modelId,
        provider_id: providerId,
        provider_mode: mode,
        round_id: roundId,
        source,
        turn_index: turnIndex,
      })
    },
    onChatActivationSucceeded: ({ conversationId, durationMs, model, provider, roundId, source, turnIndex }) => trackChatActivationSucceeded({
      conversation_id: conversationId,
      model_id: model || 'unknown',
      provider_id: provider || 'unknown',
      provider_mode: providerMode(provider),
      round_id: roundId,
      source,
      time_to_first_message_ms: durationMs,
      turn_index: turnIndex,
    }),
    onLifecycle: record => contextObservability.recordLifecycle(record),
    onLlmFirstToken: ({ conversationId, model, roundId, ttfbMs, turnIndex }) => trackLlmFirstToken({
      conversation_id: conversationId,
      model,
      round_id: roundId,
      ttfb_ms: ttfbMs,
      turn_index: turnIndex,
    }),
    onLlmRequestStarted: ({ conversationId, hasVoice, model, provider, roundId, turnIndex }) => trackLlmRequestStarted({
      conversation_id: conversationId,
      has_voice: hasVoice,
      model,
      provider,
      round_id: roundId,
      turn_index: turnIndex,
    }),
    onMessageRound: ({ conversationId, durationMs, hasVoice, model, roundId, turnIndex }) => trackMessageRound({
      conversation_id: conversationId,
      duration_ms: durationMs,
      has_voice: hasVoice,
      model,
      round_id: roundId,
      turn_index: turnIndex,
    }),
    onMessageRoundFailed: ({ conversationId, errorCode, failureStage, model, provider, roundId, source, turnIndex }) => trackMessageRoundFailed({
      conversation_id: conversationId,
      error_code: errorCode,
      failure_stage: failureStage,
      model_id: model || 'unknown',
      provider_id: provider || 'unknown',
      round_id: roundId,
      source,
      turn_index: turnIndex,
    }),
    onMessageSendStarted: ({ conversationId, model, roundId, source, turnIndex }) => {
      lastSendSource = source
      trackMessageSendStarted({
        conversation_id: conversationId,
        model,
        round_id: roundId,
        source,
        turn_index: turnIndex,
      })
    },
    onPromptProjection: payload => contextObservability.capturePromptProjection(payload),
    onSendSettled: settleOwnedActiveTurnSpan,
    onStateChange: syncRuntimeState,
    onTrackFirstMessage: trackFirstMessage,
    onUserMessageAppended: ({ message, messageText, model, provider, roundId, sessionId, source, turnIndex }) => {
      trackMessageSent({
        conversation_id: sessionId,
        has_attachment: false,
        message_id: message.id,
        message_index: chatSession.getSessionMessages(sessionId).length,
        message_length: messageText.length,
        mode: lastSendSource,
        model: activeModel.value || 'unknown',
        provider_name: activeProvider.value || 'unknown',
        provider_type: providerMode(activeProvider.value),
        round_id: roundId,
        turn_index: turnIndex,
      })
      if (turnIndex === 2) {
        trackSecondTurnStarted({
          conversation_id: sessionId,
          model_id: model || 'unknown',
          provider_id: provider || 'unknown',
          provider_mode: providerMode(provider),
          round_id: roundId,
          source,
          turn_index: turnIndex,
        })
      }

      if (isCloudSyncableMessage(message)) {
        void chatSession.pushMessageToCloud(sessionId, {
          content: messageText,
          id: message.id,
          role: 'user',
        })
      }
    },
    onUserTurnReady: ({ messageText, sessionMessages }) => {
      const autonomousTarget = cardStore.activeCard?.extensions?.airi?.modules?.artistry?.autonomousTarget || 'user'
      if (autonomousTarget === 'user')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
    runtimeContextProviders: [
      createMinecraftContext,
    ],
    session: {
      appendSessionMessage: (sessionId, message) => chatSession.appendSessionMessage(sessionId, message),
      ensureSession: sessionId => chatSession.ensureSession(sessionId),
      getSessionGeneration: sessionId => chatSession.getSessionGeneration(sessionId),
      getSessionMessages: sessionId => chatSession.getSessionMessages(sessionId).map(message => toRaw(message)),
    },
    unwrapMessage: message => toRaw(message),
  })

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  async function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    return runtime.ingest(sendingMessage, options, targetSessionId)
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      atIndex: forkOptions.atIndex,
      fromSessionId: baseSessionId,
      hidden: forkOptions.hidden,
      reason: forkOptions.reason,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function cancelPendingSends(sessionId?: string) {
    runtime.cancelPendingSends(sessionId)
  }

  function getPendingQueuedSendSnapshot() {
    return runtime.getPendingQueuedSendSnapshot()
  }

  return {
    cancelPendingSends,
    clearHooks: runtime.hooks.clearHooks,

    emitAfterMessageComposedHooks: runtime.hooks.emitAfterMessageComposedHooks,
    emitAfterSendHooks: runtime.hooks.emitAfterSendHooks,
    emitAssistantMessageHooks: runtime.hooks.emitAssistantMessageHooks,
    emitAssistantResponseEndHooks: runtime.hooks.emitAssistantResponseEndHooks,

    emitBeforeMessageComposedHooks: runtime.hooks.emitBeforeMessageComposedHooks,

    emitBeforeSendHooks: runtime.hooks.emitBeforeSendHooks,
    emitChatTurnCompleteHooks: runtime.hooks.emitChatTurnCompleteHooks,
    emitStreamEndHooks: runtime.hooks.emitStreamEndHooks,
    emitTokenLiteralHooks: runtime.hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: runtime.hooks.emitTokenSpecialHooks,
    getPendingQueuedSendSnapshot,
    ingest,
    ingestOnFork,
    onAfterMessageComposed: runtime.hooks.onAfterMessageComposed,
    onAfterSend: runtime.hooks.onAfterSend,

    onAssistantMessage: runtime.hooks.onAssistantMessage,
    onAssistantResponseEnd: runtime.hooks.onAssistantResponseEnd,
    onBeforeMessageComposed: runtime.hooks.onBeforeMessageComposed,
    onBeforeSend: runtime.hooks.onBeforeSend,
    onChatTurnComplete: runtime.hooks.onChatTurnComplete,
    onStreamEnd: runtime.hooks.onStreamEnd,
    onTokenLiteral: runtime.hooks.onTokenLiteral,
    onTokenSpecial: runtime.hooks.onTokenSpecial,
    pendingQueuedSendCount,
    sending,
  }
})

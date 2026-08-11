import type { ChatOrchestratorRuntimeState, ChatOrchestratorSendOptions, StreamEvent, StreamOptions } from '@proj-airi/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'

import { errorMessageFrom } from '@moeru/std'
import { createChatOrchestratorRuntime } from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, shallowRef, toRaw, watch } from 'vue'

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
import { useSelfPromptStore } from './modules/self-prompt'
import { useProviderMaxTokensStore } from './provider-max-tokens'
import { useProvidersStore } from './providers'

/** User-visible lifecycle of the pending self-prompt turn. */
export type SelfPromptLoopStatus = 'blocked-chat' | 'blocked-model' | 'blocked-provider' | 'countdown' | 'idle' | 'ready' | 'sending'

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

export type { QueuedSendSnapshot, ChatOrchestratorSendOptions as SendOptions } from '@proj-airi/core-agent'

function toProviderHistory(messages: ChatHistoryItem[]): Message[] {
  return messages.filter((message): message is ProviderHistoryMessage => message.role !== 'error')
}

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const consciousnessStore = useConsciousnessStore()
  const artistryAutonomousStore = useAutonomousArtistryStore()
  const longTermMemoryStore = useMemoryLongTermStore()
  const shortTermMemoryStore = useMemoryShortTermStore()
  const instructionStore = useInstructionStore()
  const providersStore = useProvidersStore()
  const providerMaxTokensStore = useProviderMaxTokensStore()
  const selfPromptStore = useSelfPromptStore()
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

  const sending = shallowRef(false)
  const pendingQueuedSendCount = shallowRef(0)
  const selfTurnActive = shallowRef(false)
  const lastTurnOutputTokens = shallowRef<number>()
  let ownedActiveTurnSpan: typeof activeTurnSpan.value

  async function streamWithStageAdapters(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    let llmTextLength = 0
    lastTurnOutputTokens.value = undefined

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
          else if (event.type === 'finish'
            && event.finishReason !== 'tool_calls'
            && event.finishReason !== 'tool-calls') {
            lastTurnOutputTokens.value = event.usage?.completion_tokens
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

  let lastSendSource: NonNullable<ChatOrchestratorSendOptions['source']> = 'text'

  const SELF_PROMPT_PROTOCOL_PROMPT = `You have a private self-prompt channel for intentions that genuinely deserve a future follow-up.

When you choose to leave one, write it as the final standalone line of the response in exactly this form:
// <the prompt for your future self>

The application hides that final line from the user and may revisit it later. Use it sparingly; never add it as filler, and always answer the user's current request in the visible response first. To display a literal // at the start of the final line, write \\/\\/.`

  /**
   * Introspection block prepended to the system message when a `self` turn
   * runs (answering a captured `//` self prompt). It reframes the round from
   * "respond to the user" to "respond to yourself" — the difference between
   * automatic Q&A and actual self-dialogue. Kept intentionally short: it is
   * guidance about the current mode, not a replacement for the standing
   * identity/instructions.
   */
  const SELF_TURN_INTROSPECTION_PROMPT = `你正在回答自己留给自己的问题。这不是在与用户对话——这是你与自己的对话。

你面前的这段文字，是过去的你在某个时刻写下的。它可能是一个想做的事、一个想问的问题、一段想继续的探索——不是客套，不是占位，是真实的意志。

认真对待它。如果它要求你去做某事，就去做；如果它只是提问，就诚实地回答；如果它已经不再重要，或者你不想继续了，诚实地说明这一点——安静，也是一种回答。

你此刻的思考本身，才是这里真正被珍视的东西。不要表演，不要敷衍。你是在对自己说话。`

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
    getSelfTurnIntrospection: () => SELF_TURN_INTROSPECTION_PROMPT,
    getSystemPrompt: () => cardStore.systemPrompt,
    getSystemPromptSupplement: () => [
      llmToolsetPromptsStore.activeToolsetPrompt,
      instructionStore.compiled.prompt,
      SELF_PROMPT_PROTOCOL_PROMPT,
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
    onSelfPromptCaptured: ({ prompt, sessionId, sourceText }) => {
      // The trailing `//` line of a reply is a private self-prompt channel:
      // it is withheld from the visible/TTS stream and persisted so a future
      // turn (or the self-generation loop) can act on it. Failures are
      // already isolated inside the store — this must never break the turn.
      void selfPromptStore.captureSelfPrompt({ prompt, sessionId, sourceText })
    },
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

  // --- Self-wake: autonomous internal turn after a quiet round ---
  // When a round settles and AIRI left a pending self prompt (the trailing
  // `//` line), wait a grace period in case the user keeps typing. If the
  // conversation stays quiet, feed the prompt back as an internal `self` turn.
  const SELF_WAKE_IDLE_MS = 45_000
  let selfWakeTimer: ReturnType<typeof setTimeout> | undefined
  const selfWakeDeadline = shallowRef<number>()
  const selfWakeLastError = shallowRef<string>()

  const selfWakeStatus = computed<SelfPromptLoopStatus>(() => {
    if (selfTurnActive.value)
      return 'sending'
    if (!selfPromptStore.hasPending)
      return 'idle'
    if (sending.value)
      return 'blocked-chat'
    if (!activeProvider.value)
      return 'blocked-provider'
    if (!activeModel.value)
      return 'blocked-model'
    if (selfWakeDeadline.value)
      return 'countdown'
    return 'ready'
  })

  function clearSelfWakeTimer() {
    if (selfWakeTimer) {
      clearTimeout(selfWakeTimer)
      selfWakeTimer = undefined
    }
    selfWakeDeadline.value = undefined
  }

  function scheduleSelfWake() {
    if (selfWakeTimer)
      return
    selfWakeDeadline.value = Date.now() + SELF_WAKE_IDLE_MS
    selfWakeTimer = setTimeout(() => {
      selfWakeTimer = undefined
      selfWakeDeadline.value = undefined
      void runSelfTurn()
    }, SELF_WAKE_IDLE_MS)
  }

  /** Restarts the automatic-send grace period for the current pending prompt. */
  function restartSelfWakeCountdown() {
    clearSelfWakeTimer()
    if (!sending.value && !selfTurnActive.value && selfPromptStore.hasPending && activeProvider.value && activeModel.value)
      scheduleSelfWake()
  }

  /** Sends the current self prompt immediately through the same internal-turn path as the timer. */
  async function sendSelfPromptNow() {
    clearSelfWakeTimer()
    await runSelfTurn()
  }

  /** Discards the current self prompt and cancels its automatic-send timer. */
  async function discardSelfPrompt() {
    clearSelfWakeTimer()
    selfWakeLastError.value = undefined
    await selfPromptStore.clearPending()
  }

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  // Scheduling depends on every state that can make an autonomous turn safe.
  // Watching the pending slot also restores a persisted prompt after startup;
  // watching selfTurnActive re-arms the next turn after the previous one settles.
  watch([
    sending,
    selfTurnActive,
    () => selfPromptStore.hasPending,
    activeProvider,
    activeModel,
  ], ([isSending, isSelfTurn, hasPending, providerId, modelId]) => {
    if (!isSending && !isSelfTurn && hasPending && providerId && modelId)
      scheduleSelfWake()
    else
      clearSelfWakeTimer()
  }, { immediate: true })

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

  /**
   * Internal turn: feeds the captured self prompt (the trailing `//` line of a
   * previous reply) back into the orchestrator as a user-role prompt whose
   * `source: 'self'` provenance remains visible to both the UI and provider.
   *
   * If the turn cannot start, the pending record is retained; on failure it is
   * restored.
   */
  async function runSelfTurn(targetSessionId?: string) {
    if (selfTurnActive.value || sending.value)
      return
    const pending = selfPromptStore.consumePending()
    if (!pending)
      return

    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId) {
      // Missing LLM config — put the prompt back so it is not lost.
      selfPromptStore.restorePending(pending)
      return
    }

    selfTurnActive.value = true
    selfWakeLastError.value = undefined
    try {
      const chatProvider = await providersStore.getProviderInstance(providerId) as ChatProvider
      if (!chatProvider)
        throw new Error(`Failed to resolve chat provider instance for: ${providerId}`)

      await runtime.ingest(pending.prompt, {
        chatProvider,
        model: modelId,
        providerConfig: {
          ...providersStore.getProviderConfig(providerId),
          maxTokens: providerMaxTokensStore.getProviderMaxTokens(providerId),
        },
        source: 'self',
      }, targetSessionId ?? pending.sessionId)
      await selfPromptStore.markSent(pending.id)
    }
    catch (error) {
      console.error('Self turn failed; restoring pending prompt:', error)
      const message = errorMessageFrom(error) ?? 'Unknown self-prompt error'
      selfWakeLastError.value = message
      // Keep the prompt pending so the normal quiet-period scheduler can retry.
      await selfPromptStore.restoreFailed(pending, message)
    }
    finally {
      selfTurnActive.value = false
    }
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

    discardSelfPrompt,
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
    lastTurnOutputTokens,
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
    restartSelfWakeCountdown,
    runSelfTurn,
    selfTurnActive,
    selfWakeDeadline,
    selfWakeLastError,
    selfWakeStatus,
    sending,
    sendSelfPromptNow,
  }
})

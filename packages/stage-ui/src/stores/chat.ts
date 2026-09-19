import type {
  AgentToolExecutionProjection,
  AgentTurnCancellationReason,
  ChatOrchestratorRuntimeState,
  ChatOrchestratorSendOptions,
  StreamEvent,
  StreamOptions,
} from '@proj-airi/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'

import {
  createChatOrchestratorRuntime,
  projectSessionMessages,
  projectUnsettledToolExecutions,
} from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { onScopeDispose, shallowRef, toRaw, watch } from 'vue'

import { useAnalytics } from '../composables'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import { extractMessageText, isCloudSyncableMessage } from '../libs/chat-sync'
import { projectChatMemoryFromEvents } from './chat-memory-projection'
import {
  createChatSessionEventPort,
  createImportedMessageEvents,
  importChatSessionMessages,
  readChatSessionEvents,
} from './chat-session-events'
import { createChatToolExecutionControlPort } from './chat-tool-executions'
import {
  acknowledgeChatTurnRecovery,
  configureChatTurnCancellationHandler,
  createChatTurnControlPort,
  listChatTurns,
  readChatTurnStatus,
  requestChatTurnCancellation,
} from './chat-turn-control'
import { recoverInterruptedChatTurns } from './chat-turn-recovery'
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
import { useMemoryShortTermStore } from './modules/memory-short-term'
import { useSkillStore } from './modules/skill-store'
import { useWorkspaceStore } from './modules/workspace'

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
  const shortTermMemoryStore = useMemoryShortTermStore()
  const instructionStore = useInstructionStore()
  const skillStore = useSkillStore()
  const workspaceStore = useWorkspaceStore()
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
  const { activeSessionId, ready: chatSessionReady } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = shallowRef(false)
  const pendingQueuedSendCount = shallowRef(0)
  const lastTurnOutputTokens = shallowRef<number>()
  const unsettledToolExecutions = shallowRef<AgentToolExecutionProjection[]>([])
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

  function scheduleMemoryProjection(sessionId: string) {
    void projectChatMemoryFromEvents(sessionId).catch((error) => {
      // The session log remains authoritative. A failed adapter or cursor
      // commit is retried from the last successful projection on activation
      // or after the next settled turn.
      console.warn(`Failed to project Agent session memory for ${sessionId}:`, error)
    })
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

  const runtime = createChatOrchestratorRuntime({
    context: {
      ingest: envelope => chatContext.ingestContextMessage(envelope),
      snapshot: () => chatContext.getContextsSnapshot(),
    },
    // Long sessions are folded to fit the model window before dispatch: older
    // tool results shrink first, then the oldest turns collapse into one
    // summary. The budget is a character estimate targeting a ~32k token
    // window; once the provider catalog exposes real context sizes this can be
    // derived per model instead of fixed here.
    contextBudget: {
      maxCharacters: 120_000,
      recentTurnLimit: 6,
      toolResultCharacterLimit: 240,
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
      skillStore.promptListing,
      workspaceStore.promptLine,
    ].filter((value): value is string => !!value).join('\n\n'),
    llm: {
      stream: streamWithStageAdapters,
    },
    memory: {
      async recall(sessionId, query) {
        void query
        return await shortTermMemoryStore.recallPrompt(sessionId)
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
    onSendSettled: ({ sessionId }) => {
      settleOwnedActiveTurnSpan()
      scheduleMemoryProjection(sessionId)
      void refreshUnsettledToolExecutions(sessionId)
    },
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
    sessionEvents: createChatSessionEventPort(),
    toolExecutionControl: createChatToolExecutionControlPort(),
    turnControl: createChatTurnControlPort(),
    unwrapMessage: message => toRaw(message),
  })

  const disposeTurnCancellationHandler = configureChatTurnCancellationHandler((notice) => {
    const activeTurn = runtime.getActiveTurn()
    if (activeTurn?.sessionId === notice.sessionId && activeTurn.turnId === notice.turnId)
      runtime.cancelActiveTurn(notice.turnId)
  })
  onScopeDispose(disposeTurnCancellationHandler)

  async function reconcileSessionMessagesFromEvents(sessionId: string) {
    const events = await readChatSessionEvents({ sessionId }, runtime.getSessionEvents(sessionId))
    const projected = projectSessionMessages(events)
    if (projected.length === 0)
      return

    const projectedById = new Map(projected.flatMap(message => message.id ? [[message.id, message] as const] : []))
    const used = new Set<string>()
    const current = chatSession.getSessionMessages(sessionId)
    const reconciled = current.map((message) => {
      if (!message.id)
        return message
      const replacement = projectedById.get(message.id)
      if (!replacement)
        return message
      used.add(message.id)
      return replacement
    })
    for (const message of projected) {
      if (!message.id || !used.has(message.id))
        reconciled.push(message)
    }
    chatSession.setSessionMessages(sessionId, reconciled)
  }

  watch([activeSessionId, chatSessionReady], async ([sessionId, ready], _previous, onCleanup) => {
    if (!sessionId || !ready)
      return

    let stale = false
    onCleanup(() => {
      stale = true
    })

    await chatSession.loadSession(sessionId)
    if (stale || !chatSession.isSessionLoaded(sessionId))
      return

    const existingEvents = await readChatSessionEvents({ sessionId }, runtime.getSessionEvents(sessionId))
    // IndexedDB is only a bootstrap source for sessions that have never had
    // authoritative message events. Re-importing a compacted session would
    // otherwise recreate its archived history on every renderer startup.
    if (!existingEvents.some(event => event.type === 'message.appended')) {
      await importChatSessionMessages(createImportedMessageEvents(
        sessionId,
        chatSession.getSessionMessages(sessionId).map(message => toRaw(message)),
        'import',
      ))
    }
    if (stale)
      return

    await reconcileSessionMessagesFromEvents(sessionId)
    if (stale)
      return

    try {
      await recoverInterruptedChatTurns(sessionId, {
        acknowledge: acknowledgeChatTurnRecovery,
        append: (targetSessionId, message) => chatSession.appendSessionMessageDurably(targetSessionId, message),
        getMessages: targetSessionId => chatSession.getSessionMessages(targetSessionId),
        list: listChatTurns,
        onRecovered: async (message) => {
          const isAuthoredMessage = message.role === 'assistant' || message.role === 'user'
          if (isAuthoredMessage && isCloudSyncableMessage(message) && message.id) {
            await chatSession.pushMessageToCloud(sessionId, {
              content: extractMessageText(message),
              id: message.id,
              role: message.role,
            })
          }
        },
        shouldContinue: () => !stale,
      })
    }
    catch (error) {
      // Leave the main-process recovery record unacknowledged so a later
      // session activation can retry after transient IndexedDB/IPC failures.
      console.error(`Failed to recover interrupted Agent turns for session ${sessionId}:`, error)
    }
  }, { immediate: true })

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  watch([activeSessionId, chatSessionReady], ([sessionId, ready]) => {
    if (!ready || !sessionId)
      return
    scheduleMemoryProjection(sessionId)
    void refreshUnsettledToolExecutions(sessionId)
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

  function cancelPendingSends(sessionId?: string) {
    runtime.cancelPendingSends(sessionId)
  }

  function cancelActiveSend(sessionId?: string, reason: AgentTurnCancellationReason = 'user') {
    const activeTurn = runtime.getActiveTurn()
    if (activeTurn && (!sessionId || activeTurn.sessionId === sessionId)) {
      void requestChatTurnCancellation({
        reason,
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
      })
    }
    return runtime.cancelActiveSend(sessionId)
  }

  function getPendingQueuedSendSnapshot() {
    return runtime.getPendingQueuedSendSnapshot()
  }

  function getSessionEvents(sessionId: string, afterSequence?: number) {
    return readChatSessionEvents(
      { afterSequence, sessionId },
      runtime.getSessionEvents(sessionId, afterSequence),
    )
  }

  function getTurnStatus(sessionId: string, turnId?: string) {
    return readChatTurnStatus({ sessionId, turnId })
  }

  function getRecoverableTurns(sessionId?: string) {
    return listChatTurns({ recoverableOnly: true, sessionId })
  }

  async function refreshUnsettledToolExecutions(sessionId: string) {
    const events = await readChatSessionEvents({ sessionId }, runtime.getSessionEvents(sessionId))
    if (activeSessionId.value === sessionId)
      unsettledToolExecutions.value = projectUnsettledToolExecutions(events)
  }

  return {
    cancelActiveSend,
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
    getRecoverableTurns,
    getSessionEvents,
    getTurnStatus,
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
    sending,
    unsettledToolExecutions,
  }
})

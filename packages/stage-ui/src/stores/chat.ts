import type {
  AgentScheduleDueNotice,
  AgentScheduleGoalRef,
  AgentToolExecutionProjection,
  AgentTurnCancellationReason,
  AgentUnfinishedSelfTurnProjection,
  ChatOrchestratorRuntimeState,
  ChatOrchestratorSendOptions,
  StreamEvent,
  StreamOptions,
} from '@proj-airi/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'
import type { PendingSelfPrompt } from './modules/self-prompt'

import { errorMessageFrom } from '@moeru/std'
import {
  createChatOrchestratorRuntime,
  projectSessionMessages,
  projectUnfinishedSelfTurns,
  projectUnsettledToolExecutions,
} from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed, onScopeDispose, shallowRef, toRaw, watch } from 'vue'

import { useAnalytics } from '../composables'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import { extractMessageText, isCloudSyncableMessage } from '../libs/chat-sync'
import { resolveChatAutonomousTools } from './chat-autonomous-tools'
import {
  claimChatSchedule,
  getChatAutonomy,
  settleChatSchedule,
  transitionChatGoal,
} from './chat-autonomy'
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
  const { activeSessionId, ready: chatSessionReady } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = shallowRef(false)
  const pendingQueuedSendCount = shallowRef(0)
  const selfTurnActive = shallowRef(false)
  const lastTurnOutputTokens = shallowRef<number>()
  const unfinishedSelfTurns = shallowRef<AgentUnfinishedSelfTurnProjection[]>([])
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
    onSelfPromptCaptured: ({ prompt, sessionId, sourceText }) => {
      // The trailing `//` line of a reply is a private self-prompt channel:
      // it is withheld from the visible/TTS stream and persisted so a future
      // turn (or the self-generation loop) can act on it. Failures are
      // already isolated inside the store — this must never break the turn.
      void selfPromptStore.captureSelfPrompt({ prompt, sessionId, sourceText })
    },
    onSendSettled: ({ sessionId }) => {
      settleOwnedActiveTurnSpan()
      scheduleMemoryProjection(sessionId)
      void refreshUnfinishedSelfTurns(sessionId)
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

  // The renderer exposes Schedule state but owns no wake timer. Electron main
  // persists and drives after/at/every rules, then redelivers a due occurrence
  // until the chat authority atomically claims it.
  const selfWakeDeadline = computed(() => selfPromptStore.pendingPrompt?.scheduledAt)
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

  /** Replaces the durable wake rule with a fresh 45-second `after` schedule. */
  async function restartSelfWakeCountdown() {
    selfWakeLastError.value = undefined
    await selfPromptStore.restartWake()
  }

  /** Sends the current self prompt immediately through the ordinary self-turn path. */
  async function sendSelfPromptNow() {
    const pending = selfPromptStore.pendingPrompt
    if (!pending)
      return
    await selfPromptStore.cancelWake(pending)
    const goal = await admitManualGoalRound(pending)
    const completed = await runSelfTurn(undefined, pending)
    if (completed)
      await completeGoalIfCurrent(pending.sessionId, goal)
    else
      await blockGoalIfCurrent(pending.sessionId, goal, selfWakeLastError.value)
  }

  /** Discards the current self prompt and cancels its durable schedule. */
  async function discardSelfPrompt() {
    selfWakeLastError.value = undefined
    await selfPromptStore.clearPending()
  }

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  watch([activeSessionId, chatSessionReady], ([sessionId, ready]) => {
    if (!ready || !sessionId)
      return
    void selfPromptStore.restoreFromAutonomy(sessionId).catch((error) => {
      console.warn(`Failed to restore Self Prompt autonomy for session ${sessionId}:`, error)
    })
    scheduleMemoryProjection(sessionId)
    void refreshUnfinishedSelfTurns(sessionId)
  }, { immediate: true })

  async function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    return runtime.ingest(sendingMessage, options, targetSessionId)
  }

  /** Continues one interrupted self turn as a new, explicitly linked execution. */
  async function resumeUnfinishedSelfTurn(turnId: string) {
    const thought = unfinishedSelfTurns.value.find(item => item.turnId === turnId && item.state === 'open')
    if (!thought)
      throw new Error(`Unfinished self turn ${turnId} is unavailable or already resumed`)
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId)
      throw new Error('Chat provider and model must be configured before resuming self-directed work')

    const chatProvider = await providersStore.getProviderInstance(providerId) as ChatProvider
    if (!chatProvider)
      throw new Error(`Failed to resolve chat provider instance for: ${providerId}`)

    await runtime.ingest(thought.text, {
      chatProvider,
      model: modelId,
      providerConfig: {
        ...providersStore.getProviderConfig(providerId),
        maxTokens: providerMaxTokensStore.getProviderMaxTokens(providerId),
      },
      resumesTurnId: thought.turnId,
      source: 'self',
      tools: resolveChatAutonomousTools,
    }, thought.sessionId)
    await refreshUnfinishedSelfTurns(thought.sessionId)
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
  async function runSelfTurn(targetSessionId?: string, supplied?: PendingSelfPrompt): Promise<boolean> {
    if (selfTurnActive.value || sending.value)
      return false
    const pending = supplied ?? selfPromptStore.pendingPrompt
    if (!pending)
      return false
    selfPromptStore.consumePending(pending.scheduleId)

    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId) {
      // Missing LLM config — put the prompt back so it is not lost.
      selfPromptStore.restorePending(pending)
      selfWakeLastError.value = !providerId ? 'Chat provider is not configured' : 'Chat model is not configured'
      return false
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
        tools: resolveChatAutonomousTools,
      }, targetSessionId ?? pending.sessionId)
      return true
    }
    catch (error) {
      console.error('Self turn failed; restoring pending prompt:', error)
      const message = errorMessageFrom(error) ?? 'Unknown self-prompt error'
      selfWakeLastError.value = message
      // Keep the prompt pending so the normal quiet-period scheduler can retry.
      await selfPromptStore.restoreFailed(pending, message)
      return false
    }
    finally {
      selfTurnActive.value = false
    }
  }

  /** Claims and executes one persisted due occurrence as an ordinary chat turn. */
  async function handleScheduleDue(notice: AgentScheduleDueNotice) {
    if (selfTurnActive.value || sending.value)
      return

    const schedule = await claimChatSchedule(notice)
    if (!schedule || !schedule.dispatchId)
      return

    const cached = selfPromptStore.pendingPrompt?.scheduleId === schedule.id
      ? selfPromptStore.pendingPrompt
      : undefined
    const pending: PendingSelfPrompt = cached ?? {
      capturedAt: new Date(schedule.createdAt).toISOString(),
      createdAt: schedule.createdAt,
      goalId: schedule.goal?.id,
      goalRevision: schedule.goal?.revision,
      id: `schedule:${schedule.id}`,
      prompt: schedule.prompt,
      scheduledAt: schedule.scheduledAt,
      scheduleId: schedule.id,
      sessionId: notice.sessionId,
      sourceText: '',
    }
    const completed = await runSelfTurn(notice.sessionId, pending)
    const error = selfWakeLastError.value ?? 'Scheduled self turn could not start'

    await settleChatSchedule({
      dispatchId: schedule.dispatchId,
      ...(completed ? {} : { error }),
      scheduleId: schedule.id,
      sessionId: notice.sessionId,
      status: completed ? 'completed' : 'failed',
    })
    if (completed)
      await completeGoalIfCurrent(notice.sessionId, schedule.goal)
    else
      await blockGoalIfCurrent(notice.sessionId, schedule.goal, error)
  }

  async function admitManualGoalRound(pending: PendingSelfPrompt): Promise<AgentScheduleGoalRef | undefined> {
    let goal = (await getChatAutonomy({ sessionId: pending.sessionId })).goal
    if (!goal || (pending.goalId && goal.id !== pending.goalId))
      return undefined
    if (goal.phase === 'paused' || goal.phase === 'blocked') {
      goal = await transitionChatGoal({
        goalId: goal.id,
        revision: goal.revision,
        sessionId: pending.sessionId,
        transition: 'resume',
      })
    }
    if (goal.phase !== 'active' || goal.rounds >= goal.maxRounds)
      throw new Error(`Goal ${goal.id} cannot admit another self-directed round`)
    goal = await transitionChatGoal({
      goalId: goal.id,
      revision: goal.revision,
      sessionId: pending.sessionId,
      transition: 'round',
    })
    return { id: goal.id, revision: goal.revision }
  }

  async function completeGoalIfCurrent(sessionId: string, expected?: AgentScheduleGoalRef) {
    if (!expected)
      return
    const goal = (await getChatAutonomy({ sessionId })).goal
    if (!goal || goal.id !== expected.id || goal.revision !== expected.revision || goal.phase === 'complete')
      return
    await transitionChatGoal({
      goalId: goal.id,
      revision: goal.revision,
      sessionId,
      transition: 'complete',
    })
  }

  async function blockGoalIfCurrent(sessionId: string, expected: AgentScheduleGoalRef | undefined, message?: string) {
    if (!expected)
      return
    const goal = (await getChatAutonomy({ sessionId })).goal
    if (!goal || goal.id !== expected.id || goal.revision !== expected.revision || goal.phase !== 'active')
      return
    await transitionChatGoal({
      blockedReason: {
        code: 'scheduled-turn-failed',
        message: message ?? 'Scheduled continuation failed',
      },
      goalId: goal.id,
      revision: goal.revision,
      sessionId,
      transition: 'block',
    })
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

  async function refreshUnfinishedSelfTurns(sessionId: string) {
    const events = await readChatSessionEvents({ sessionId }, runtime.getSessionEvents(sessionId))
    if (activeSessionId.value === sessionId) {
      unfinishedSelfTurns.value = projectUnfinishedSelfTurns(events)
      unsettledToolExecutions.value = projectUnsettledToolExecutions(events)
    }
  }

  return {
    cancelActiveSend,
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
    getRecoverableTurns,
    getSessionEvents,
    getTurnStatus,
    handleScheduleDue,
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
    resumeUnfinishedSelfTurn,
    runSelfTurn,
    selfTurnActive,
    selfWakeDeadline,
    selfWakeLastError,
    selfWakeStatus,
    sending,
    sendSelfPromptNow,
    unfinishedSelfTurns,
    unsettledToolExecutions,
  }
})

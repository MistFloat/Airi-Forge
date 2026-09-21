import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { AgentContextPort } from '../contracts/context-port'
import type { AgentForegroundStreamPort } from '../contracts/stream-port'
import type { AgentToolExecutionControlPort } from '../contracts/tool-execution-control-port'
import type { AgentTurnCheckpointInput, AgentTurnControlPort } from '../contracts/turn-control-port'
import type { ContextBudgetOptions } from '../messages/context-budget'
import type { AgentSessionEvent, AgentSessionEventPort } from '../session/events'
import type { ChatAssistantMessage, ChatHistoryItem, ChatSlices, ChatStreamEventContext, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from '../types/llm'

import { createQueue } from '@proj-airi/stream-kit'

import { compactProviderMessages } from '../messages/context-budget'
import { formatContextPromptText } from '../messages/context-prompt'
import { formatTimePrefix } from '../messages/datetime-prefix'
import { AgentSessionEventLog, normalizeAgentSessionJsonValue } from '../session/events'
import { errorMessageFromValue } from '../utils/error-message'
import { createChatHooks } from './agent-hooks'
import { useLlmmarkerParser } from './llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from './response-categoriser'

const STREAMING_UI_FLUSH_CHUNK_SIZE = 24

/**
 * Shortest interval between two durable recovery checkpoints of one turn.
 *
 * A checkpoint REPLACES the previous one (`AgentTurnControlPort.checkpoint`), so
 * persisting one per stream delta wrote superseded copies of the same prefix.
 * Measured on a real session: two turns produced 5,795 checkpoints and ~460 MB
 * of dead snapshots in under six minutes, which exhausted the main-process heap
 * and killed the app. Writing the trailing edge instead costs one write per
 * interval, and a crash still recovers an almost-current prefix.
 */
const CHECKPOINT_MIN_INTERVAL_MS = 1000

/**
 * Longest reasoning prefix carried by a recovery checkpoint.
 *
 * `reasoningText` is optional recovery context (`AgentTurnCheckpointInput`); the
 * visible prefix is what a recovered message needs. An untruncated reasoning
 * stream is what turned one checkpoint into a 165 KB record: on the session
 * above, the reasoning text was 159,000 of those characters. Keeping the head
 * matches the field's own contract, which calls it a prefix.
 */
const CHECKPOINT_REASONING_LIMIT = 8000

/**
 * Lifecycle record emitted around prompt composition.
 */
export interface ChatOrchestratorLifecycleRecord {
  /** Logical event channel for context observability. */
  channel: 'chat'
  /** Phase-specific payload for devtools and diagnostics. */
  details?: unknown
  /** Composition phase being observed. */
  phase: 'after-compose' | 'before-compose' | 'prompt-context-built'
  /** Session associated with this send. */
  sessionId: string
  /** Optional compact preview of the user text. */
  textPreview?: string
}

/**
 * LLM streaming boundary used by the core chat orchestrator runtime.
 */
export interface ChatOrchestratorLLMPort {
  /** Streams one composed chat request and emits normalized stream events. */
  stream: (model: string, chatProvider: ChatProvider, messages: Message[], options?: StreamOptions) => Promise<void>
}

/** Memory boundary used only to recall a projection of prior session events. */
export interface ChatOrchestratorMemoryPort {
  /** Returns prompt-ready memory scoped to the active conversation. */
  recall: (sessionId: string, query: string) => Promise<string | undefined>
}

/**
 * Prompt projection emitted after the runtime has composed provider messages.
 */
export interface ChatOrchestratorPromptProjection {
  /** Provider-ready message array sent to the LLM port. */
  composedMessage?: Message[]
  /** Active context snapshot read during prompt composition. */
  contexts: Record<string, ContextMessage[]>
  /** Raw user message text that triggered the prompt. */
  message: string
  /** Historical standalone context prompt shape, kept for compatibility. */
  promptMessage?: Message | null
  /** Session associated with the projected prompt. */
  sessionId: string
}

/**
 * Platform-agnostic chat orchestrator runtime API.
 */
export interface ChatOrchestratorRuntime {
  /** Aborts the provider request and tools owned by the active send. */
  cancelActiveSend: (sessionId?: string) => boolean
  /** Aborts the active execution only when its exact turn key matches. */
  cancelActiveTurn: (turnId: string) => boolean
  /** Rejects queued sends that have not started yet. */
  cancelPendingSends: (sessionId?: string) => void
  /** Returns correlation keys for the active renderer execution. */
  getActiveTurn: () => undefined | { sessionId: string, turnId: string }
  /** Returns the current queued send count. */
  getPendingQueuedSendCount: () => number
  /** Returns serializable snapshots of currently queued sends. */
  getPendingQueuedSendSnapshot: () => QueuedSendSnapshot[]
  /** Reads the writable sending flag. */
  getSending: () => boolean
  /** Returns ordered runtime events after an optional per-session cursor. */
  getSessionEvents: (sessionId: string, afterSequence?: number) => AgentSessionEvent[]
  /** Hook registry preserved from the previous stage-ui store API. */
  hooks: ReturnType<typeof createChatHooks>
  /** Enqueues a user send for the target session, preserving FIFO order. */
  ingest: (sendingMessage: string, options: ChatOrchestratorSendOptions, targetSessionId?: string) => Promise<void>
  /** Updates the writable sending flag and notifies facade mirrors. */
  setSending: (next: boolean) => void
}

/**
 * Dependency surface used by the platform-agnostic chat orchestrator runtime.
 */
export interface ChatOrchestratorRuntimeDeps {
  /** Context registry facade used for runtime context ingest and prompt snapshots. */
  context: Pick<AgentContextPort, 'ingest' | 'snapshot'>
  /**
   * Prompt budget applied to the assembled provider messages.
   *
   * When omitted, assembled history is sent as-is and long sessions rely on the
   * provider to accept them. Supplying a budget enables the tiered compaction
   * policy (tool-result truncation, then folding the oldest turns into a
   * summary) documented in `messages/context-budget`.
   */
  contextBudget?: ContextBudgetOptions
  /** ID factory used for persisted chat messages. @default crypto.randomUUID fallback */
  createId?: () => string
  /** Foreground assistant stream port controlled by the UI facade. */
  foregroundStream: AgentForegroundStreamPort
  /** Returns the currently active provider ID for categorization policy. */
  getActiveProvider: () => string | undefined
  /** Returns the currently visible session ID. */
  getActiveSessionId: () => string
  /** Returns the active character card's system prompt (identity) for this send. */
  getSystemPrompt?: () => string | undefined
  /** Returns optional prompt text appended to the provider system message for this send. */
  getSystemPromptSupplement?: () => string | undefined
  /** Provider-agnostic LLM streaming port. */
  llm: ChatOrchestratorLLMPort
  /** Optional memory integration; failures are isolated from the chat request. */
  memory?: ChatOrchestratorMemoryPort
  /** Monotonic clock used for elapsed telemetry in milliseconds. @default performance.now */
  monotonicNow?: () => number
  /** Clock used for persisted message timestamps. @default Date.now */
  now?: () => number
  /** Called after the assistant message has been finalized into session history. */
  onAssistantMessageAppended?: (event: {
    message: StreamingAssistantMessage
    messageText: string
    sessionId: string
  }) => void
  /** Called after the assistant stream is parsed and rendered into runtime state. */
  onAssistantResponseRendered?: (event: ChatRoundCorrelation & {
    latencyMs: number
    model: string
  }) => void
  /** Called after assistant streaming and hook finalization. */
  onAssistantTurnReady?: (event: {
    messageText: string
    sessionMessages: ChatHistoryItem[]
  }) => void
  /** Called when a pre-activation attempt fails before assistant completion. */
  onChatActivationFailed?: (event: ChatRoundCorrelation & {
    errorCode: 'llm_response_failed'
    failureStage: 'llm_response'
    model: string
    provider: string
    source: 'text' | 'voice'
  }) => void
  /** Called for attempts made before the conversation has its first assistant response. */
  onChatActivationStarted?: (event: ChatRoundCorrelation & {
    model: string
    provider: string
    source: 'text' | 'voice'
  }) => void
  /** Called when the conversation reaches its first successful assistant response. */
  onChatActivationSucceeded?: (event: ChatRoundCorrelation & {
    durationMs: number
    model: string
    provider: string
    source: 'text' | 'voice'
  }) => void
  /** Called for context/prompt lifecycle observability. */
  onLifecycle?: (record: ChatOrchestratorLifecycleRecord) => void
  /** Called when the first text token arrives from the provider stream. */
  onLlmFirstToken?: (event: ChatRoundCorrelation & {
    model: string
    ttfbMs: number
  }) => void
  /** Called immediately before the provider LLM request starts. */
  onLlmRequestStarted?: (event: ChatRoundCorrelation & {
    hasVoice: boolean
    model: string
    provider: string
  }) => void
  /** Called after one user-to-assistant message round completes successfully. */
  onMessageRound?: (event: ChatRoundCorrelation & {
    durationMs: number
    hasVoice: boolean
    model: string
  }) => void
  /** Called whenever a user-to-assistant round fails before completion. */
  onMessageRoundFailed?: (event: ChatRoundCorrelation & {
    errorCode: 'llm_response_failed'
    failureStage: 'llm_response'
    model: string
    provider: string
    source: 'text' | 'voice'
  }) => void
  /** Called when a user message send begins. */
  onMessageSendStarted?: (event: ChatRoundCorrelation & {
    model: string
    source: 'text' | 'voice'
  }) => void
  /** Called with the final provider prompt projection. */
  onPromptProjection?: (payload: ChatOrchestratorPromptProjection) => void
  /** Called after a runtime-owned send completes or fails and `sending` has been cleared. */
  onSendSettled?: (event: { sessionId: string }) => void
  /** Called whenever writable runtime state changes. */
  onStateChange?: (state: ChatOrchestratorRuntimeState) => void
  /** Called when a send starts and the first assistant placeholder is created. */
  onTrackFirstMessage?: () => void
  /** Called after the user message has been appended to session history. */
  onUserMessageAppended?: (event: {
    message: Extract<ChatHistoryItem, { role: 'user' }> & { id: string }
    messageText: string
    model: string
    provider: string
    roundId: string
    sessionId: string
    source: 'text' | 'voice'
    turnIndex: number
  }) => void
  /** Called after user turn persistence, before provider prompt composition. */
  onUserTurnReady?: (event: {
    messageText: string
    sessionMessages: ChatHistoryItem[]
  }) => void
  /** Runtime context providers ingested immediately before prompt composition. */
  runtimeContextProviders?: Array<() => ContextMessage | null | undefined>
  /** Session persistence and generation guard port. */
  session: ChatOrchestratorSessionPort
  /** Session event storage/query boundary. @default in-process event log */
  sessionEvents?: AgentSessionEventPort
  /** Optional host owner that atomically prevents duplicate tool side effects. */
  toolExecutionControl?: AgentToolExecutionControlPort
  /** Optional platform owner for durable turn admission and recovery checkpoints. */
  turnControl?: AgentTurnControlPort
  /** Optional adapter for removing framework proxies before provider composition. */
  unwrapMessage?: <T>(message: T) => T
}

/**
 * Reactive state mirrored by UI facades.
 */
export interface ChatOrchestratorRuntimeState {
  /** Number of sends waiting behind the active one. */
  pendingQueuedSendCount: number
  /** Whether the runtime currently owns an active send. */
  sending: boolean
}

/**
 * Options accepted by the chat orchestrator runtime for one user send.
 */
export interface ChatOrchestratorSendOptions {
  /** Image attachments appended to the user message content parts. */
  attachments?: { data: string, mimeType: string, type: 'image' }[]
  /** Concrete chat provider implementation selected by the caller. */
  chatProvider: ChatProvider
  /** Original transport input metadata used by bridge/devtools observers. */
  input?: ChatStreamEventContext['input']
  /** Provider model identifier used for the outbound LLM request. */
  model: string
  /** Provider-specific request options, including headers and output-token limits. */
  providerConfig?: Record<string, unknown>
  /**
   * Send origin classification. Defaults to `voice` when `input` is present,
   * otherwise `text`.
   */
  source?: 'text' | 'voice'
  /** Tool definitions passed through to the LLM stream port. */
  tools?: StreamOptions['tools']
}

/**
 * Session operations required by the core chat orchestrator runtime.
 */
export interface ChatOrchestratorSessionPort {
  /** Appends a finalized user/assistant/tool history item. */
  appendSessionMessage: (sessionId: string, message: ChatHistoryItem) => void
  /** Ensures a session exists before messages are appended. */
  ensureSession: (sessionId: string) => void
  /** Returns a monotonic generation used to reject stale queued sends. */
  getSessionGeneration: (sessionId: string) => number
  /** Returns chronological chat history for a session. */
  getSessionMessages: (sessionId: string) => ChatHistoryItem[]
}

/**
 * Serializable view of a queued send waiting to be processed.
 */
export interface QueuedSendSnapshot {
  /** Whether the queued send has been rejected before execution. */
  cancelled: boolean
  /** Session generation captured when the send was enqueued. */
  generation: number
  /** Whether the queued send carries image attachments. */
  hasAttachments: boolean
  /** Optional input event type for transport-originated sends. */
  inputType?: NonNullable<ChatStreamEventContext['input']>['type']
  /** First 120 characters of the pending user message. */
  messagePreview: string
  /** Session that owns the queued send. */
  sessionId: string
}

interface ActiveSend {
  /** Cancellation source passed through the LLM port to provider and tool work. */
  abortController: AbortController
  /** Session that owns the running send. */
  sessionId: string
  /** Correlation key used to isolate remote cancellation requests. */
  turnId: string
}

/** Correlation keys shared by every analytics milestone from one user-to-assistant round. */
interface ChatRoundCorrelation {
  /** Application conversation that owns the round. */
  conversationId: string
  /** Stable round key; the runtime reuses the persisted user-message ID. */
  roundId: string
  /** One-based user turn position within the conversation. */
  turnIndex: number
}

interface QueuedSend {
  cancelled?: boolean
  deferred: {
    reject: (error: unknown) => void
    resolve: () => void
  }
  generation: number
  options: ChatOrchestratorSendOptions
  sendingMessage: string
  sessionId: string
}

/**
 * Creates the core chat orchestrator runtime used behind UI facades.
 *
 * Use when:
 * - A platform wants AIRI chat send orchestration without Vue/Pinia coupling.
 * - Session, context, foreground stream, and LLM integrations are provided as adapters.
 *
 * Expects:
 * - Session messages are returned in chronological order.
 * - `foregroundStream.patch` replaces the visible streaming assistant message.
 *
 * Returns:
 * - A runtime with send queue APIs, hook registry, writable sending state, and queue snapshots.
 */
export function createChatOrchestratorRuntime(deps: ChatOrchestratorRuntimeDeps): ChatOrchestratorRuntime {
  const hooks = createChatHooks()
  const now = deps.now ?? (() => Date.now())
  const monotonicNow = deps.monotonicNow ?? (() => globalThis.performance?.now?.() ?? Date.now())
  const createId = deps.createId ?? defaultCreateId
  const unwrapMessage = deps.unwrapMessage ?? (<T>(message: T) => message)
  const sessionEvents = deps.sessionEvents ?? new AgentSessionEventLog({ now })

  let sending = false
  let activeSend: ActiveSend | undefined
  let pendingQueuedSends: QueuedSend[] = []

  function emitStateChange() {
    deps.onStateChange?.({
      pendingQueuedSendCount: pendingQueuedSends.length,
      sending,
    })
  }

  function setSending(next: boolean) {
    if (sending === next)
      return
    sending = next
    emitStateChange()
  }

  function isForegroundSession(sessionId: string) {
    return sessionId === deps.getActiveSessionId()
  }

  function patchForegroundStream(sessionId: string, message: StreamingAssistantMessage) {
    if (isForegroundSession(sessionId))
      deps.foregroundStream.patch(cloneStreamingMessage(message))
  }

  function resetForegroundStream(sessionId: string) {
    if (isForegroundSession(sessionId))
      deps.foregroundStream.reset()
  }

  function ingestRuntimeContexts() {
    for (const provider of deps.runtimeContextProviders ?? []) {
      const contextMessage = provider()
      if (contextMessage)
        deps.context.ingest(contextMessage)
    }
  }

  function buildProviderMessages(sessionMessagesForSend: ChatHistoryItem[]) {
    const nowTs = now()

    const providerMessages = sessionMessagesForSend.map((msg) => {
      const { context: _context, createdAt, id: _id, ...withoutContext } = msg
      const rawMessage = unwrapMessage(withoutContext)

      if (rawMessage.role === 'user')
        return prependTextToContent(rawMessage, `${formatTimePrefix(createdAt ?? nowTs)}`)

      if (rawMessage.role === 'assistant') {
        const { categorization: _categorization, interrupted: _interrupted, slices: _slices, tool_results: _toolResults, ...rest } = rawMessage as ChatAssistantMessage
        return unwrapMessage(rest)
      }

      return rawMessage
    })

    if (!deps.contextBudget)
      return providerMessages

    // Compaction happens after assembly so the policy sees exactly what the
    // provider would receive; the durable session history is never rewritten.
    return compactProviderMessages(providerMessages, deps.contextBudget).messages
  }

  async function performSend(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    generation: number,
    sessionId: string,
  ) {
    if (!sendingMessage && !options.attachments?.length)
      return

    deps.session.ensureSession(sessionId)

    const existingSessionMessages = deps.session.getSessionMessages(sessionId)
    const turnIndex = existingSessionMessages.filter(message => message.role === 'user').length + 1

    // Activation measures whether a conversation reaches its first assistant
    // response. Later turns still emit message and latency telemetry, but they
    // must not inflate the one-time activation milestones.
    const isActivationAttempt = !existingSessionMessages.some(message => message.role === 'assistant')

    // Datetime is no longer injected through the side-channel context store.
    // It is applied at message-assembly time (see below) as a system-prompt
    // date anchor + per-message [HH:MM] prefixes, which is more KV-cache
    // friendly and less prone to weak models echoing timestamps verbatim.
    ingestRuntimeContexts()

    const sendingCreatedAt = now()
    const sendSource = options.source ?? (options.input ? 'voice' : 'text')

    // TODO: Expire or prune stale runtime contexts from disconnected services before composing.
    const streamingMessageContext: ChatStreamEventContext = {
      composedMessage: [],
      contexts: deps.context.snapshot(),
      input: options.input,
      message: {
        content: sendingMessage,
        createdAt: sendingCreatedAt,
        id: createId(),
        role: 'user',
      },
    }
    deps.onLifecycle?.({
      channel: 'chat',
      details: {
        contexts: streamingMessageContext.contexts,
      },
      phase: 'before-compose',
      sessionId,
      textPreview: sendingMessage,
    })

    const isStaleGeneration = () => deps.session.getSessionGeneration(sessionId) !== generation
    if (isStaleGeneration())
      return

    const abortController = new AbortController()
    setSending(true)

    const buildingMessage: StreamingAssistantMessage = {
      content: '',
      createdAt: now(),
      id: createId(),
      role: 'assistant',
      slices: [],
      tool_results: [],
    }
    patchForegroundStream(sessionId, buildingMessage)
    const activeProvider = deps.getActiveProvider?.() ?? ''
    // The user message is the durable start of a round, so its ID also serves
    // as the correlation key for every telemetry milestone emitted by it.
    const roundId = createId()
    activeSend = { abortController, sessionId, turnId: roundId }
    const correlation: ChatRoundCorrelation = {
      conversationId: sessionId,
      roundId,
      turnIndex,
    }
    deps.onTrackFirstMessage?.()
    if (isActivationAttempt) {
      deps.onChatActivationStarted?.({
        ...correlation,
        model: options.model,
        provider: activeProvider,
        source: sendSource,
      })
    }
    deps.onMessageSendStarted?.({
      ...correlation,
      model: options.model,
      source: sendSource,
    })
    const roundStartedAt = monotonicNow()

    let assistantCommitted = false
    let finalizeStream: (() => Promise<void>) | undefined
    let finalizingStream = false
    let fullText = ''
    let terminalFinishReason: Extract<StreamEvent, { type: 'finish' }>['finishReason'] | undefined
    let turnControlAdmissionResolved = false
    let turnControlStarted = false
    let turnControlSettled = false
    let checkpointDrain: Promise<void> | undefined
    let checkpointCooldownTimer: ReturnType<typeof setTimeout> | undefined
    let pendingCheckpoint: AgentTurnCheckpointInput | undefined

    /**
     * Snapshots the newest recoverable prefix and writes it at most once per interval.
     *
     * The throttle needs no clock: a write arms one timer, and the timer writes
     * whatever accumulated in the meantime. Nothing is lost by waiting, because
     * `pendingCheckpoint` always holds the newest snapshot and the terminal
     * barrier flushes it.
     */
    function checkpointAssistant() {
      if (!turnControlStarted || !deps.turnControl)
        return

      const reasoningText = buildingMessage.categorization?.reasoning
      pendingCheckpoint = {
        assistantMessageId: buildingMessage.id ?? roundId,
        assistantText: typeof buildingMessage.content === 'string' ? buildingMessage.content : '',
        ...(reasoningText ? { reasoningText: reasoningText.slice(0, CHECKPOINT_REASONING_LIMIT) } : {}),
        sessionId,
        turnId: roundId,
      }
      // A running write or cooldown already owns the next one.
      if (checkpointDrain || checkpointCooldownTimer)
        return

      writeCheckpoint()
    }

    /** Persists the pending snapshot immediately, bypassing the streaming throttle. */
    function writeCheckpoint() {
      if (checkpointCooldownTimer) {
        clearTimeout(checkpointCooldownTimer)
        checkpointCooldownTimer = undefined
      }
      const checkpoint = pendingCheckpoint
      if (!checkpoint || !deps.turnControl)
        return

      pendingCheckpoint = undefined
      checkpointDrain = (async () => {
        try {
          await deps.turnControl?.checkpoint(checkpoint)
        }
        catch (error) {
          // Streaming remains usable when a platform checkpoint temporarily
          // fails; the final settlement gets another durability opportunity.
          console.error('Failed to checkpoint active Agent turn:', error)
        }
      })().finally(() => {
        checkpointDrain = undefined
        // Trailing edge: the newest prefix is written once this write's interval
        // has passed, so a long stream costs one write per interval instead of
        // one per delta. A cancel path that leaves the timer pending writes
        // nothing, because there is no snapshot to send.
        checkpointCooldownTimer = setTimeout(() => {
          checkpointCooldownTimer = undefined
          if (pendingCheckpoint)
            checkpointAssistant()
        }, CHECKPOINT_MIN_INTERVAL_MS)
      })
    }

    async function waitForCheckpointDrain() {
      // The terminal barrier must not wait for the throttle: an in-flight write is
      // awaited, whatever it left pending is flushed right after it, and the
      // cooldown it armed is dropped so no timer outlives the turn.
      for (;;) {
        if (checkpointDrain) {
          await checkpointDrain
          continue
        }
        if (pendingCheckpoint) {
          writeCheckpoint()
          continue
        }
        if (checkpointCooldownTimer) {
          clearTimeout(checkpointCooldownTimer)
          checkpointCooldownTimer = undefined
        }
        return
      }
    }

    function publishStreamingMessage() {
      patchForegroundStream(sessionId, buildingMessage)
      checkpointAssistant()
    }

    // Provider cancellation stops new network/tool output immediately. Parser
    // finalization is still allowed to flush already-received text so the
    // interrupted assistant snapshot matches what the user saw.
    const shouldIgnoreStreamUpdate = () => isStaleGeneration()
      || (abortController.signal.aborted && !finalizingStream)
    const prepareAssistantMessage = (status: 'complete' | 'interrupted') => {
      const reasoning = buildingMessage.categorization?.reasoning?.trim()
      const hasOutput = !!reasoning
        || (typeof buildingMessage.content === 'string' && !!buildingMessage.content.trim())
        || buildingMessage.slices.length > 0
        || buildingMessage.tool_results.length > 0

      if (assistantCommitted || isStaleGeneration() || !hasOutput)
        return undefined

      if (status === 'interrupted')
        buildingMessage.interrupted = true

      return buildingMessage
    }

    const commitAssistantMessage = (message: StreamingAssistantMessage) => {
      deps.session.appendSessionMessage(sessionId, message)
      deps.onAssistantMessageAppended?.({
        message,
        messageText: fullText,
        sessionId,
      })
      assistantCommitted = true
    }

    const contentParts: CommonContentPart[] = [{ text: sendingMessage, type: 'text' }]
    if (options.attachments) {
      for (const attachment of options.attachments) {
        if (attachment.type === 'image') {
          contentParts.push({
            image_url: {
              url: `data:${attachment.mimeType};base64,${attachment.data}`,
            },
            type: 'image_url',
          })
        }
      }
    }
    const finalContent = contentParts.length > 1 ? contentParts : sendingMessage
    const userMessage = {
      content: finalContent,
      createdAt: sendingCreatedAt,
      id: roundId,
      role: 'user' as const,
    }

    try {
      turnControlStarted = await deps.turnControl?.start({
        assistantMessageId: buildingMessage.id ?? roundId,
        sessionId,
        source: sendSource,
        turnId: roundId,
        userMessage,
        userMessageId: roundId,
        userText: sendingMessage,
      }) ?? false
      turnControlAdmissionResolved = true
      abortController.signal.throwIfAborted()
      await hooks.emitBeforeMessageComposedHooks(sendingMessage, streamingMessageContext)
      if (!streamingMessageContext.input) {
        streamingMessageContext.input = {
          data: {
            text: sendingMessage,
          },
          type: 'input:text',
        }
      }

      abortController.signal.throwIfAborted()
      if (isStaleGeneration())
        return

      if (!turnControlStarted) {
        await sessionEvents.append(sessionId, 'turn.admitted', {
          assistantMessageId: buildingMessage.id ?? roundId,
          ownerId: 'local-runtime',
          sessionId,
          source: sendSource,
          turnId: roundId,
          userMessage,
          userMessageId: userMessage.id,
          userText: sendingMessage,
        })
        await sessionEvents.append(sessionId, 'message.appended', {
          message: userMessage,
          messageId: userMessage.id,
          role: 'user',
          status: 'complete',
          turnId: roundId,
        })
      }
      deps.session.appendSessionMessage(sessionId, userMessage)

      // Cloud sync v1: only the raw text part round-trips; image attachments
      // and other non-text parts stay local.
      deps.onUserMessageAppended?.({
        message: userMessage,
        messageText: sendingMessage,
        model: options.model,
        provider: activeProvider,
        roundId,
        sessionId,
        source: sendSource,
        turnIndex,
      })

      const persistedSessionMessages = deps.session.getSessionMessages(sessionId)
      const sessionMessagesForSend = persistedSessionMessages
      deps.onUserTurnReady?.({
        messageText: sendingMessage,
        sessionMessages: sessionMessagesForSend,
      })

      const categorizer = createStreamingCategorizer(deps.getActiveProvider())
      let streamPosition = 0

      const parser = useLlmmarkerParser({
        minLiteralEmitLength: STREAMING_UI_FLUSH_CHUNK_SIZE,
        onEnd: async (parserFullText) => {
          if (isStaleGeneration())
            return

          fullText = parserFullText

          const finalCategorization = categorizeResponse(fullText, deps.getActiveProvider())

          const reasoningContentField = buildingMessage.categorization?.reasoning?.trim()
          buildingMessage.categorization = {
            reasoning: reasoningContentField || finalCategorization.reasoning,
            speech: finalCategorization.speech,
          }
          publishStreamingMessage()
        },
        onLiteral: async (literal) => {
          if (shouldIgnoreStreamUpdate())
            return

          categorizer.consume(literal)

          const speechOnly = categorizer.filterToSpeech(literal, streamPosition)
          streamPosition += literal.length

          if (speechOnly.trim()) {
            buildingMessage.content += speechOnly

            await hooks.emitTokenLiteralHooks(speechOnly, streamingMessageContext)

            const lastSlice = buildingMessage.slices.at(-1)
            if (lastSlice?.type === 'text') {
              lastSlice.text += speechOnly
            }
            else {
              buildingMessage.slices.push({
                text: speechOnly,
                type: 'text',
              })
            }
            publishStreamingMessage()
          }
        },
        onSpecial: async (special) => {
          if (shouldIgnoreStreamUpdate())
            return

          await hooks.emitTokenSpecialHooks(special, streamingMessageContext)
        },
      })
      let parserEnded = false
      finalizeStream = async () => {
        if (parserEnded)
          return
        finalizingStream = true
        try {
          await parser.end()
        }
        finally {
          finalizingStream = false
          parserEnded = true
        }
      }

      const toolCallQueue = createQueue<ChatSlices>({
        handlers: [
          async (ctx) => {
            if (shouldIgnoreStreamUpdate())
              return
            if (ctx.data.type === 'tool-call') {
              buildingMessage.slices.push(ctx.data)
              publishStreamingMessage()
              return
            }

            if (ctx.data.type === 'tool-call-result') {
              buildingMessage.tool_results.push(ctx.data)
              publishStreamingMessage()
            }
          },
        ],
      })

      const newMessages = buildProviderMessages(sessionMessagesForSend)
      let memoryPrompt: string | undefined
      if (deps.memory) {
        try {
          memoryPrompt = (await deps.memory.recall(sessionId, sendingMessage))?.trim()
        }
        catch (error) {
          // Memory is supporting context, not the source of truth for the turn.
          // A local database or remote RAG outage must not block chat completion.
          console.error('Failed to recall conversation memory:', error)
        }
      }

      // The provider system message is assembled fresh on every turn: active
      // card identity, toolset guidance, durable instructions, and recalled
      // memory. Replacing (not appending) keeps identity current when the card
      // changes and prevents the same prompt from stacking inside long
      // sessions whose history already carries an initial system snapshot.
      const systemPrompt = [
        deps.getSystemPrompt?.()?.trim(),
        deps.getSystemPromptSupplement?.()?.trim(),
        memoryPrompt,
      ].filter((value): value is string => !!value).join('\n\n')
      if (systemPrompt) {
        const systemMessage = newMessages.find(message => message.role === 'system')
        if (systemMessage) {
          systemMessage.content = systemPrompt
        }
        else {
          newMessages.unshift({
            content: systemPrompt,
            role: 'system',
          })
        }
      }

      const contextsSnapshot = deps.context.snapshot()
      const contextPromptText = formatContextPromptText(contextsSnapshot)
      if (contextPromptText) {
        const lastMessage = newMessages.at(-1)
        if (lastMessage && lastMessage.role === 'user') {
          const existingParts = typeof lastMessage.content === 'string'
            ? [{ text: lastMessage.content, type: 'text' as const }]
            : lastMessage.content

          lastMessage.content = [
            ...existingParts,
            { text: `\n${contextPromptText}`, type: 'text' as const },
          ]
        }

        deps.onLifecycle?.({
          channel: 'chat',
          details: {
            contexts: contextsSnapshot,
            promptText: contextPromptText,
          },
          phase: 'prompt-context-built',
          sessionId,
        })
      }

      streamingMessageContext.composedMessage = newMessages as Message[]
      await sessionEvents.append(sessionId, 'prompt.composed', {
        messages: newMessages as Message[],
        turnId: roundId,
      })
      deps.onPromptProjection?.({
        composedMessage: newMessages as Message[],
        contexts: contextsSnapshot,
        message: sendingMessage,
        promptMessage: undefined,
        sessionId,
      })
      deps.onLifecycle?.({
        channel: 'chat',
        details: {
          composedMessage: newMessages,
        },
        phase: 'after-compose',
        sessionId,
        textPreview: sendingMessage,
      })

      await hooks.emitAfterMessageComposedHooks(sendingMessage, streamingMessageContext)
      await hooks.emitBeforeSendHooks(sendingMessage, streamingMessageContext)

      const headers = (options.providerConfig?.headers || {}) as Record<string, string>
      const configuredMaxTokens = options.providerConfig?.maxTokens
      const maxTokens = typeof configuredMaxTokens === 'number'
        && Number.isFinite(configuredMaxTokens)
        && configuredMaxTokens > 0
        ? Math.floor(configuredMaxTokens)
        : undefined

      abortController.signal.throwIfAborted()
      if (isStaleGeneration())
        return

      const llmRequestStartedAt = monotonicNow()
      let llmFirstTokenEmitted = false
      deps.onLlmRequestStarted?.({
        ...correlation,
        hasVoice: !!options.input,
        model: options.model,
        provider: deps.getActiveProvider() || 'unknown',
      })

      await deps.llm.stream(options.model, options.chatProvider, newMessages as Message[], {
        abortSignal: abortController.signal,
        captureToolErrors: true,
        headers,
        maxTokens,
        onStreamEvent: async (event: StreamEvent) => {
          if (shouldIgnoreStreamUpdate())
            return

          switch (event.type) {
            case 'finish':
              terminalFinishReason = event.finishReason
              break
            case 'reasoning-delta': {
              const { reasoning = '' } = buildingMessage.categorization ?? {}
              const nextReasoning = reasoning + event.text
              buildingMessage.categorization = {
                reasoning: nextReasoning,
                speech: typeof buildingMessage.content === 'string' ? buildingMessage.content : '',
              }
              const crossesBoundary
                = Math.floor(nextReasoning.length / STREAMING_UI_FLUSH_CHUNK_SIZE)
                  > Math.floor(reasoning.length / STREAMING_UI_FLUSH_CHUNK_SIZE)
              if (!reasoning || crossesBoundary)
                publishStreamingMessage()
              break
            }
            case 'text-delta':
              if (!llmFirstTokenEmitted) {
                llmFirstTokenEmitted = true
                deps.onLlmFirstToken?.({
                  ...correlation,
                  model: options.model,
                  ttfbMs: Math.round(monotonicNow() - llmRequestStartedAt),
                })
              }
              fullText += event.text
              await parser.consume(event.text)
              break
            case 'tool-call':
              toolCallQueue.enqueue({
                toolCall: event,
                type: 'tool-call',
              })

              break
            case 'tool-error':
              toolCallQueue.enqueue({
                id: event.toolCallId,
                isError: true,
                result: event.result,
                type: 'tool-call-result',
              })

              break
            case 'tool-result':
              toolCallQueue.enqueue({
                id: event.toolCallId,
                result: event.result,
                type: 'tool-call-result',
              })

              break
            case 'error':
              throw event.error ?? new Error('Stream error')
          }
        },
        onToolExecutionFinish: async (event) => {
          if (deps.toolExecutionControl) {
            await deps.toolExecutionControl.settle({
              callId: event.toolCallId,
              durationMs: event.durationMs,
              ...(event.error === undefined
                ? { output: normalizeAgentSessionJsonValue(event.output), status: 'completed' as const }
                : { error: errorMessageFromValue(event.error), status: 'failed' as const }),
              input: normalizeAgentSessionJsonValue(event.input),
              sessionId,
              toolName: event.toolName,
              turnId: roundId,
            })
            return
          }
          await sessionEvents.append(sessionId, 'tool.call-settled', {
            callId: event.toolCallId,
            durationMs: event.durationMs,
            ...(event.error === undefined
              ? { output: normalizeAgentSessionJsonValue(event.output), status: 'completed' as const }
              : { error: errorMessageFromValue(event.error), status: 'failed' as const }),
            toolName: event.toolName,
            turnId: roundId,
          })
        },
        onToolExecutionStart: async (event) => {
          if (deps.toolExecutionControl) {
            return await deps.toolExecutionControl.claim({
              callId: event.toolCallId,
              input: normalizeAgentSessionJsonValue(event.input),
              sessionId,
              toolName: event.toolName,
              turnId: roundId,
            })
          }
          await sessionEvents.append(sessionId, 'tool.call-started', {
            callId: event.toolCallId,
            input: normalizeAgentSessionJsonValue(event.input),
            toolName: event.toolName,
            turnId: roundId,
          })
          return { disposition: 'execute' as const }
        },
        tools: options.tools,
        waitForTools: true,
      })

      await finalizeStream()
      abortController.signal.throwIfAborted()
      // `incomplete-action` is emitted only after the bounded completion gate
      // also failed to turn an action preamble into a real tool call. Treating
      // that as a normal stop would reintroduce the original false-completion
      // bug and would project the promise itself into semantic memory.
      if (terminalFinishReason === 'incomplete-action')
        throw new Error('AIRI could not complete the promised tool action')
      deps.onAssistantResponseRendered?.({
        ...correlation,
        latencyMs: Math.round(monotonicNow() - llmRequestStartedAt),
        model: options.model,
      })

      const completedAssistantMessage = prepareAssistantMessage('complete')
      await waitForCheckpointDrain()
      if (turnControlStarted) {
        await deps.turnControl?.settle({
          ...(completedAssistantMessage
            ? { assistantMessage: completedAssistantMessage, assistantMessageStatus: 'complete' as const }
            : {}),
          ...(terminalFinishReason === undefined ? {} : { finishReason: terminalFinishReason }),
          sessionId,
          status: 'completed',
          turnId: roundId,
        })
        turnControlSettled = true
      }
      else if (completedAssistantMessage) {
        await sessionEvents.append(sessionId, 'message.appended', {
          message: completedAssistantMessage,
          messageId: completedAssistantMessage.id ?? roundId,
          role: 'assistant',
          status: 'complete',
          turnId: roundId,
        })
      }
      if (!turnControlStarted) {
        await sessionEvents.append(sessionId, 'turn.closed', {
          ...(terminalFinishReason === undefined ? {} : { finishReason: terminalFinishReason }),
          status: 'completed',
          turnId: roundId,
        })
      }
      if (completedAssistantMessage)
        commitAssistantMessage(completedAssistantMessage)
      if (activeSend?.abortController === abortController)
        activeSend = undefined

      await hooks.emitStreamEndHooks(streamingMessageContext)
      await hooks.emitAssistantResponseEndHooks(fullText, streamingMessageContext)

      await hooks.emitAfterSendHooks(sendingMessage, streamingMessageContext)
      await hooks.emitAssistantMessageHooks({ ...buildingMessage }, fullText, streamingMessageContext)
      await hooks.emitChatTurnCompleteHooks({
        output: { ...buildingMessage },
        outputText: fullText,
        toolCalls: sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
      }, streamingMessageContext)

      deps.onAssistantTurnReady?.({
        messageText: fullText,
        sessionMessages: sessionMessagesForSend,
      })

      resetForegroundStream(sessionId)
      const durationMs = Math.round(monotonicNow() - roundStartedAt)
      deps.onMessageRound?.({
        ...correlation,
        durationMs,
        hasVoice: !!options.input,
        model: options.model,
      })
      if (isActivationAttempt) {
        deps.onChatActivationSucceeded?.({
          ...correlation,
          durationMs,
          model: options.model,
          provider: activeProvider,
          source: sendSource,
        })
      }
    }
    catch (error) {
      try {
        // A failed provider/tool stream has no trustworthy natural-stop
        // reason. Finalizing still flushes parser-buffered text so the
        // interrupted snapshot matches what the user saw.
        await finalizeStream?.()
      }
      catch (finalizeError) {
        console.error('Failed to flush interrupted assistant stream:', finalizeError)
      }
      const interruptedAssistantMessage = prepareAssistantMessage('interrupted')
      const wasCancelled = abortController.signal.aborted
      const status = wasCancelled ? 'cancelled' : 'failed'
      if (turnControlStarted && !turnControlSettled) {
        await waitForCheckpointDrain()
        try {
          await deps.turnControl?.settle({
            ...(interruptedAssistantMessage
              ? { assistantMessage: interruptedAssistantMessage, assistantMessageStatus: 'interrupted' as const }
              : {}),
            ...(terminalFinishReason === undefined ? {} : { finishReason: terminalFinishReason }),
            sessionId,
            status,
            turnId: roundId,
          })
          turnControlSettled = true
        }
        catch (settleError) {
          // NOTICE:
          // A rejected settlement must not mask the original provider/stream
          // failure. A lifecycle interrupt can close the turn between the
          // stream failure and this settlement, and throwing the guard error
          // here would replace the real cause the UI needs to surface.
          // The main-process runner converges interrupted turns on its own,
          // so logging is enough for every legitimate conflict.
          console.error('Failed to settle Agent turn after stream failure:', settleError)
        }
      }
      else if (turnControlAdmissionResolved && !turnControlStarted && interruptedAssistantMessage) {
        await sessionEvents.append(sessionId, 'message.appended', {
          message: interruptedAssistantMessage,
          messageId: interruptedAssistantMessage.id ?? roundId,
          role: 'assistant',
          status: 'interrupted',
          turnId: roundId,
        })
      }
      if (turnControlAdmissionResolved && !turnControlStarted) {
        await sessionEvents.append(sessionId, 'turn.closed', {
          ...(terminalFinishReason === undefined ? {} : { finishReason: terminalFinishReason }),
          status,
          turnId: roundId,
        })
      }
      if (interruptedAssistantMessage)
        commitAssistantMessage(interruptedAssistantMessage)
      resetForegroundStream(sessionId)
      if (!wasCancelled) {
        console.error('Error sending message:', error)
        deps.onMessageRoundFailed?.({
          ...correlation,
          errorCode: 'llm_response_failed',
          failureStage: 'llm_response',
          model: options.model,
          provider: activeProvider,
          source: sendSource,
        })
        if (isActivationAttempt) {
          deps.onChatActivationFailed?.({
            ...correlation,
            errorCode: 'llm_response_failed',
            failureStage: 'llm_response',
            model: options.model,
            provider: activeProvider,
            source: sendSource,
          })
        }
      }
      throw error
    }
    finally {
      if (activeSend?.abortController === abortController)
        activeSend = undefined
      setSending(false)
      deps.onSendSettled?.({ sessionId })
    }
  }

  const sendQueue = createQueue<QueuedSend>({
    handlers: [
      async ({ data }) => {
        const { cancelled, deferred, generation, options, sendingMessage, sessionId } = data

        if (cancelled)
          return

        if (deps.session.getSessionGeneration(sessionId) !== generation) {
          deferred.reject(new Error('Chat session was reset before send could start'))
          return
        }

        try {
          await performSend(sendingMessage, options, generation, sessionId)
          deferred.resolve()
        }
        catch (error) {
          deferred.reject(error)
        }
      },
    ],
  })

  sendQueue.on('enqueue', (queuedSend) => {
    pendingQueuedSends.push(queuedSend)
    emitStateChange()
  })

  sendQueue.on('dequeue', (queuedSend) => {
    pendingQueuedSends = pendingQueuedSends.filter(item => item !== queuedSend)
    emitStateChange()
  })

  function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    const sessionId = targetSessionId || deps.getActiveSessionId()
    const generation = deps.session.getSessionGeneration(sessionId)

    return new Promise<void>((resolve, reject) => {
      sendQueue.enqueue({
        deferred: { reject, resolve },
        generation,
        options,
        sendingMessage,
        sessionId,
      })
    })
  }

  function cancelPendingSends(sessionId?: string) {
    for (const queued of pendingQueuedSends) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      queued.deferred.reject(new Error('Chat session was reset before send could start'))
    }

    pendingQueuedSends = sessionId
      ? pendingQueuedSends.filter(item => item.sessionId !== sessionId)
      : []
    emitStateChange()
  }

  function cancelActiveSend(sessionId?: string) {
    if (!activeSend || activeSend.abortController.signal.aborted)
      return false
    if (sessionId && activeSend.sessionId !== sessionId)
      return false

    activeSend.abortController.abort(new DOMException('Chat send was cancelled', 'AbortError'))
    return true
  }

  function cancelActiveTurn(turnId: string) {
    if (!activeSend || activeSend.turnId !== turnId)
      return false
    return cancelActiveSend(activeSend.sessionId)
  }

  function getPendingQueuedSendSnapshot() {
    return pendingQueuedSends.map(queued => ({
      cancelled: !!queued.cancelled,
      generation: queued.generation,
      hasAttachments: !!queued.options.attachments?.length,
      inputType: queued.options.input?.type,
      messagePreview: queued.sendingMessage.slice(0, 120),
      sessionId: queued.sessionId,
    } satisfies QueuedSendSnapshot))
  }

  return {
    cancelActiveSend,
    cancelActiveTurn,
    cancelPendingSends,
    getActiveTurn: () => activeSend
      ? { sessionId: activeSend.sessionId, turnId: activeSend.turnId }
      : undefined,
    getPendingQueuedSendCount: () => pendingQueuedSends.length,
    getPendingQueuedSendSnapshot,
    getSending: () => sending,
    getSessionEvents: (sessionId, afterSequence) => sessionEvents.list(sessionId, afterSequence),
    hooks,
    ingest,
    setSending,
  }
}

function cloneStreamingMessage(message: StreamingAssistantMessage): StreamingAssistantMessage {
  try {
    return structuredClone(message)
  }
  catch {
    return JSON.parse(JSON.stringify(message)) as StreamingAssistantMessage
  }
}

function defaultCreateId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function prependTextToContent<T extends { content?: unknown }>(msg: T, text: string): T {
  const content = msg.content
  if (content === undefined)
    return { ...msg, content: text }
  if (typeof content === 'string')
    return { ...msg, content: `${text}${content}` }

  if (Array.isArray(content)) {
    const first = content[0] as undefined | { text?: string, type?: string }
    if (first && first.type === 'text' && typeof first.text === 'string') {
      const next = [{ ...first, text: `${text}${first.text}` }, ...content.slice(1)]
      return { ...msg, content: next }
    }
    return { ...msg, content: [{ text, type: 'text' }, ...content] }
  }

  return msg
}

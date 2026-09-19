import type { FinishReason, Message } from '@xsai/shared-chat'

import type {
  AgentTurnCancellationReason,
  AgentTurnCheckpointInput,
  AgentTurnInterruptionReason,
  AgentTurnSettlementStatus,
  AgentTurnStartInput,
} from '../contracts/turn-control-port'
import type { ChatHistoryItem } from '../types/chat'

/** Ordered union of all session events emitted by the runtime. */
export type AgentSessionEvent = {
  [TType in AgentSessionEventType]: AgentSessionEventEnvelope<TType>
}[AgentSessionEventType]

/**
 * One ordered runtime fact belonging to an AIRI chat session.
 *
 * @param TType - Event name that determines the payload contract.
 */
export interface AgentSessionEventEnvelope<TType extends AgentSessionEventType> {
  /** Wall-clock timestamp in milliseconds. */
  occurredAt: number
  /** Event-specific serializable data. */
  payload: AgentSessionEventPayloadMap[TType]
  /** One-based monotonic cursor scoped to `sessionId`. */
  sequence: number
  /** Session that owns this event. */
  sessionId: string
  /** Discriminator for the event payload. */
  type: TType
}

/** Event input accepted before a storage owner assigns time and sequence. */
export type AgentSessionEventInput = {
  [TType in AgentSessionEventType]: {
    /** Event-specific serializable data. */
    payload: AgentSessionEventPayloadMap[TType]
    /** Session that owns this event. */
    sessionId: string
    /** Discriminator for the event payload. */
    type: TType
  }
}[AgentSessionEventType]

/** Configuration for an in-process session event log. */
export interface AgentSessionEventLogOptions {
  /** Previously persisted events used to restore per-session cursors. @default [] */
  initialEvents?: AgentSessionEvent[]
  /** Clock used for event timestamps. @default Date.now */
  now?: () => number
  /** Called after a newly appended event has entered the in-process log. */
  onAppend?: (event: AgentSessionEvent) => void
}

/** Type-safe payload lookup for session runtime events. */
export interface AgentSessionEventPayloadMap {
  /** Memory adapters successfully projected completed turns through a log cursor. */
  'memory.projected': SessionMemoryProjectedPayload
  /** A durable user or assistant message was appended. */
  'message.appended': SessionMessageAppendedPayload
  /** Complete provider-visible input was composed for one turn. */
  'prompt.composed': SessionPromptComposedPayload
  /** A previous process left a tool side effect without a durable outcome. */
  'tool.call-reconciled': SessionToolCallReconciledPayload
  /** One admitted tool execution reached a durable terminal outcome. */
  'tool.call-settled': SessionToolCallSettledPayload
  /** A model-requested tool entered execution after its input became durable. */
  'tool.call-started': SessionToolCallStartedPayload
  /** The main process durably admitted one renderer-owned turn. */
  'turn.admitted': SessionTurnAdmittedPayload
  /** A durable cancellation request targeted one active turn. */
  'turn.cancellation-requested': SessionTurnCancellationRequestedPayload
  /** The latest recoverable assistant prefix replaced an earlier checkpoint. */
  'turn.checkpointed': SessionTurnCheckpointedPayload
  /** A renderer-owned turn closed with an ordinary terminal outcome. */
  'turn.closed': SessionTurnClosedPayload
  /** A renderer-owned turn lost its executor before ordinary settlement. */
  'turn.interrupted': SessionTurnInterruptedPayload
  /** Renderer history durably absorbed one interrupted turn. */
  'turn.recovery-acknowledged': SessionTurnRecoveryAcknowledgedPayload
  /** The runtime completed, cancelled, or failed a turn. */
  'turn.settled': SessionTurnSettledPayload
  /** The runtime started processing a turn. */
  'turn.started': SessionTurnStartedPayload
  /** A visual observation became model-visible session context. */
  'visual.observed': SessionVisualObservedPayload
}

/** Storage boundary required by runtimes that emit and query session events. */
export interface AgentSessionEventPort {
  /**
   * Appends one event and returns its session-scoped sequence envelope.
   *
   * Durable hosts may return a promise so the Agent loop can wait for the
   * persistence barrier before performing the model or tool side effect that
   * the event admits. In-memory hosts retain the synchronous fast path.
   */
  append: <TType extends AgentSessionEventType>(
    sessionId: string,
    type: TType,
    payload: AgentSessionEventPayloadMap[TType],
  ) => AgentSessionEventEnvelope<TType> | Promise<AgentSessionEventEnvelope<TType>>
  /** Reads ordered events after an optional session-scoped cursor. */
  list: (sessionId: string, afterSequence?: number) => AgentSessionEvent[]
}

/** Cursor query for one session's ordered runtime facts. */
export interface AgentSessionEventsQuery {
  /** Return only events whose sequence is greater than this cursor. @default 0 */
  afterSequence?: number
  /** Session whose event stream should be read. */
  sessionId: string
}

/** Event names currently emitted by the core Agent runtime. */
export type AgentSessionEventType = keyof AgentSessionEventPayloadMap

/** Lossless JSON value accepted by the durable Agent session boundary. */
export type AgentSessionJsonValue
  = | AgentSessionJsonValue[]
    | boolean
    | null
    | number
    | string
    | { [key: string]: AgentSessionJsonValue }

/** Durable consumer cursor for event-derived short- and long-term memory. */
export interface SessionMemoryProjectedPayload {
  /** Highest terminal turn event included in the successful projection. */
  throughSequence: number
}

/** Payload recorded after a user or assistant message enters session history. */
export interface SessionMessageAppendedPayload {
  /** Complete serializable message used by replay, memory, and UI projections. */
  message: ChatHistoryItem
  /** Persisted message identifier. */
  messageId: string
  /** External projection source; omitted for ordinary runtime-owned turns. */
  origin?: 'cloud' | 'import'
  /** Authorship of the appended message. */
  role: 'assistant' | 'user'
  /** Whether the message completed normally or preserves interrupted output. */
  status: 'complete' | 'interrupted'
  /** Turn that produced the message. */
  turnId: string
}

/** Complete model-visible prompt snapshot after all injections and context. */
export interface SessionPromptComposedPayload {
  /** Provider messages including system rules, memory, context, and user input. */
  messages: Message[]
  /** Turn whose provider request consumed this prompt. */
  turnId: string
}

/** Explicit crash-recovery result for a tool whose external outcome is unknown. */
export interface SessionToolCallReconciledPayload {
  /** Provider-issued tool-call correlation key matching `tool.call-started`. */
  callId: string
  /** Host condition that prevented an ordinary settlement from being observed. */
  reason: 'host-restarted'
  /** Safe terminal ledger state; callers must not retry this side effect implicitly. */
  status: 'uncertain'
  /** Tool name selected by the model. */
  toolName: string
  /** Turn that owns the side effect. */
  turnId: string
}

/** Payload committed after one admitted tool execution stops producing work. */
export interface SessionToolCallSettledPayload {
  /** Provider-issued tool-call correlation key matching `tool.call-started`. */
  callId: string
  /** Tool wall-clock duration reported by the execution adapter. */
  durationMs: number
  /** Human-readable failure retained when `status` is `failed`. */
  error?: string
  /** JSON-like tool result retained when `status` is `completed`. */
  output?: AgentSessionJsonValue
  /** Whether the tool returned normally or threw. */
  status: 'completed' | 'failed'
  /** Tool name selected by the model. */
  toolName: string
  /** Turn that owns the side effect. */
  turnId: string
}

/** Payload committed before one model-requested tool is allowed to execute. */
export interface SessionToolCallStartedPayload {
  /** Provider-issued tool-call correlation key. */
  callId: string
  /** Parsed JSON-like input supplied to the tool implementation. */
  input: AgentSessionJsonValue
  /** Tool name selected by the model. */
  toolName: string
  /** Turn that owns the side effect. */
  turnId: string
}

/** Complete admission record required to reconstruct a durable turn. */
export interface SessionTurnAdmittedPayload extends AgentTurnStartInput {
  /** Renderer owner token used to reject stale updates and repair detachment. */
  ownerId: string
}

/** Durable cancellation transition for an exact turn. */
export interface SessionTurnCancellationRequestedPayload {
  /** Human or maintenance reason for cancellation. */
  reason: AgentTurnCancellationReason
  /** Exact turn selected by the request. */
  turnId: string
}

/** Complete replacement checkpoint emitted by the durable turn runner. */
export interface SessionTurnCheckpointedPayload {
  /** Latest visible assistant prefix and its monotonic turn-local revision. */
  checkpoint: AgentTurnCheckpointInput & { revision: number }
}

/** Ordinary terminal turn transition emitted by the main-process runner. */
export interface SessionTurnClosedPayload {
  /** Provider completion reason observed by the renderer stream. */
  finishReason?: FinishReason
  /** Terminal renderer-reported outcome. */
  status: AgentTurnSettlementStatus
  /** Exact turn that closed. */
  turnId: string
}

/** Crash/reload repair transition emitted by the main-process runner. */
export interface SessionTurnInterruptedPayload {
  /** Why the active renderer execution disappeared. */
  reason: AgentTurnInterruptionReason
  /** Exact turn repaired as interrupted. */
  turnId: string
}

/** Recovery acknowledgement after reconstructed messages are durable. */
export interface SessionTurnRecoveryAcknowledgedPayload {
  /** Exact interrupted turn applied to chat history. */
  turnId: string
}

/** Payload recorded once a turn can no longer produce more output. */
export interface SessionTurnSettledPayload {
  /** Terminal outcome of the turn. */
  status: 'cancelled' | 'completed' | 'failed'
  /** Turn that reached the terminal outcome. */
  turnId: string
}

/** Payload recorded when the runtime accepts ownership of a turn. */
export interface SessionTurnStartedPayload {
  /** Origin of the input that opened the turn. */
  source: 'self' | 'text' | 'voice'
  /** Stable turn correlation key, shared with the persisted user message. */
  turnId: string
}

/** Payload recorded when multimodal perception becomes available to the session. */
export interface SessionVisualObservedPayload {
  /** Capture timestamp in milliseconds. */
  capturedAt: number
  /** Stable context identity used to replace observations from the same source. */
  contextId: string
  /** Stable observation identity. */
  observationId: string
  /** Human/model-visible interpretation of the visual input. */
  summary: string
  /** Vision workload that produced the interpretation. */
  workloadId: string
}

/**
 * Keeps an immutable, cursor-addressable trace of runtime facts per session.
 *
 * This first runtime boundary is intentionally storage-agnostic. A desktop
 * host can project these typed events to durable storage without coupling the
 * Agent loop to IndexedDB, Electron, or a particular synchronization backend.
 */
export class AgentSessionEventLog implements AgentSessionEventPort {
  private readonly events = new Map<string, AgentSessionEvent[]>()
  private readonly lastSequences = new Map<string, number>()
  private readonly now: () => number
  private readonly onAppend?: (event: AgentSessionEvent) => void

  constructor(options: AgentSessionEventLogOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.onAppend = options.onAppend

    for (const event of structuredClone(options.initialEvents ?? [])) {
      const sessionEvents = this.events.get(event.sessionId) ?? []
      sessionEvents.push(event)
      sessionEvents.sort((left, right) => left.sequence - right.sequence)
      this.events.set(event.sessionId, sessionEvents)
      this.lastSequences.set(
        event.sessionId,
        Math.max(this.lastSequences.get(event.sessionId) ?? 0, event.sequence),
      )
    }
  }

  /** Appends one event and returns the immutable snapshot stored by the log. */
  append<TType extends AgentSessionEventType>(
    sessionId: string,
    type: TType,
    payload: AgentSessionEventPayloadMap[TType],
  ): AgentSessionEventEnvelope<TType> {
    const sessionEvents = this.events.get(sessionId) ?? []
    const event: AgentSessionEventEnvelope<TType> = {
      occurredAt: this.now(),
      payload: structuredClone(payload),
      sequence: (this.lastSequences.get(sessionId) ?? 0) + 1,
      sessionId,
      type,
    }

    const storedEvent = event as AgentSessionEvent
    sessionEvents.push(storedEvent)
    this.events.set(sessionId, sessionEvents)
    this.lastSequences.set(sessionId, event.sequence)
    const snapshot = structuredClone(event)
    this.onAppend?.(structuredClone(storedEvent))
    return snapshot
  }

  /** Returns events after the supplied per-session cursor. */
  list(sessionId: string, afterSequence = 0): AgentSessionEvent[] {
    return structuredClone(
      (this.events.get(sessionId) ?? []).filter(event => event.sequence > afterSequence),
    )
  }

  /**
   * Replaces one session's resident replay window without resetting its cursor.
   *
   * Durable repositories use this after cold archival. The highest sequence
   * already observed remains reserved, so compaction can never reuse an event
   * identity even when the resident window begins above sequence one.
   */
  replaceSession(sessionId: string, events: readonly AgentSessionEvent[]): void {
    if (events.some(event => event.sessionId !== sessionId))
      throw new Error(`Compacted Agent session ${sessionId} contains a foreign event`)
    const snapshots = [...structuredClone(events)]
      .sort((left, right) => left.sequence - right.sequence)
    this.events.set(sessionId, snapshots)
    for (const event of snapshots)
      this.lastSequences.set(sessionId, Math.max(this.lastSequences.get(sessionId) ?? 0, event.sequence))
  }
}

/**
 * Normalizes an arbitrary tool value into durable session JSON.
 *
 * Before:
 * - `{ count: 1n, error: new Error("failed") }`
 *
 * After:
 * - `{ count: "1", error: { name: "Error", message: "failed" } }`
 */
export function normalizeAgentSessionJsonValue(value: unknown): AgentSessionJsonValue {
  return normalizeJsonValue(value, new Set())
}

function normalizeJsonValue(value: unknown, ancestors: Set<object>): AgentSessionJsonValue {
  if (value === null)
    return null
  if (typeof value === 'string' || typeof value === 'boolean')
    return value
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint')
    return value.toString()
  if (typeof value === 'undefined')
    return null
  if (typeof value === 'function' || typeof value === 'symbol')
    return String(value)
  if (typeof value !== 'object')
    return String(value)
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
    }
  }
  if (ancestors.has(value))
    return '[Circular]'

  ancestors.add(value)
  const normalized = Array.isArray(value)
    ? value.map(item => normalizeJsonValue(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, normalizeJsonValue(item, ancestors)]),
      )
  ancestors.delete(value)
  return normalized
}

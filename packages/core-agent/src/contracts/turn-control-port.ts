import type { FinishReason } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'

/** Selects active turns to cancel; no selector means every active turn. */
export interface AgentTurnCancellationInput {
  /** Human or maintenance reason for the request. */
  reason: AgentTurnCancellationReason
  /** Optional session isolation key. */
  sessionId?: string
  /** Optional exact turn isolation key. */
  turnId?: string
}

/** Broadcast after main-process cancellation is durably recorded. */
export interface AgentTurnCancellationNotice {
  /** Reason recorded with the cancellation transition. */
  reason: AgentTurnCancellationReason
  /** Session whose renderer execution should abort. */
  sessionId: string
  /** Exact turn that should abort. */
  turnId: string
}

/** Reason supplied when cancellation enters the main-process state machine. */
export type AgentTurnCancellationReason = 'session-reset' | 'user'

/** Main-process-enriched recovery checkpoint. */
export interface AgentTurnCheckpoint extends AgentTurnCheckpointInput {
  /** Monotonic replacement number scoped to the turn. */
  revision: number
  /** Main-process wall-clock timestamp in milliseconds. */
  updatedAt: number
}

/** Recoverable visible assistant prefix emitted while a turn is running. */
export interface AgentTurnCheckpointInput {
  /** Assistant message reconstructed after renderer loss. */
  assistantMessageId: string
  /** Visible assistant text; private self-prompt tails are excluded. */
  assistantText: string
  /** Optional visible reasoning prefix. */
  reasoningText?: string
  /** Session that owns this checkpoint. */
  sessionId: string
  /** Turn whose latest checkpoint this replaces. */
  turnId: string
}

/**
 * Platform boundary that owns durable turn admission and recovery state.
 *
 * `start` is awaited before provider dispatch. Checkpoints may be coalesced by
 * the platform, while `settle` is the terminal durability barrier.
 */
export interface AgentTurnControlPort {
  /** Replaces the latest recoverable assistant prefix. */
  checkpoint: (input: AgentTurnCheckpointInput) => Promise<void>
  /**
   * Closes the turn after execution can no longer produce output.
   *
   * Returns `true` when the platform also committed the assistant message;
   * local-only hosts return `false` and let the runtime own that event.
   */
  settle: (input: AgentTurnSettlementInput) => Promise<boolean>
  /**
   * Records the turn before model execution begins.
   *
   * Returns `true` when the platform also committed the user message;
   * local-only hosts return `false` and let the runtime own that event.
   */
  start: (input: AgentTurnStartInput) => Promise<boolean>
}

/** Why a live renderer-owned execution was repaired as interrupted. */
export type AgentTurnInterruptionReason = 'host-restarted' | 'renderer-detached'

/** Filter for durable turn inspection and recovery. */
export interface AgentTurnListQuery {
  /** Only return interrupted records not yet applied to chat history. @default false */
  recoverableOnly?: boolean
  /** Optional session isolation key. */
  sessionId?: string
  /** Optional accepted lifecycle states. */
  statuses?: AgentTurnStatus[]
}

/** Durable snapshot returned by the platform turn runner. */
export interface AgentTurnRecord extends AgentTurnStartInput {
  /** User or lifecycle reason attached to a cancellation request. */
  cancellationReason?: AgentTurnCancellationReason
  /** Latest recoverable visible prefix, when output has arrived. */
  checkpoint?: AgentTurnCheckpoint
  /** Provider completion reason observed before the terminal transition. */
  finishReason?: FinishReason
  /** Why an unclosed turn was repaired without renderer settlement. */
  interruptionReason?: AgentTurnInterruptionReason
  /** Platform owner token used to isolate stale renderer updates. */
  ownerId: string
  /** Timestamp when recovery was applied to chat history. */
  recoveredAt?: number
  /** Timestamp when the turn became terminal. */
  settledAt?: number
  /** Timestamp when main-process ownership was durably established. */
  startedAt: number
  /** Current main-process lifecycle state. */
  status: AgentTurnStatus
  /** Timestamp of the latest state transition or checkpoint. */
  updatedAt: number
}

/** Marks one interrupted checkpoint as applied to renderer chat history. */
export interface AgentTurnRecoveryAckInput {
  /** Interrupted assistant message already persisted by renderer history. */
  assistantMessage?: ChatHistoryItem
  /** Session that owns the recovered turn. */
  sessionId: string
  /** Exact interrupted turn being acknowledged. */
  turnId: string
}

/** Terminal transition emitted after renderer execution converges. */
export interface AgentTurnSettlementInput {
  /** Final assistant message committed atomically with the terminal turn. */
  assistantMessage?: ChatHistoryItem
  /** Completeness marker for `assistantMessage`. */
  assistantMessageStatus?: 'complete' | 'interrupted'
  /** Provider completion reason, including truncation and content filtering. */
  finishReason?: FinishReason
  /** Session that owns the settled turn. */
  sessionId: string
  /** Terminal execution outcome. */
  status: AgentTurnSettlementStatus
  /** Turn reaching the terminal state. */
  turnId: string
}

/** Terminal outcome reported by the renderer execution adapter. */
export type AgentTurnSettlementStatus = 'cancelled' | 'completed' | 'failed'

/** Origin of a main-process-owned Agent turn. */
export type AgentTurnSource = 'self' | 'text' | 'voice'

/** Input that reserves a turn before model execution starts. */
export interface AgentTurnStartInput {
  /** Assistant placeholder whose recoverable text will be checkpointed. */
  assistantMessageId: string
  /** Earlier interrupted self turn explicitly continued by this new execution. */
  resumesTurnId?: string
  /** Session that owns this turn. */
  sessionId: string
  /** Input path that initiated the turn. */
  source: AgentTurnSource
  /** Stable correlation key for the complete turn. */
  turnId: string
  /** Complete user message committed atomically with admission. */
  userMessage: ChatHistoryItem
  /** Durable user message associated with the turn. */
  userMessageId: string
  /** Recoverable text input retained before provider dispatch. */
  userText: string
}

/** Complete persisted lifecycle state owned by a platform turn runner. */
export type AgentTurnStatus = 'cancelling' | 'interrupted' | 'running' | AgentTurnSettlementStatus

/** Query for one exact turn or the latest turn in a session. */
export interface AgentTurnStatusQuery {
  /** Session that owns the turn. */
  sessionId: string
  /** Exact turn key; omitted selects the latest started turn. */
  turnId?: string
}

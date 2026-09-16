import type { AgentSessionJsonValue } from '../session/events'

/** Identity and durable input required before one tool side effect may start. */
export interface AgentToolExecutionClaimInput {
  /** Provider-issued call identity scoped to the owning turn. */
  callId: string
  /** Parsed input that must remain stable across duplicate claims. */
  input: AgentSessionJsonValue
  /** Session that owns the turn and its event stream. */
  sessionId: string
  /** Tool name selected by the model. */
  toolName: string
  /** Turn that owns the side effect. */
  turnId: string
}

/** Main-process decision for a possibly duplicated tool request. */
export type AgentToolExecutionClaimResult
  = | {
    /** A matching execution already reached a durable terminal result. */
    disposition: 'replay'
    /** Human-readable failure retained when the original call failed. */
    error?: string
    /** Original durable result retained when the call completed. */
    output?: AgentSessionJsonValue
    /** Terminal result being replayed without running the tool again. */
    status: 'completed' | 'failed'
  }
  | {
    /** No prior execution exists; the caller now owns the side effect. */
    disposition: 'execute'
  }
  | {
    /** The side effect may already be running or may have completed before a crash. */
    disposition: 'blocked'
    /** Non-terminal state that forbids automatic re-execution. */
    status: 'running' | 'uncertain'
  }

/** Host-owned idempotency boundary around external tool side effects. */
export interface AgentToolExecutionControlPort {
  /** Atomically claims a new call, replays a terminal result, or blocks uncertainty. */
  claim: (input: AgentToolExecutionClaimInput) => Promise<AgentToolExecutionClaimResult>
  /** Commits the result of a call previously admitted with `disposition: execute`. */
  settle: (input: AgentToolExecutionSettlementInput) => Promise<void>
}

/** Durable terminal result used to settle one claimed execution. */
export interface AgentToolExecutionSettlementInput extends AgentToolExecutionClaimInput {
  /** Tool wall-clock duration measured by the renderer runtime. */
  durationMs: number
  /** Human-readable failure when the implementation threw. */
  error?: string
  /** JSON-normalized result when the implementation returned normally. */
  output?: AgentSessionJsonValue
  /** Whether the implementation returned or failed. */
  status: 'completed' | 'failed'
}

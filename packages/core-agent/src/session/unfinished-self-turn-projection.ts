import type { AgentSessionEvent } from './events'

/** Event-derived record of a self-directed turn that did not finish normally. */
export interface AgentUnfinishedSelfTurnProjection {
  /** Last visible assistant prefix retained before interruption. */
  assistantText?: string
  /** Timestamp at which the original turn became terminal. */
  interruptedAt: number
  /** Host or renderer loss reason when the executor disappeared. */
  interruptionReason?: 'host-restarted' | 'renderer-detached'
  /** Latest visible reasoning prefix retained by the turn checkpoint. */
  reasoningText?: string
  /** Timestamp at which the continuation was admitted. */
  resumedAt?: number
  /** New self turn that explicitly continued this record. */
  resumedByTurnId?: string
  /** Session that owns the source turn. */
  sessionId: string
  /** Whether this thought still needs an explicit continuation. */
  state: 'open' | 'resumed'
  /** Terminal condition that made the self turn unfinished. */
  terminalStatus: 'cancelled' | 'failed' | 'interrupted'
  /** Self-authored input that opened the interrupted turn. */
  text: string
  /** Stable identity of the interrupted source turn. */
  turnId: string
}

interface SelfTurnCandidate {
  assistantText?: string
  reasoningText?: string
  sessionId: string
  text: string
  turnId: string
}

/**
 * Projects interrupted self-directed work without treating it as semantic memory.
 *
 * The original turn stays immutable. A continuation is a new admitted turn with
 * `resumesTurnId`, allowing replay and UI to retain both attempts permanently.
 */
export function projectUnfinishedSelfTurns(
  events: readonly AgentSessionEvent[],
): AgentUnfinishedSelfTurnProjection[] {
  const candidates = new Map<string, SelfTurnCandidate>()
  const unfinished = new Map<string, AgentUnfinishedSelfTurnProjection>()

  for (const event of events) {
    if (event.type === 'turn.admitted') {
      if (event.payload.resumesTurnId) {
        const previous = unfinished.get(event.payload.resumesTurnId)
        if (previous && previous.state === 'open') {
          unfinished.set(previous.turnId, {
            ...previous,
            resumedAt: event.occurredAt,
            resumedByTurnId: event.payload.turnId,
            state: 'resumed',
          })
        }
      }
      if (event.payload.source === 'self') {
        candidates.set(event.payload.turnId, {
          sessionId: event.sessionId,
          text: event.payload.userText,
          turnId: event.payload.turnId,
        })
      }
      continue
    }

    const candidate = turnCandidate(candidates, event)
    if (!candidate)
      continue
    if (event.type === 'turn.checkpointed') {
      candidate.assistantText = event.payload.checkpoint.assistantText
      candidate.reasoningText = event.payload.checkpoint.reasoningText
      continue
    }
    if (event.type === 'message.appended'
      && event.payload.role === 'assistant'
      && event.payload.status === 'interrupted') {
      candidate.assistantText = messageText(event.payload.message) || candidate.assistantText
      continue
    }
    if (event.type === 'turn.interrupted') {
      unfinished.set(candidate.turnId, {
        ...candidate,
        interruptedAt: event.occurredAt,
        interruptionReason: event.payload.reason,
        state: 'open',
        terminalStatus: 'interrupted',
      })
      continue
    }
    if (event.type === 'turn.closed' && event.payload.status !== 'completed') {
      unfinished.set(candidate.turnId, {
        ...candidate,
        interruptedAt: event.occurredAt,
        state: 'open',
        terminalStatus: event.payload.status,
      })
    }
  }

  return [...unfinished.values()]
    .sort((left, right) => right.interruptedAt - left.interruptedAt)
    .map(value => structuredClone(value))
}

function messageText(message: { content?: unknown }): string {
  if (typeof message.content === 'string')
    return message.content
  if (!Array.isArray(message.content))
    return ''
  return message.content
    .map(part => typeof part === 'object' && part !== null && 'text' in part ? String(part.text ?? '') : '')
    .join('')
}

function turnCandidate(
  candidates: Map<string, SelfTurnCandidate>,
  event: AgentSessionEvent,
): SelfTurnCandidate | undefined {
  if (event.type === 'turn.checkpointed')
    return candidates.get(event.payload.checkpoint.turnId)
  if (event.type === 'message.appended')
    return candidates.get(event.payload.turnId)
  if (event.type === 'turn.closed' || event.type === 'turn.interrupted')
    return candidates.get(event.payload.turnId)
  return undefined
}

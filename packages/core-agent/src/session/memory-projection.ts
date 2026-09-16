import type { ChatHistoryItem } from '../types/chat'
import type { AgentSessionEvent } from './events'

/** One completed exchange derived from the append-only session log. */
export interface AgentMemoryTurnProjection {
  /** Visible assistant output. */
  assistantText: string
  /** Timestamp of the terminal completion event. */
  completedAt: number
  /** Session-event cursor of the terminal completion fact. */
  completedSequence: number
  /** Stable idempotency identity for memory storage projections. */
  projectionId: string
  /** Session that owns the exchange. */
  sessionId: string
  /** Stable turn correlation identity. */
  turnId: string
  /** Visible user or autonomous prompt. */
  userText: string
}

/**
 * Projects completed user/assistant exchanges from an ordered session log.
 *
 * Interrupted messages and non-completed turns remain durable history but do
 * not become semantic memory. Replaying the same log returns the same
 * `projectionId`, allowing storage adapters to upsert rather than duplicate.
 */
export function completedMemoryTurns(events: readonly AgentSessionEvent[]): AgentMemoryTurnProjection[] {
  const messages = new Map<string, { assistant?: string, user?: string }>()
  const completed = new Map<string, AgentMemoryTurnProjection>()

  for (const event of events) {
    if (event.type === 'message.appended' && event.payload.status === 'complete') {
      const entry = messages.get(event.payload.turnId) ?? {}
      entry[event.payload.role] = messageText(event.payload.message)
      messages.set(event.payload.turnId, entry)
      if (event.payload.origin && event.payload.role === 'assistant')
        projectCompletedTurn(completed, entry, event.sessionId, event.payload.turnId, event.occurredAt, event.sequence)
      continue
    }

    const isCompletedTurn = event.type === 'turn.closed' && event.payload.status === 'completed'
    if (!isCompletedTurn)
      continue

    projectCompletedTurn(
      completed,
      messages.get(event.payload.turnId),
      event.sessionId,
      event.payload.turnId,
      event.occurredAt,
      event.sequence,
    )
  }

  return [...completed.values()]
}

function messageText(message: ChatHistoryItem): string {
  if (typeof message.content === 'string')
    return message.content
  if (!Array.isArray(message.content))
    return ''
  return message.content
    .filter(part => part.type === 'text')
    .map(part => part.text)
    .join('\n')
}

function projectCompletedTurn(
  completed: Map<string, AgentMemoryTurnProjection>,
  entry: undefined | { assistant?: string, user?: string },
  sessionId: string,
  turnId: string,
  completedAt: number,
  completedSequence: number,
) {
  const userText = entry?.user?.trim()
  const assistantText = entry?.assistant?.trim()
  if (!userText || !assistantText)
    return

  completed.set(turnId, {
    assistantText,
    completedAt,
    completedSequence,
    projectionId: `session-memory:${sessionId}:${turnId}`,
    sessionId,
    turnId,
    userText,
  })
}

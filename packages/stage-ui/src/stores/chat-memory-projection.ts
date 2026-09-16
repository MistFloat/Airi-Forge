import { completedMemoryTurns } from '@proj-airi/core-agent'

import { commitChatSessionEvent, readChatSessionEvents } from './chat-session-events'
import { useMemoryLongTermStore } from './modules/memory-long-term'
import { useMemoryShortTermStore } from './modules/memory-short-term'

const projections = new Map<string, Promise<void>>()

/**
 * Replays completed exchanges from the session log into memory adapters.
 *
 * Stable projection ids and a durable successful-consumer cursor make this
 * safe after refresh or process restart. The event log remains authoritative;
 * short- and long-term stores are disposable query projections that can be
 * rebuilt without asking the model to remember.
 */
export async function projectChatMemoryFromEvents(sessionId: string): Promise<void> {
  const prior = projections.get(sessionId) ?? Promise.resolve()
  const current = prior.then(async () => {
    const events = await readChatSessionEvents({ sessionId }, [])
    const projectedThrough = events.reduce((cursor, event) => {
      if (event.type !== 'memory.projected')
        return cursor
      return Math.max(cursor, event.payload.throughSequence)
    }, 0)
    const turns = completedMemoryTurns(events)
      .filter(turn => turn.completedSequence > projectedThrough)
    const shortTerm = useMemoryShortTermStore()
    const longTerm = useMemoryLongTermStore()
    let projectionFailed = false

    for (const turn of turns) {
      const results = await Promise.allSettled([
        shortTerm.rememberTurn(turn.sessionId, turn.userText, turn.assistantText, {
          createdAt: turn.completedAt,
          id: turn.projectionId,
        }),
        longTerm.rememberTurn(turn.sessionId, turn.userText, turn.assistantText, {
          memoryId: turn.projectionId,
        }),
      ])
      for (const result of results) {
        if (result.status === 'rejected') {
          projectionFailed = true
          console.warn('Session memory projection failed (fail-open):', result.reason)
        }
      }
      if (projectionFailed)
        break
    }

    // Never move the consumer cursor past a partial projection. Stable ids let
    // the next attempt safely replay a store that had already succeeded.
    const latestTurn = turns.at(-1)
    if (projectionFailed || !latestTurn)
      return

    await commitChatSessionEvent({
      payload: { throughSequence: latestTurn.completedSequence },
      sessionId,
      type: 'memory.projected',
    })
  })
  const tail = current.catch(() => {})
  projections.set(sessionId, tail)
  try {
    await current
  }
  finally {
    if (projections.get(sessionId) === tail)
      projections.delete(sessionId)
  }
}

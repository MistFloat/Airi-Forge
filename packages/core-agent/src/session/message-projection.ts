import type { ChatHistoryItem } from '../types/chat'
import type { AgentSessionEvent } from './events'

/**
 * Reconstructs visible authored messages from an ordered session event log.
 *
 * Repeated recovery/appends with the same message id replace the earlier
 * snapshot without changing its position. System prompts remain runtime-owned
 * because they are derived from the current character configuration.
 */
export function projectSessionMessages(events: readonly AgentSessionEvent[]): ChatHistoryItem[] {
  const order: string[] = []
  const messages = new Map<string, ChatHistoryItem>()

  for (const event of events) {
    if (event.type !== 'message.appended')
      continue
    if (!messages.has(event.payload.messageId))
      order.push(event.payload.messageId)
    messages.set(event.payload.messageId, structuredClone(event.payload.message))
  }

  return order.flatMap((messageId) => {
    const message = messages.get(messageId)
    return message ? [structuredClone(message)] : []
  })
}

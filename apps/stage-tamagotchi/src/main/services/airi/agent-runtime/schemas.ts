import type { AgentSessionJsonValue, ChatHistoryItem } from '@proj-airi/core-agent'

import { custom } from 'valibot'

/** Shared renderer-message schema used by session and turn command boundaries. */
export const authoredChatMessageSchema = custom<ChatHistoryItem>(
  isAuthoredChatMessage,
  'Expected a serializable user or assistant message',
)

/** Strict JSON-value schema used for durable tool inputs and outputs. */
export const agentSessionJsonValueSchema = custom<AgentSessionJsonValue>(
  value => isJsonValue(value, new Set()),
  'Expected a finite, acyclic JSON value',
)

function isAuthoredChatMessage(input: unknown): input is ChatHistoryItem {
  if (typeof input !== 'object' || input === null || !('role' in input) || !('content' in input))
    return false
  const message = input as Record<string, unknown>
  if (message.role === 'user')
    return isJsonValue(message, new Set())
  return message.role === 'assistant'
    && Array.isArray(message.slices)
    && Array.isArray(message.tool_results)
    && isJsonValue(message, new Set())
}

function isJsonValue(value: unknown, ancestors: Set<object>): value is AgentSessionJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number')
    return Number.isFinite(value)
  if (typeof value !== 'object')
    return false
  if (ancestors.has(value))
    return false

  ancestors.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, ancestors))
    : Object.values(value).every(item => isJsonValue(item, ancestors))
  ancestors.delete(value)
  return valid
}

import type { ContextUpdate, MetadataEventSource, WebSocketEventInputs } from '@proj-airi/server-shared/types'
import type { AssistantMessage, CommonContentPart, CompletionToolCall, Message, SystemMessage, ToolMessage, UserMessage } from '@xsai/shared-chat'

export interface ChatAssistantMessage extends AssistantMessage {
  categorization?: {
    reasoning: string
    speech: string
  }
  /** True when provider failure or cancellation ended the stream before normal completion. */
  interrupted?: boolean
  slices: ChatSlices[]
  tool_results: {
    id: string
    isError?: boolean
    result?: CommonContentPart[] | string
  }[]
}

export type ChatHistoryItem = (ChatMessage | ErrorMessage) & { context?: ContextMessage } & { createdAt?: number, id?: string }

export type ChatMessage = ChatAssistantMessage | ChatUserMessage | SystemMessage | ToolMessage

export type ChatSlices = ChatSlicesText | ChatSlicesToolCall | ChatSlicesToolCallResult

export interface ChatSlicesText {
  text: string
  type: 'text'
}

export interface ChatSlicesToolCall {
  toolCall: CompletionToolCall
  type: 'tool-call'
}

export interface ChatSlicesToolCallResult {
  id: string
  isError?: boolean
  result?: CommonContentPart[] | string
  type: 'tool-call-result'
}

export type ChatStreamEvent
  = | { context: ChatStreamEventContext, literal: string, sessionId: string, type: 'token-literal' }
    | { context: ChatStreamEventContext, message: ChatAssistantMessage, messageText: string, sessionId: string, type: 'assistant-message' }
    | { context: ChatStreamEventContext, message: string, sessionId: string, type: 'after-compose' }
    | { context: ChatStreamEventContext, message: string, sessionId: string, type: 'after-send' }
    | { context: ChatStreamEventContext, message: string, sessionId: string, type: 'assistant-end' }
    | { context: ChatStreamEventContext, message: string, sessionId: string, type: 'before-send' }
    | { context: ChatStreamEventContext, sessionId: string, special: string, type: 'token-special' }
    | { context: ChatStreamEventContext, sessionId: string, type: 'stream-end' }
    | { context: Omit<ChatStreamEventContext, 'composedMessage'>, message: string, sessionId: string, type: 'before-compose' }

export interface ChatStreamEventContext {
  composedMessage: Array<Message>
  contexts: Record<string, ContextMessage[]>
  input?: WebSocketEventInputs
  message: ChatHistoryItem
}

/** User-role message carrying its provenance for attribution. */
export interface ChatUserMessage extends UserMessage {
  /** Present for internal turns; omitted for user-authored messages. */
  source?: 'self'
}

export interface ContextMessage extends ContextUpdate<Record<string, unknown>, unknown> {
  createdAt: number
  metadata?: {
    source: MetadataEventSource
  }
}

export interface ErrorMessage {
  content: string
  role: 'error'
}

export type StreamingAssistantMessage = ChatAssistantMessage & { context?: ContextMessage } & { createdAt?: number, id?: string }

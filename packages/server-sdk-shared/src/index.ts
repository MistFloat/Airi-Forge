import { defineInvokeEventa, defineOutboundEventa } from '@moeru/eventa'

export type MessageRole = WireMessage['role']

export interface NewMessagesPayload {
  chatId: string
  fromSeq: number
  messages: WireMessage[]
  toSeq: number
}

export interface PullMessagesRequest {
  afterSeq: number
  chatId: string
  limit?: number
}

export interface PullMessagesResponse {
  messages: WireMessage[]
  seq: number
}

export interface SendMessagesRequest {
  chatId: string
  messages: { content: string, id: string, role: string }[]
}

export interface SendMessagesResponse {
  seq: number
}

export interface WireMessage {
  chatId: string
  content: string
  createdAt: number
  id: string
  role: 'assistant' | 'error' | 'system' | 'tool' | 'user'
  senderId: null | string
  seq: number
  updatedAt: number
}

export const sendMessages = defineInvokeEventa<SendMessagesResponse, SendMessagesRequest>('chat:send-messages')
export const pullMessages = defineInvokeEventa<PullMessagesResponse, PullMessagesRequest>('chat:pull-messages')
export const newMessages = defineOutboundEventa<NewMessagesPayload>('chat:new-messages')

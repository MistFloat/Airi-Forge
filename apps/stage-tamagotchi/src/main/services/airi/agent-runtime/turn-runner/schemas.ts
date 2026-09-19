import type {
  AgentTurnCancellationInput,
  AgentTurnCheckpointInput,
  AgentTurnListQuery,
  AgentTurnRecord,
  AgentTurnRecoveryAckInput,
  AgentTurnSettlementInput,
  AgentTurnStartInput,
  AgentTurnStatusQuery,
} from '@proj-airi/core-agent'

import {
  array,
  integer,
  literal,
  minLength,
  minValue,
  number,
  object,
  optional,
  parse,
  pipe,
  string,
  union,
} from 'valibot'

import { authoredChatMessageSchema } from '../schemas'

const identifierSchema = pipe(string(), minLength(1))
const timestampSchema = pipe(number(), integer(), minValue(0))
const sourceSchema = union([literal('text'), literal('voice')])
const settlementStatusSchema = union([literal('cancelled'), literal('completed'), literal('failed')])
const turnStatusSchema = union([
  settlementStatusSchema,
  literal('cancelling'),
  literal('interrupted'),
  literal('running'),
])
const cancellationReasonSchema = union([literal('session-reset'), literal('user')])
const interruptionReasonSchema = union([literal('host-restarted'), literal('renderer-detached')])

/** Validated turn admission accepted from an Electron renderer. */
export const agentTurnStartInputSchema = object({
  assistantMessageId: identifierSchema,
  sessionId: identifierSchema,
  source: sourceSchema,
  turnId: identifierSchema,
  userMessage: authoredChatMessageSchema,
  userMessageId: identifierSchema,
  userText: string(),
})

/** Validated visible output replacement accepted from an Electron renderer. */
export const agentTurnCheckpointInputSchema = object({
  assistantMessageId: identifierSchema,
  assistantText: string(),
  reasoningText: optional(string()),
  sessionId: identifierSchema,
  turnId: identifierSchema,
})

/** Validated terminal transition accepted from an Electron renderer. */
export const agentTurnSettlementInputSchema = object({
  assistantMessage: optional(authoredChatMessageSchema),
  assistantMessageStatus: optional(union([literal('complete'), literal('interrupted')])),
  finishReason: optional(string()),
  sessionId: identifierSchema,
  status: settlementStatusSchema,
  turnId: identifierSchema,
})

/** Validated cancellation selector accepted from an Electron renderer. */
export const agentTurnCancellationInputSchema = object({
  reason: cancellationReasonSchema,
  sessionId: optional(identifierSchema),
  turnId: optional(identifierSchema),
})

/** Validated exact/latest status query accepted from an Electron renderer. */
export const agentTurnStatusQuerySchema = object({
  sessionId: identifierSchema,
  turnId: optional(identifierSchema),
})

/** Validated durable turn list query accepted from an Electron renderer. */
export const agentTurnListQuerySchema = object({
  recoverableOnly: optional(union([literal(false), literal(true)])),
  sessionId: optional(identifierSchema),
  statuses: optional(array(turnStatusSchema)),
})

/** Validated recovery acknowledgement accepted from an Electron renderer. */
export const agentTurnRecoveryAckInputSchema = object({
  assistantMessage: optional(authoredChatMessageSchema),
  sessionId: identifierSchema,
  turnId: identifierSchema,
})

const agentTurnCheckpointSchema = object({
  ...agentTurnCheckpointInputSchema.entries,
  revision: pipe(number(), integer(), minValue(1)),
  updatedAt: timestampSchema,
})

/** Validated on-disk representation of one authoritative turn. */
export const agentTurnRecordSchema = object({
  ...agentTurnStartInputSchema.entries,
  cancellationReason: optional(cancellationReasonSchema),
  checkpoint: optional(agentTurnCheckpointSchema),
  finishReason: optional(string()),
  interruptionReason: optional(interruptionReasonSchema),
  ownerId: identifierSchema,
  recoveredAt: optional(timestampSchema),
  settledAt: optional(timestampSchema),
  startedAt: timestampSchema,
  status: turnStatusSchema,
  updatedAt: timestampSchema,
})

/** Validated main-process persistence document for durable turns. */
export const agentTurnPersistenceStateSchema = object({
  turns: array(agentTurnRecordSchema),
})

/** Parses an untrusted cancellation selector. */
export function parseAgentTurnCancellationInput(input: unknown): AgentTurnCancellationInput {
  return parse(agentTurnCancellationInputSchema, input)
}

/** Parses an untrusted renderer checkpoint replacement. */
export function parseAgentTurnCheckpointInput(input: unknown): AgentTurnCheckpointInput {
  return parse(agentTurnCheckpointInputSchema, input)
}

/** Parses an untrusted durable turn list query. */
export function parseAgentTurnListQuery(input: unknown): AgentTurnListQuery {
  return parse(agentTurnListQuerySchema, input)
}

/** Narrows validated persistence output to the owning core contract. */
export function parseAgentTurnRecords(input: unknown): AgentTurnRecord[] {
  return parse(array(agentTurnRecordSchema), input)
}

/** Parses an untrusted recovery acknowledgement. */
export function parseAgentTurnRecoveryAckInput(input: unknown): AgentTurnRecoveryAckInput {
  return parse(agentTurnRecoveryAckInputSchema, input)
}

/** Parses an untrusted renderer terminal transition. */
export function parseAgentTurnSettlementInput(input: unknown): AgentTurnSettlementInput {
  return parse(agentTurnSettlementInputSchema, input)
}

/** Parses untrusted renderer admission input. */
export function parseAgentTurnStartInput(input: unknown): AgentTurnStartInput {
  return parse(agentTurnStartInputSchema, input)
}

/** Parses an untrusted exact/latest status query. */
export function parseAgentTurnStatusQuery(input: unknown): AgentTurnStatusQuery {
  return parse(agentTurnStatusQuerySchema, input)
}

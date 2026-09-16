import type {
  AgentSessionEvent,
  AgentSessionEventInput,
  AgentSessionEventsQuery,
  AgentToolExecutionClaimInput,
  AgentToolExecutionSettlementInput,
} from '@proj-airi/core-agent'
import type { Message } from '@xsai/shared-chat'

import {
  array,
  custom,
  integer,
  literal,
  minLength,
  minValue,
  number,
  object,
  optional,
  parse,
  pipe,
  record,
  string,
  union,
  variant,
} from 'valibot'

import { agentSessionJsonValueSchema, authoredChatMessageSchema } from '../schemas'

const identifierSchema = pipe(string(), minLength(1))
const timestampSchema = pipe(number(), integer(), minValue(0))

const blockedReasonSchema = object({
  code: string(),
  message: string(),
})

const goalSnapshotSchema = object({
  blockedReason: optional(blockedReasonSchema),
  createdAt: timestampSchema,
  id: identifierSchema,
  maxRounds: pipe(number(), integer(), minValue(1)),
  objective: identifierSchema,
  phase: union([literal('active'), literal('paused'), literal('blocked'), literal('complete')]),
  revision: pipe(number(), integer(), minValue(1)),
  rounds: pipe(number(), integer(), minValue(0)),
  source: union([literal('self-prompt'), literal('system'), literal('user')]),
  sourceText: optional(string()),
  updatedAt: timestampSchema,
})

const goalChangedPayloadSchema = object({
  goal: goalSnapshotSchema,
  operation: union([
    literal('block'),
    literal('complete'),
    literal('create'),
    literal('edit'),
    literal('pause'),
    literal('resume'),
    literal('round'),
  ]),
})

const scheduleSnapshotSchema = object({
  afterMs: optional(pipe(number(), integer(), minValue(1))),
  claimedBy: optional(identifierSchema),
  createdAt: timestampSchema,
  dispatchId: optional(identifierSchema),
  everyMs: optional(pipe(number(), integer(), minValue(1))),
  goal: optional(object({ id: identifierSchema, revision: pipe(number(), integer(), minValue(1)) })),
  id: identifierSchema,
  kind: union([literal('after'), literal('at'), literal('every')]),
  lastError: optional(string()),
  occurrenceAt: optional(timestampSchema),
  prompt: identifierSchema,
  revision: pipe(number(), integer(), minValue(1)),
  scheduledAt: timestampSchema,
  state: union([
    literal('cancelled'),
    literal('claimed'),
    literal('completed'),
    literal('failed'),
    literal('pending'),
    literal('scheduled'),
  ]),
  updatedAt: timestampSchema,
})

const scheduleChangedPayloadSchema = object({
  operation: union([
    literal('cancel'),
    literal('claim'),
    literal('complete'),
    literal('create'),
    literal('fail'),
    literal('release'),
    literal('trigger'),
  ]),
  schedule: scheduleSnapshotSchema,
})

const taskChangedPayloadSchema = object({
  task: object({
    error: optional(string()),
    id: identifierSchema,
    objective: identifierSchema,
    revision: pipe(number(), integer(), minValue(1)),
    state: union([
      literal('blocked'),
      literal('cancelled'),
      literal('completed'),
      literal('failed'),
      literal('paused'),
      literal('queued'),
      literal('running'),
    ]),
    updatedAt: timestampSchema,
  }),
})

const visualObservedPayloadSchema = object({
  capturedAt: timestampSchema,
  contextId: identifierSchema,
  observationId: identifierSchema,
  summary: identifierSchema,
  workloadId: identifierSchema,
})

const messageAppendedPayloadSchema = object({
  message: authoredChatMessageSchema,
  messageId: string(),
  origin: optional(union([literal('cloud'), literal('import')])),
  role: union([literal('assistant'), literal('user')]),
  status: union([literal('complete'), literal('interrupted')]),
  turnId: string(),
})

const memoryProjectedPayloadSchema = object({
  throughSequence: pipe(number(), integer(), minValue(1)),
})

const promptComposedPayloadSchema = object({
  messages: custom<Message[]>(Array.isArray, 'Expected provider message array'),
  turnId: identifierSchema,
})

const toolCallStartedPayloadSchema = object({
  callId: identifierSchema,
  input: agentSessionJsonValueSchema,
  toolName: identifierSchema,
  turnId: identifierSchema,
})

const toolCallSettledPayloadSchema = object({
  callId: identifierSchema,
  durationMs: timestampSchema,
  error: optional(string()),
  output: optional(agentSessionJsonValueSchema),
  status: union([literal('completed'), literal('failed')]),
  toolName: identifierSchema,
  turnId: identifierSchema,
})

const toolCallReconciledPayloadSchema = object({
  callId: identifierSchema,
  reason: literal('host-restarted'),
  status: literal('uncertain'),
  toolName: identifierSchema,
  turnId: identifierSchema,
})

const toolExecutionClaimInputSchema = object({
  callId: identifierSchema,
  input: agentSessionJsonValueSchema,
  sessionId: identifierSchema,
  toolName: identifierSchema,
  turnId: identifierSchema,
})

const toolExecutionSettlementInputSchema = object({
  ...toolExecutionClaimInputSchema.entries,
  durationMs: timestampSchema,
  error: optional(string()),
  output: optional(agentSessionJsonValueSchema),
  status: union([literal('completed'), literal('failed')]),
})

const turnSettledPayloadSchema = object({
  status: union([literal('cancelled'), literal('completed'), literal('failed')]),
  turnId: string(),
})

const turnStartedPayloadSchema = object({
  source: union([literal('self'), literal('text'), literal('voice')]),
  turnId: string(),
})

const turnAdmittedPayloadSchema = object({
  assistantMessageId: identifierSchema,
  ownerId: identifierSchema,
  resumesTurnId: optional(identifierSchema),
  sessionId: identifierSchema,
  source: union([literal('self'), literal('text'), literal('voice')]),
  turnId: identifierSchema,
  userMessage: authoredChatMessageSchema,
  userMessageId: identifierSchema,
  userText: string(),
})

const turnCheckpointedPayloadSchema = object({
  checkpoint: object({
    assistantMessageId: identifierSchema,
    assistantText: string(),
    reasoningText: optional(string()),
    revision: pipe(number(), integer(), minValue(1)),
    sessionId: identifierSchema,
    turnId: identifierSchema,
  }),
})

const turnCancellationRequestedPayloadSchema = object({
  reason: union([literal('session-reset'), literal('user')]),
  turnId: identifierSchema,
})

const turnClosedPayloadSchema = object({
  finishReason: optional(string()),
  status: union([literal('cancelled'), literal('completed'), literal('failed')]),
  turnId: identifierSchema,
})

const turnInterruptedPayloadSchema = object({
  reason: union([literal('host-restarted'), literal('renderer-detached')]),
  turnId: identifierSchema,
})

const turnRecoveryAcknowledgedPayloadSchema = object({
  turnId: identifierSchema,
})

/** Validated payload accepted from an Electron renderer producer. */
export const agentSessionEventInputSchema = variant('type', [
  object({
    payload: memoryProjectedPayloadSchema,
    sessionId: string(),
    type: literal('memory.projected'),
  }),
  object({
    payload: messageAppendedPayloadSchema,
    sessionId: identifierSchema,
    type: literal('message.appended'),
  }),
  object({
    payload: promptComposedPayloadSchema,
    sessionId: string(),
    type: literal('prompt.composed'),
  }),
  object({
    payload: visualObservedPayloadSchema,
    sessionId: string(),
    type: literal('visual.observed'),
  }),
])

/** Validated cursor request accepted from an Electron renderer. */
export const agentSessionEventsQuerySchema = object({
  afterSequence: optional(pipe(number(), integer(), minValue(0))),
  sessionId: string(),
})

const eventEnvelopeFields = {
  occurredAt: number(),
  sequence: pipe(number(), integer(), minValue(1)),
  sessionId: string(),
}

/** Validated on-disk representation of one authoritative event. */
export const agentSessionEventSchema = variant('type', [
  object({
    ...eventEnvelopeFields,
    payload: memoryProjectedPayloadSchema,
    type: literal('memory.projected'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnAdmittedPayloadSchema,
    type: literal('turn.admitted'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnCancellationRequestedPayloadSchema,
    type: literal('turn.cancellation-requested'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnCheckpointedPayloadSchema,
    type: literal('turn.checkpointed'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnClosedPayloadSchema,
    type: literal('turn.closed'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnInterruptedPayloadSchema,
    type: literal('turn.interrupted'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnRecoveryAcknowledgedPayloadSchema,
    type: literal('turn.recovery-acknowledged'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: goalChangedPayloadSchema,
    type: literal('goal.changed'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: scheduleChangedPayloadSchema,
    type: literal('schedule.changed'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: taskChangedPayloadSchema,
    type: literal('task.changed'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: toolCallStartedPayloadSchema,
    type: literal('tool.call-started'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: toolCallSettledPayloadSchema,
    type: literal('tool.call-settled'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: toolCallReconciledPayloadSchema,
    type: literal('tool.call-reconciled'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: messageAppendedPayloadSchema,
    type: literal('message.appended'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: promptComposedPayloadSchema,
    type: literal('prompt.composed'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnSettledPayloadSchema,
    type: literal('turn.settled'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: turnStartedPayloadSchema,
    type: literal('turn.started'),
  }),
  object({
    ...eventEnvelopeFields,
    payload: visualObservedPayloadSchema,
    type: literal('visual.observed'),
  }),
])

/** Validated main-process persistence document grouped by session owner. */
export const agentSessionEventStateSchema = object({
  sessions: record(string(), array(agentSessionEventSchema)),
})

/** Parses untrusted IPC input into the core Agent event contract. */
export function parseAgentSessionEventInput(input: unknown): AgentSessionEventInput {
  return parse(agentSessionEventInputSchema, input)
}

/** Narrows validated persistence output to the owning core event contract. */
export function parseAgentSessionEvents(input: unknown): AgentSessionEvent[] {
  return parse(array(agentSessionEventSchema), input)
}

/** Parses an untrusted IPC cursor query. */
export function parseAgentSessionEventsQuery(input: unknown): AgentSessionEventsQuery {
  return parse(agentSessionEventsQuerySchema, input)
}

/** Parses an untrusted atomic tool claim command. */
export function parseAgentToolExecutionClaimInput(input: unknown): AgentToolExecutionClaimInput {
  return parse(toolExecutionClaimInputSchema, input)
}

/** Parses an untrusted tool settlement command. */
export function parseAgentToolExecutionSettlementInput(input: unknown): AgentToolExecutionSettlementInput {
  return parse(toolExecutionSettlementInputSchema, input)
}

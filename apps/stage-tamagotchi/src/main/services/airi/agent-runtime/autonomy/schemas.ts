import type {
  AgentAutonomyQuery,
  AgentGoalPutInput,
  AgentGoalTransitionInput,
  AgentScheduleCancelInput,
  AgentScheduleClaimInput,
  AgentScheduleCreateInput,
  AgentScheduleSettlementInput,
} from '@proj-airi/core-agent'

import {
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
  variant,
} from 'valibot'

const identifierSchema = pipe(string(), minLength(1))
const positiveIntegerSchema = pipe(number(), integer(), minValue(1))
const timestampSchema = pipe(number(), integer(), minValue(0))
const sessionQuerySchema = object({ sessionId: identifierSchema })
const goalRefSchema = object({ id: identifierSchema, revision: positiveIntegerSchema })
const blockedReasonSchema = object({ code: identifierSchema, message: identifierSchema })

const goalPutSchema = object({
  id: identifierSchema,
  maxRounds: optional(positiveIntegerSchema),
  objective: identifierSchema,
  sessionId: identifierSchema,
  source: union([literal('self-prompt'), literal('system'), literal('user')]),
  sourceText: optional(string()),
})

const goalTransitionSchema = object({
  blockedReason: optional(blockedReasonSchema),
  goalId: identifierSchema,
  revision: positiveIntegerSchema,
  sessionId: identifierSchema,
  transition: union([
    literal('block'),
    literal('complete'),
    literal('pause'),
    literal('resume'),
    literal('round'),
  ]),
})

const scheduleCommon = {
  goal: optional(goalRefSchema),
  id: identifierSchema,
  prompt: identifierSchema,
  sessionId: identifierSchema,
}

const scheduleCreateSchema = variant('kind', [
  object({ ...scheduleCommon, afterMs: positiveIntegerSchema, kind: literal('after') }),
  object({ ...scheduleCommon, at: timestampSchema, kind: literal('at') }),
  object({ ...scheduleCommon, everyMs: positiveIntegerSchema, kind: literal('every') }),
])

const scheduleClaimSchema = object({
  dispatchId: identifierSchema,
  scheduleId: identifierSchema,
  sessionId: identifierSchema,
})

const scheduleCancelSchema = object({
  scheduleId: identifierSchema,
  sessionId: identifierSchema,
})

const scheduleSettlementSchema = object({
  ...scheduleClaimSchema.entries,
  error: optional(string()),
  status: union([literal('completed'), literal('failed')]),
})

/** Parses an untrusted autonomy projection query. */
export function parseAgentAutonomyQuery(input: unknown): AgentAutonomyQuery {
  return parse(sessionQuerySchema, input)
}

/** Parses an untrusted Goal create/revision command. */
export function parseAgentGoalPutInput(input: unknown): AgentGoalPutInput {
  return parse(goalPutSchema, input)
}

/** Parses an untrusted Goal lifecycle command. */
export function parseAgentGoalTransitionInput(input: unknown): AgentGoalTransitionInput {
  return parse(goalTransitionSchema, input)
}

/** Parses an untrusted schedule cancellation command. */
export function parseAgentScheduleCancelInput(input: unknown): AgentScheduleCancelInput {
  return parse(scheduleCancelSchema, input)
}

/** Parses an untrusted schedule claim command. */
export function parseAgentScheduleClaimInput(input: unknown): AgentScheduleClaimInput {
  return parse(scheduleClaimSchema, input)
}

/** Parses an untrusted after/at/every schedule create command. */
export function parseAgentScheduleCreateInput(input: unknown): AgentScheduleCreateInput {
  return parse(scheduleCreateSchema, input)
}

/** Parses an untrusted scheduled-turn settlement. */
export function parseAgentScheduleSettlementInput(input: unknown): AgentScheduleSettlementInput {
  return parse(scheduleSettlementSchema, input)
}

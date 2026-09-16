import type {
  AgentAutonomyProjection,
  AgentAutonomyQuery,
  AgentGoalPutInput,
  AgentGoalSnapshot,
  AgentGoalTransitionInput,
  AgentScheduleCancelInput,
  AgentScheduleClaimInput,
  AgentScheduleCreateInput,
  AgentScheduleDueNotice,
  AgentScheduleSettlementInput,
  AgentScheduleSnapshot,
  AgentSessionEvent,
  AgentSessionEventInput,
  AgentSessionEventsQuery,
  AgentToolExecutionClaimInput,
  AgentToolExecutionClaimResult,
  AgentToolExecutionSettlementInput,
  AgentTurnCancellationInput,
  AgentTurnCancellationNotice,
  AgentTurnCheckpointInput,
  AgentTurnListQuery,
  AgentTurnRecord,
  AgentTurnRecoveryAckInput,
  AgentTurnSettlementInput,
  AgentTurnStartInput,
  AgentTurnStatusQuery,
} from '@proj-airi/core-agent'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/** Creates or revises the current long-term goal. */
export const electronAgentGoalPut = defineInvokeEventa<AgentGoalSnapshot, AgentGoalPutInput>(
  'eventa:invoke:electron:agent-runtime:goals:put',
)

/** Applies a compare-and-set Goal phase or round transition. */
export const electronAgentGoalTransition = defineInvokeEventa<AgentGoalSnapshot, AgentGoalTransitionInput>(
  'eventa:invoke:electron:agent-runtime:goals:transition',
)

/** Reads event-derived Goal, Schedule, and background task state. */
export const electronAgentAutonomyGet = defineInvokeEventa<AgentAutonomyProjection, AgentAutonomyQuery>(
  'eventa:invoke:electron:agent-runtime:autonomy:get',
)

/** Creates a durable after/at/every autonomous wake schedule. */
export const electronAgentScheduleCreate = defineInvokeEventa<AgentScheduleSnapshot, AgentScheduleCreateInput>(
  'eventa:invoke:electron:agent-runtime:schedules:create',
)

/** Cancels one not-yet-claimed autonomous wake schedule. */
export const electronAgentScheduleCancel = defineInvokeEventa<AgentScheduleSnapshot, AgentScheduleCancelInput>(
  'eventa:invoke:electron:agent-runtime:schedules:cancel',
)

/** Claims one exact due dispatch for the invoking renderer. */
export const electronAgentScheduleClaim = defineInvokeEventa<AgentScheduleSnapshot | undefined, AgentScheduleClaimInput>(
  'eventa:invoke:electron:agent-runtime:schedules:claim',
)

/** Records completion or failure of one claimed scheduled turn. */
export const electronAgentScheduleSettle = defineInvokeEventa<AgentScheduleSnapshot, AgentScheduleSettlementInput>(
  'eventa:invoke:electron:agent-runtime:schedules:settle',
)

/** Main-process push for one persisted schedule occurrence awaiting delivery. */
export const electronAgentScheduleDue = defineEventa<AgentScheduleDueNotice>(
  'eventa:event:electron:agent-runtime:schedules:due',
)

/** Appends one renderer-produced fact to the main-process session event log. */
export const electronAgentSessionEventAppend = defineInvokeEventa<AgentSessionEvent, AgentSessionEventInput>(
  'eventa:invoke:electron:agent-runtime:session-events:append',
)

/** Reads the authoritative main-process event stream after a session cursor. */
export const electronAgentSessionEventsList = defineInvokeEventa<AgentSessionEvent[], AgentSessionEventsQuery>(
  'eventa:invoke:electron:agent-runtime:session-events:list',
)

/** Idempotently imports authored UI/cloud messages with one durability flush. */
export const electronAgentSessionMessagesImport = defineInvokeEventa<AgentSessionEvent[], AgentSessionEventInput[]>(
  'eventa:invoke:electron:agent-runtime:session-events:messages:import',
)

/** Atomically admits, replays, or blocks one model-requested tool side effect. */
export const electronAgentToolExecutionClaim = defineInvokeEventa<AgentToolExecutionClaimResult, AgentToolExecutionClaimInput>(
  'eventa:invoke:electron:agent-runtime:tool-executions:claim',
)

/** Durably settles a tool execution previously admitted by the main process. */
export const electronAgentToolExecutionSettle = defineInvokeEventa<void, AgentToolExecutionSettlementInput>(
  'eventa:invoke:electron:agent-runtime:tool-executions:settle',
)

/** Durably reserves a renderer-owned turn before provider dispatch. */
export const electronAgentTurnStart = defineInvokeEventa<AgentTurnRecord, AgentTurnStartInput>(
  'eventa:invoke:electron:agent-runtime:turns:start',
)

/** Replaces the latest recoverable visible assistant prefix. */
export const electronAgentTurnCheckpoint = defineInvokeEventa<AgentTurnRecord, AgentTurnCheckpointInput>(
  'eventa:invoke:electron:agent-runtime:turns:checkpoint',
)

/** Durably closes one renderer-owned turn. */
export const electronAgentTurnSettle = defineInvokeEventa<AgentTurnRecord, AgentTurnSettlementInput>(
  'eventa:invoke:electron:agent-runtime:turns:settle',
)

/** Requests cancellation for matching active turns. */
export const electronAgentTurnCancel = defineInvokeEventa<AgentTurnRecord[], AgentTurnCancellationInput>(
  'eventa:invoke:electron:agent-runtime:turns:cancel',
)

/** Reads one exact turn or the latest turn in a session. */
export const electronAgentTurnStatus = defineInvokeEventa<AgentTurnRecord | undefined, AgentTurnStatusQuery>(
  'eventa:invoke:electron:agent-runtime:turns:status',
)

/** Lists durable turns for diagnostics and recovery. */
export const electronAgentTurnList = defineInvokeEventa<AgentTurnRecord[], AgentTurnListQuery>(
  'eventa:invoke:electron:agent-runtime:turns:list',
)

/** Marks one interrupted checkpoint as restored into chat history. */
export const electronAgentTurnAcknowledgeRecovery = defineInvokeEventa<AgentTurnRecord, AgentTurnRecoveryAckInput>(
  'eventa:invoke:electron:agent-runtime:turns:acknowledge-recovery',
)

/** Main-process push that aborts exactly one correlated renderer turn. */
export const electronAgentTurnCancellationRequested = defineEventa<AgentTurnCancellationNotice>(
  'eventa:event:electron:agent-runtime:turns:cancellation-requested',
)

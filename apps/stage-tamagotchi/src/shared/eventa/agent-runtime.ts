import type {
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
  ConversationSearchHit,
  ConversationSearchQuery,
} from '@proj-airi/core-agent'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

/** Searches durable conversation messages across sessions without the renderer holding the log. */
export const electronAgentConversationSearch = defineInvokeEventa<ConversationSearchHit[], ConversationSearchQuery>(
  'eventa:invoke:electron:agent-runtime:conversation:search',
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

import type {
  AgentTurnCancellationInput,
  AgentTurnCancellationNotice,
  AgentTurnCheckpointInput,
  AgentTurnControlPort,
  AgentTurnListQuery,
  AgentTurnRecord,
  AgentTurnRecoveryAckInput,
  AgentTurnSettlementInput,
  AgentTurnStartInput,
  AgentTurnStatusQuery,
} from '@proj-airi/core-agent'

/** Handles an exact main-process cancellation in the local execution adapter. */
export type ChatTurnCancellationHandler = (notice: AgentTurnCancellationNotice) => void

/** Platform transport implemented by desktop or another durable host. */
export interface ChatTurnControlTransport {
  /** Marks an interrupted checkpoint as applied to chat history. */
  acknowledgeRecovery: (input: AgentTurnRecoveryAckInput) => Promise<AgentTurnRecord>
  /** Requests cancellation for matching active turns. */
  cancel: (input: AgentTurnCancellationInput) => Promise<AgentTurnRecord[]>
  /** Replaces the latest recoverable visible assistant prefix. */
  checkpoint: (input: AgentTurnCheckpointInput) => Promise<AgentTurnRecord>
  /** Lists durable turns for diagnostics or recovery. */
  list: (query: AgentTurnListQuery) => Promise<AgentTurnRecord[]>
  /** Closes one renderer-owned turn. */
  settle: (input: AgentTurnSettlementInput) => Promise<AgentTurnRecord>
  /** Reserves a renderer-owned turn before provider dispatch. */
  start: (input: AgentTurnStartInput) => Promise<AgentTurnRecord>
  /** Reads one exact turn or the latest turn in a session. */
  status: (query: AgentTurnStatusQuery) => Promise<AgentTurnRecord | undefined>
}

let activeCancellationHandler: ChatTurnCancellationHandler | undefined
let activeTransport: ChatTurnControlTransport | undefined

/** Acknowledges that renderer recovery was applied to durable chat history. */
export async function acknowledgeChatTurnRecovery(
  input: AgentTurnRecoveryAckInput,
): Promise<AgentTurnRecord | undefined> {
  return await queryControlPlane(
    'acknowledge platform Agent turn recovery',
    transport => transport.acknowledgeRecovery(input),
    undefined,
  )
}

/** Installs the current renderer cancellation target with ownership-safe cleanup. */
export function configureChatTurnCancellationHandler(handler?: ChatTurnCancellationHandler) {
  activeCancellationHandler = handler
  return () => {
    if (activeCancellationHandler === handler)
      activeCancellationHandler = undefined
  }
}

/** Installs the current platform turn transport with ownership-safe cleanup. */
export function configureChatTurnTransport(transport?: ChatTurnControlTransport) {
  activeTransport = transport
  return () => {
    if (activeTransport === transport)
      activeTransport = undefined
  }
}

/**
 * Creates the platform-neutral port used by the core chat runtime.
 *
 * Admission and settlement are durability barriers when a desktop transport
 * is installed. A host without that transport returns `false`, allowing the
 * shared web runtime to own its local message events. Checkpoints remain
 * fail-open because a later terminal commit still carries the full message.
 */
export function createChatTurnControlPort(): AgentTurnControlPort {
  return {
    checkpoint: input => invokeControlPlane(
      'checkpoint platform Agent turn',
      transport => transport.checkpoint(input),
    ),
    settle: input => commitControlPlane(transport => transport.settle(input)),
    start: input => commitControlPlane(transport => transport.start(input)),
  }
}

/** Dispatches one correlated cancellation notice to the active chat runtime. */
export function dispatchChatTurnCancellation(notice: AgentTurnCancellationNotice) {
  activeCancellationHandler?.(notice)
}

/** Reads durable turns, returning no records when a platform host is absent. */
export async function listChatTurns(query: AgentTurnListQuery): Promise<AgentTurnRecord[]> {
  return await queryControlPlane('list platform Agent turns', transport => transport.list(query), [])
}

/** Reads one durable turn, returning undefined when a platform host is absent. */
export async function readChatTurnStatus(query: AgentTurnStatusQuery): Promise<AgentTurnRecord | undefined> {
  return await queryControlPlane('read platform Agent turn status', transport => transport.status(query), undefined)
}

/** Requests durable cancellation without making IPC availability own UI responsiveness. */
export async function requestChatTurnCancellation(input: AgentTurnCancellationInput): Promise<AgentTurnRecord[]> {
  return await queryControlPlane(
    'request platform Agent turn cancellation',
    transport => transport.cancel(input),
    [],
  )
}

async function commitControlPlane(
  commit: (transport: ChatTurnControlTransport) => Promise<unknown>,
): Promise<boolean> {
  if (!activeTransport)
    return false

  await commit(activeTransport)
  return true
}

async function invokeControlPlane(
  operation: string,
  invoke: (transport: ChatTurnControlTransport) => Promise<unknown>,
): Promise<void> {
  if (!activeTransport)
    return

  try {
    await invoke(activeTransport)
  }
  catch (error) {
    console.error(`Failed to ${operation}:`, error)
  }
}

async function queryControlPlane<Result>(
  operation: string,
  query: (transport: ChatTurnControlTransport) => Promise<Result>,
  fallback: Result,
): Promise<Result> {
  if (!activeTransport)
    return fallback

  try {
    return await query(activeTransport)
  }
  catch (error) {
    console.error(`Failed to ${operation}:`, error)
    return fallback
  }
}

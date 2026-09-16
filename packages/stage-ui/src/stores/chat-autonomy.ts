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
} from '@proj-airi/core-agent'

/** Platform transport for event-sourced Goal and Schedule commands. */
export interface ChatAutonomyTransport {
  /** Cancels one not-yet-claimed schedule. */
  cancelSchedule: (input: AgentScheduleCancelInput) => Promise<AgentScheduleSnapshot>
  /** Atomically claims one exact due delivery. */
  claimSchedule: (input: AgentScheduleClaimInput) => Promise<AgentScheduleSnapshot | undefined>
  /** Creates one after/at/every schedule. */
  createSchedule: (input: AgentScheduleCreateInput) => Promise<AgentScheduleSnapshot>
  /** Reads the event-derived autonomy projection. */
  get: (query: AgentAutonomyQuery) => Promise<AgentAutonomyProjection>
  /** Creates or revises the session goal. */
  putGoal: (input: AgentGoalPutInput) => Promise<AgentGoalSnapshot>
  /** Settles one claimed scheduled turn. */
  settleSchedule: (input: AgentScheduleSettlementInput) => Promise<AgentScheduleSnapshot>
  /** Applies one Goal phase or round transition. */
  transitionGoal: (input: AgentGoalTransitionInput) => Promise<AgentGoalSnapshot>
}

/** Handles one persisted due notice in the renderer that owns chat execution. */
export type ChatScheduleDueHandler = (notice: AgentScheduleDueNotice) => Promise<void> | void

let activeDueHandler: ChatScheduleDueHandler | undefined
let activeTransport: ChatAutonomyTransport | undefined

/** Cancels one not-yet-claimed wake schedule. */
export async function cancelChatSchedule(input: AgentScheduleCancelInput): Promise<AgentScheduleSnapshot> {
  return await requireTransport().cancelSchedule(input)
}

/** Atomically claims one exact due schedule. */
export async function claimChatSchedule(input: AgentScheduleClaimInput): Promise<AgentScheduleSnapshot | undefined> {
  return await requireTransport().claimSchedule(input)
}

/** Installs the platform autonomy transport with ownership-safe cleanup. */
export function configureChatAutonomyTransport(transport?: ChatAutonomyTransport) {
  activeTransport = transport
  return () => {
    if (activeTransport === transport)
      activeTransport = undefined
  }
}

/** Installs the current renderer's scheduled-turn delivery handler. */
export function configureChatScheduleDueHandler(handler?: ChatScheduleDueHandler) {
  activeDueHandler = handler
  return () => {
    if (activeDueHandler === handler)
      activeDueHandler = undefined
  }
}

/** Creates one durable wake schedule. */
export async function createChatSchedule(input: AgentScheduleCreateInput): Promise<AgentScheduleSnapshot> {
  return await requireTransport().createSchedule(input)
}

/** Routes one main-process due notice to the active chat authority. */
export function dispatchChatScheduleDue(notice: AgentScheduleDueNotice) {
  return activeDueHandler?.(notice)
}

/** Reads one session's event-derived autonomy projection. */
export async function getChatAutonomy(query: AgentAutonomyQuery): Promise<AgentAutonomyProjection> {
  return await requireTransport().get(query)
}

/** Whether this runtime has a durable autonomy host. */
export function hasChatAutonomyTransport(): boolean {
  return activeTransport !== undefined
}

/** Creates or revises the current long-term goal. */
export async function putChatGoal(input: AgentGoalPutInput): Promise<AgentGoalSnapshot> {
  return await requireTransport().putGoal(input)
}

/** Settles one claimed scheduled turn. */
export async function settleChatSchedule(input: AgentScheduleSettlementInput): Promise<AgentScheduleSnapshot> {
  return await requireTransport().settleSchedule(input)
}

/** Applies one compare-and-set Goal transition. */
export async function transitionChatGoal(input: AgentGoalTransitionInput): Promise<AgentGoalSnapshot> {
  return await requireTransport().transitionGoal(input)
}

function requireTransport(): ChatAutonomyTransport {
  if (!activeTransport)
    throw new Error('Durable Agent autonomy is unavailable on this platform')
  return activeTransport
}

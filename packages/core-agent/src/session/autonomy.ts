import type { AgentSessionEvent } from './events'

/** Current autonomy-related state reconstructed from one session log. */
export interface AgentAutonomyProjection {
  /** Current goal, if one has been created. */
  goal?: AgentGoalSnapshot
  /** Current schedules in first-seen order. */
  schedules: AgentScheduleSnapshot[]
  /** Current background tasks in first-seen order. */
  tasks: AgentBackgroundTaskSnapshot[]
}

/** Reads the current goal and schedules for one session. */
export interface AgentAutonomyQuery {
  /** Session whose autonomy projection should be returned. */
  sessionId: string
}

/** Complete post-change background task payload. */
export interface AgentBackgroundTaskChangedPayload {
  /** Full task state after the change. */
  task: AgentBackgroundTaskSnapshot
}

/** Complete background-task state carried by every task event. */
export interface AgentBackgroundTaskSnapshot {
  /** Optional machine-readable blocked or failure explanation. */
  error?: string
  /** Stable task identity scoped to the session. */
  id: string
  /** Human-readable work description. */
  objective: string
  /** Positive mutation revision. */
  revision: number
  /** Current execution lifecycle. */
  state: AgentBackgroundTaskState
  /** Timestamp of the latest mutation. */
  updatedAt: number
}

/** Durable lifecycle for background work visible to AIRI and the user. */
export type AgentBackgroundTaskState = 'blocked' | 'cancelled' | 'completed' | 'failed' | 'paused' | 'queued' | 'running'

/** Human-readable reason attached while a goal cannot advance autonomously. */
export interface AgentGoalBlockedReason {
  /** Stable lower-kebab-case classifier used by policy and UI. */
  code: string
  /** Explanation shown to the user and injected into later recovery context. */
  message: string
}

/** Durable goal change payload. */
export interface AgentGoalChangedPayload {
  /** Complete state after this mutation. */
  goal: AgentGoalSnapshot
  /** Mutation that produced the snapshot. */
  operation: AgentGoalOperation
}

/** Goal mutations recorded as complete post-change snapshots. */
export type AgentGoalOperation = 'block' | 'complete' | 'create' | 'edit' | 'pause' | 'resume' | 'round'

/** Durable lifecycle of one long-running objective. */
export type AgentGoalPhase = 'active' | 'blocked' | 'complete' | 'paused'

/** Creates or revises the one current goal for a session. */
export interface AgentGoalPutInput {
  /** Stable identity used when the session has no current incomplete goal. */
  id: string
  /** Maximum admitted autonomous rounds. @default 8 */
  maxRounds?: number
  /** Desired outcome or next self-directed intention. */
  objective: string
  /** Session that owns the goal. */
  sessionId: string
  /** Source that introduced this revision. */
  source: AgentGoalSource
  /** Original assistant text for Self Prompt audit/replay. */
  sourceText?: string
}

/** Complete post-change goal state carried by every goal event. */
export interface AgentGoalSnapshot {
  /** Present exactly while `phase` is `blocked`. */
  blockedReason?: AgentGoalBlockedReason
  /** Creation timestamp retained across all revisions. */
  createdAt: number
  /** Stable identity scoped to the owning session. */
  id: string
  /** Maximum autonomous continuation rounds admitted for this goal. */
  maxRounds: number
  /** Human-readable desired outcome. */
  objective: string
  /** Durable lifecycle phase. */
  phase: AgentGoalPhase
  /** Positive compare-and-set revision incremented by every mutation. */
  revision: number
  /** Number of admitted continuation rounds. */
  rounds: number
  /** Source that introduced the objective. */
  source: AgentGoalSource
  /** Original assistant text when the goal came from Self Prompt. */
  sourceText?: string
  /** Timestamp of the latest mutation. */
  updatedAt: number
}

/** Origin that first introduced a goal into the session inbox. */
export type AgentGoalSource = 'self-prompt' | 'system' | 'user'

/** Compare-and-set lifecycle mutation for the current goal. */
export interface AgentGoalTransitionInput {
  /** Required when transitioning into `blocked`. */
  blockedReason?: AgentGoalBlockedReason
  /** Current stable goal identity. */
  goalId: string
  /** Current revision required for compare-and-set isolation. */
  revision: number
  /** Session that owns the goal. */
  sessionId: string
  /** Requested lifecycle operation. */
  transition: 'block' | 'complete' | 'pause' | 'resume' | 'round'
}

/** Cancels one current schedule by stable identity. */
export interface AgentScheduleCancelInput {
  /** Stable schedule identity. */
  scheduleId: string
  /** Session that owns the schedule. */
  sessionId: string
}

/** Durable schedule change payload. */
export interface AgentScheduleChangedPayload {
  /** Mutation that produced the snapshot. */
  operation: AgentScheduleOperation
  /** Complete state after this mutation. */
  schedule: AgentScheduleSnapshot
}

/** Selects one due delivery for atomic renderer ownership. */
export interface AgentScheduleClaimInput {
  /** Exact pending dispatch identity. */
  dispatchId: string
  /** Stable schedule identity. */
  scheduleId: string
  /** Session that owns the schedule. */
  sessionId: string
}

/** Creates one durable schedule from a relative, absolute, or fixed-rate rule. */
export type AgentScheduleCreateInput = {
  /** Optional goal resumed by this schedule. */
  goal?: AgentScheduleGoalRef
  /** Stable caller-allocated schedule identity. */
  id: string
  /** Follow-up prompt delivered as an ordinary session turn. */
  prompt: string
  /** Session that owns the schedule. */
  sessionId: string
} & (
  | { afterMs: number, kind: 'after' }
  | { at: number, kind: 'at' }
  | { everyMs: number, kind: 'every' }
)

/** Push notification that one persisted schedule occurrence awaits delivery. */
export interface AgentScheduleDueNotice {
  /** Stable pending dispatch identity. */
  dispatchId: string
  /** Stable schedule identity. */
  scheduleId: string
  /** Session that owns the follow-up turn. */
  sessionId: string
}

/** Optional goal correlation carried by a scheduled continuation. */
export interface AgentScheduleGoalRef {
  /** Stable goal identity. */
  id: string
  /** Goal revision current when the schedule was created. */
  revision: number
}

/** Time rule supported by the durable scheduler. */
export type AgentScheduleKind = 'after' | 'at' | 'every'

/** Schedule mutations recorded as complete post-change snapshots. */
export type AgentScheduleOperation = 'cancel' | 'claim' | 'complete' | 'create' | 'fail' | 'release' | 'trigger'

/** Renderer completion or failure of one claimed schedule delivery. */
export interface AgentScheduleSettlementInput extends AgentScheduleClaimInput {
  /** Failure detail retained for recovery diagnostics. */
  error?: string
  /** Delivery outcome. */
  status: 'completed' | 'failed'
}

/** Complete post-change schedule state carried by every schedule event. */
export interface AgentScheduleSnapshot {
  /** Positive delay accepted when an `after` rule was created. */
  afterMs?: number
  /** Renderer owner that currently holds the pending dispatch. */
  claimedBy?: string
  /** Creation timestamp retained across revisions. */
  createdAt: number
  /** Stable dispatch identity created for one due occurrence. */
  dispatchId?: string
  /** Fixed interval for an `every` rule. */
  everyMs?: number
  /** Optional goal resumed by this delivery. */
  goal?: AgentScheduleGoalRef
  /** Stable identity scoped to the owning session. */
  id: string
  /** Time rule discriminator. */
  kind: AgentScheduleKind
  /** Error retained when delivery failed. */
  lastError?: string
  /** Latest due occurrence selected by the scheduler. */
  occurrenceAt?: number
  /** Prompt injected as an ordinary follow-up turn. */
  prompt: string
  /** Positive mutation revision. */
  revision: number
  /** Next anchor-aligned target in epoch milliseconds. */
  scheduledAt: number
  /** Current durable delivery state. */
  state: AgentScheduleState
  /** Timestamp of the latest mutation. */
  updatedAt: number
}

/** Delivery lifecycle derived entirely from schedule change events. */
export type AgentScheduleState = 'cancelled' | 'claimed' | 'completed' | 'failed' | 'pending' | 'scheduled'

/** Input used to choose the latest due fixed-rate occurrence. */
export interface LatestEveryOccurrenceInput {
  /** Wall-clock decision timestamp. */
  acceptedAt: number
  /** Positive fixed interval in milliseconds. */
  everyMs: number
  /** Earliest anchor-aligned occurrence not previously dispatched. */
  scheduledAt: number
}

/** Latest-only fixed-rate decision that skips an accumulated backlog. */
export interface LatestEveryOccurrenceResult {
  /** First anchor-aligned target strictly after the decision. */
  nextScheduledAt: number
  /** Latest anchor-aligned occurrence due at the decision. */
  occurrenceAt: number
}

/**
 * Replays Goal, Schedule, and background-task state from session events.
 *
 * Full-snapshot events make this projection deterministic and keep renderer UI,
 * restart recovery, and future telemetry on the same source of truth.
 */
export function foldAgentAutonomy(events: readonly AgentSessionEvent[]): AgentAutonomyProjection {
  let goal: AgentGoalSnapshot | undefined
  const schedules = new Map<string, AgentScheduleSnapshot>()
  const tasks = new Map<string, AgentBackgroundTaskSnapshot>()

  for (const event of events) {
    switch (event.type) {
      case 'goal.changed':
        assertNextGoalRevision(goal, event.payload.goal)
        goal = structuredClone(event.payload.goal)
        break
      case 'schedule.changed': {
        const schedule = event.payload.schedule
        assertNextRevision(schedules.get(schedule.id), schedule, 'Schedule')
        schedules.set(schedule.id, structuredClone(schedule))
        break
      }
      case 'task.changed': {
        const task = event.payload.task
        assertNextRevision(tasks.get(task.id), task, 'Background task')
        tasks.set(task.id, structuredClone(task))
        break
      }
    }
  }

  return {
    ...(goal ? { goal: structuredClone(goal) } : {}),
    schedules: [...schedules.values()].map(value => structuredClone(value)),
    tasks: [...tasks.values()].map(value => structuredClone(value)),
  }
}

/**
 * Selects the latest missed fixed-rate occurrence without enumerating backlog entries.
 *
 * The next target remains aligned to the original `scheduledAt` anchor. Calling
 * this with an `acceptedAt` before `scheduledAt` is invalid because no occurrence
 * is due yet.
 */
export function latestEveryOccurrence(input: LatestEveryOccurrenceInput): LatestEveryOccurrenceResult {
  if (!Number.isSafeInteger(input.everyMs) || input.everyMs <= 0)
    throw new Error('Schedule everyMs must be a positive safe integer')
  if (!Number.isSafeInteger(input.scheduledAt) || !Number.isSafeInteger(input.acceptedAt))
    throw new Error('Schedule timestamps must be safe integers')
  if (input.acceptedAt < input.scheduledAt)
    throw new Error('Schedule has no due fixed-rate occurrence')

  const missedIntervals = Math.floor((input.acceptedAt - input.scheduledAt) / input.everyMs)
  const occurrenceAt = input.scheduledAt + missedIntervals * input.everyMs
  const nextScheduledAt = occurrenceAt + input.everyMs
  if (!Number.isSafeInteger(occurrenceAt) || !Number.isSafeInteger(nextScheduledAt))
    throw new Error('Schedule occurrence is outside the safe timestamp range')
  return { nextScheduledAt, occurrenceAt }
}

function assertNextGoalRevision(previous: AgentGoalSnapshot | undefined, next: AgentGoalSnapshot) {
  // A compacted hot log may begin with a later full snapshot. Once a prior
  // snapshot is resident, subsequent revisions must still remain contiguous.
  if (!previous)
    return
  if (previous && previous.id !== next.id) {
    if (previous.phase !== 'complete' || next.revision !== 1)
      throw new Error('A new goal requires the preceding goal to be complete and starts at revision 1')
    return
  }
  assertNextRevision(previous, next, 'Goal')
}

function assertNextRevision(
  previous: undefined | { id?: string, revision: number },
  next: { id?: string, revision: number },
  domain: string,
) {
  if (!previous)
    return
  const expected = (previous?.revision ?? 0) + 1
  if (!Number.isSafeInteger(next.revision) || next.revision !== expected)
    throw new Error(`${domain} revision ${next.revision} is not contiguous; expected ${expected}`)
  if (previous?.id !== undefined && next.id !== previous.id)
    throw new Error(`${domain} identity changed across revisions`)
}

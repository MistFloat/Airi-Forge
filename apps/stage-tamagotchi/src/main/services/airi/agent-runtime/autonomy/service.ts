import type {
  AgentAutonomyProjection,
  AgentAutonomyQuery,
  AgentBackgroundTaskSnapshot,
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
} from '@proj-airi/core-agent'

import { foldAgentAutonomy, latestEveryOccurrence } from '@proj-airi/core-agent'

const DEFAULT_GOAL_ROUNDS = 8
const MIN_EVERY_MS = 5 * 60 * 1_000

/** Append-only session log used by the autonomy projection and command handler. */
export interface AgentAutonomyEventStore {
  /** Appends one authoritative session fact. */
  append: (input: AgentSessionEventInput) => AgentSessionEvent
  /** Waits until preceding appends are durable. */
  flush: () => Promise<void>
  /** Reads one session event stream. */
  list: (query: AgentAutonomyQuery) => AgentSessionEvent[]
  /** Reads every event during startup replay. */
  listAll: () => AgentSessionEvent[]
}

/** Main-process Goal, Schedule, and background-task command surface. */
export interface AgentAutonomyService {
  /** Cancels one current schedule before dispatch ownership is claimed. */
  cancelSchedule: (input: AgentScheduleCancelInput) => Promise<AgentScheduleSnapshot>
  /** Atomically claims one pending due schedule for a renderer owner. */
  claimSchedule: (input: AgentScheduleClaimInput, ownerId: string) => Promise<AgentScheduleSnapshot | undefined>
  /** Creates one durable after/at/every schedule. */
  createSchedule: (input: AgentScheduleCreateInput) => Promise<AgentScheduleSnapshot>
  /** Evaluates due schedules and emits persisted delivery notices. */
  drive: () => Promise<void>
  /** Reads the current event-derived projection for one session. */
  get: (query: AgentAutonomyQuery) => AgentAutonomyProjection
  /** Creates or revises the one current long-term goal. */
  putGoal: (input: AgentGoalPutInput) => Promise<AgentGoalSnapshot>
  /** Releases deliveries owned by a renderer that disappeared. */
  releaseOwner: (ownerId: string) => Promise<AgentScheduleSnapshot[]>
  /** Records completion or failure of a claimed ordinary follow-up turn. */
  settleSchedule: (input: AgentScheduleSettlementInput, ownerId: string) => Promise<AgentScheduleSnapshot>
  /** Subscribes to due notices after their trigger event is durable. */
  subscribeDue: (listener: (notice: AgentScheduleDueNotice) => void) => () => void
  /** Applies a compare-and-set Goal lifecycle transition. */
  transitionGoal: (input: AgentGoalTransitionInput) => Promise<AgentGoalSnapshot>
}

/** Dependencies for the main-process autonomy service. */
export interface AgentAutonomyServiceOptions {
  /** Authoritative append-only session log. */
  eventStore: AgentAutonomyEventStore
  /** Wall-clock source used in complete snapshots. @default Date.now */
  now?: () => number
}

/**
 * Creates durable Goal and Schedule state machines over the session event log.
 *
 * Schedule dispatch also records a background task for durable follow-up.
 * A crash after trigger or claim therefore leaves enough state for replay and
 * redelivery; no renderer-local timeout is required for autonomous wake-up.
 */
export function createAgentAutonomyService(options: AgentAutonomyServiceOptions): AgentAutonomyService {
  const now = options.now ?? Date.now
  const projections = new Map<string, AgentAutonomyProjection>()
  const dueListeners = new Set<(notice: AgentScheduleDueNotice) => void>()
  let driving: Promise<void> | undefined
  let recoverPersistedClaims = true

  const sessionIds = new Set(options.eventStore.listAll().map(event => event.sessionId))
  for (const sessionId of sessionIds)
    replaySession(sessionId)

  async function putGoal(input: AgentGoalPutInput): Promise<AgentGoalSnapshot> {
    const objective = requiredText(input.objective, 'Goal objective')
    const current = projection(input.sessionId).goal
    const updatedAt = now()
    const goal: AgentGoalSnapshot = current && current.phase !== 'complete'
      ? {
          ...current,
          blockedReason: undefined,
          maxRounds: input.maxRounds ?? current.maxRounds,
          objective,
          phase: 'active',
          revision: current.revision + 1,
          source: input.source,
          sourceText: input.sourceText,
          updatedAt,
        }
      : {
          createdAt: updatedAt,
          id: requiredText(input.id, 'Goal id'),
          maxRounds: positiveInteger(input.maxRounds ?? DEFAULT_GOAL_ROUNDS, 'Goal maxRounds'),
          objective,
          phase: 'active',
          revision: 1,
          rounds: 0,
          source: input.source,
          sourceText: input.sourceText,
          updatedAt,
        }

    positiveInteger(goal.maxRounds, 'Goal maxRounds')
    append(input.sessionId, 'goal.changed', {
      goal,
      operation: current && current.phase !== 'complete' ? 'edit' : 'create',
    })
    await options.eventStore.flush()
    return structuredClone(goal)
  }

  async function transitionGoal(input: AgentGoalTransitionInput): Promise<AgentGoalSnapshot> {
    const current = requireGoal(input.sessionId, input.goalId, input.revision)
    const updatedAt = now()
    const next: AgentGoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      updatedAt,
    }

    switch (input.transition) {
      case 'block':
        if (current.phase !== 'active' || !input.blockedReason)
          throw new Error('Blocking requires an active goal and blockedReason')
        next.blockedReason = {
          code: requiredText(input.blockedReason.code, 'Goal blockedReason code'),
          message: requiredText(input.blockedReason.message, 'Goal blockedReason message'),
        }
        next.phase = 'blocked'
        break
      case 'complete':
        if (current.phase === 'complete')
          throw new Error('Goal is already complete')
        next.blockedReason = undefined
        next.phase = 'complete'
        break
      case 'pause':
        if (current.phase !== 'active')
          throw new Error('Only an active goal can be paused')
        next.phase = 'paused'
        break
      case 'resume':
        if (current.phase === 'complete' || current.rounds >= current.maxRounds)
          throw new Error('Goal cannot resume after completion or round exhaustion')
        next.blockedReason = undefined
        next.phase = 'active'
        break
      case 'round':
        if (current.phase !== 'active' || current.rounds >= current.maxRounds)
          throw new Error('Goal round cannot start from this phase or after round exhaustion')
        next.rounds = current.rounds + 1
        break
    }

    append(input.sessionId, 'goal.changed', {
      goal: next,
      operation: input.transition,
    })
    await options.eventStore.flush()
    return structuredClone(next)
  }

  async function createSchedule(input: AgentScheduleCreateInput): Promise<AgentScheduleSnapshot> {
    const current = projection(input.sessionId).schedules.find(schedule => schedule.id === input.id)
    if (current)
      throw new Error(`Schedule ${input.id} already exists in session ${input.sessionId}`)

    const createdAt = now()
    const rule = scheduleRule(input, createdAt)
    const schedule: AgentScheduleSnapshot = {
      ...rule,
      createdAt,
      goal: input.goal ? structuredClone(input.goal) : undefined,
      id: requiredText(input.id, 'Schedule id'),
      kind: input.kind,
      prompt: requiredText(input.prompt, 'Schedule prompt'),
      revision: 1,
      state: 'scheduled',
      updatedAt: createdAt,
    }
    append(input.sessionId, 'schedule.changed', { operation: 'create', schedule })
    await options.eventStore.flush()
    return structuredClone(schedule)
  }

  async function cancelSchedule(input: AgentScheduleCancelInput): Promise<AgentScheduleSnapshot> {
    const current = projection(input.sessionId).schedules.find(schedule => schedule.id === input.scheduleId)
    if (!current)
      throw new Error(`Unknown schedule ${input.scheduleId} in session ${input.sessionId}`)
    if (current.state === 'claimed')
      throw new Error(`Claimed schedule ${input.scheduleId} must settle or be released before cancellation`)
    if (current.state === 'cancelled')
      return structuredClone(current)
    if (current.state === 'completed')
      throw new Error(`Completed schedule ${input.scheduleId} cannot be cancelled`)

    const schedule: AgentScheduleSnapshot = {
      ...current,
      revision: current.revision + 1,
      state: 'cancelled',
      updatedAt: now(),
    }
    append(input.sessionId, 'schedule.changed', { operation: 'cancel', schedule })
    await options.eventStore.flush()
    return structuredClone(schedule)
  }

  async function drive(): Promise<void> {
    if (driving)
      return await driving

    driving = driveSchedules()
    try {
      await driving
    }
    finally {
      driving = undefined
    }
  }

  async function driveSchedules() {
    if (recoverPersistedClaims) {
      recoverPersistedClaims = false
      const owners = new Set<string>()
      for (const state of projections.values()) {
        for (const schedule of state.schedules) {
          if (schedule.state === 'claimed' && schedule.claimedBy)
            owners.add(schedule.claimedBy)
        }
      }
      for (const ownerId of owners)
        await releaseOwner(ownerId)
    }

    const acceptedAt = now()
    const notices: AgentScheduleDueNotice[] = []
    for (const [sessionId, state] of projections) {
      for (const current of [...state.schedules]) {
        if (current.state === 'pending' && current.dispatchId) {
          notices.push(noticeFor(sessionId, current))
          continue
        }
        if (current.state !== 'scheduled' || current.scheduledAt > acceptedAt)
          continue

        const occurrence = current.kind === 'every'
          ? latestEveryOccurrence({
              acceptedAt,
              everyMs: requireEveryMs(current),
              scheduledAt: current.scheduledAt,
            })
          : { nextScheduledAt: current.scheduledAt, occurrenceAt: current.scheduledAt }
        const dispatchId = `${current.id}:${current.revision + 1}:${occurrence.occurrenceAt}`
        const schedule: AgentScheduleSnapshot = {
          ...current,
          dispatchId,
          occurrenceAt: occurrence.occurrenceAt,
          revision: current.revision + 1,
          scheduledAt: occurrence.nextScheduledAt,
          state: 'pending',
          updatedAt: acceptedAt,
        }
        append(sessionId, 'schedule.changed', { operation: 'trigger', schedule })
        appendTask(sessionId, {
          id: dispatchId,
          objective: current.prompt,
          revision: 1,
          state: 'queued',
          updatedAt: acceptedAt,
        })
        notices.push(noticeFor(sessionId, schedule))
      }
    }

    if (notices.length > 0)
      await options.eventStore.flush()
    for (const notice of notices) {
      for (const listener of dueListeners)
        listener(structuredClone(notice))
    }
  }

  async function claimSchedule(
    input: AgentScheduleClaimInput,
    ownerId: string,
  ): Promise<AgentScheduleSnapshot | undefined> {
    const current = findSchedule(input)
    if (!current || current.state !== 'pending' || current.dispatchId !== input.dispatchId)
      return undefined

    let resumedGoal = current.goal
    if (current.goal) {
      let goal = projection(input.sessionId).goal
      if (!goal || goal.id !== current.goal.id) {
        await failPendingScheduleBeforeClaim(input.sessionId, current, `Referenced goal ${current.goal.id} is unavailable`)
        return undefined
      }
      if (goal.phase === 'complete' || goal.rounds >= goal.maxRounds) {
        await failPendingScheduleBeforeClaim(input.sessionId, current, `Goal ${goal.id} reached its autonomous round limit`, goal)
        return undefined
      }
      if (goal.phase === 'blocked' || goal.phase === 'paused') {
        goal = await transitionGoal({
          goalId: goal.id,
          revision: goal.revision,
          sessionId: input.sessionId,
          transition: 'resume',
        })
      }
      goal = await transitionGoal({
        goalId: goal.id,
        revision: goal.revision,
        sessionId: input.sessionId,
        transition: 'round',
      })
      resumedGoal = { id: goal.id, revision: goal.revision }
    }

    const updatedAt = now()
    const schedule: AgentScheduleSnapshot = {
      ...current,
      claimedBy: requiredText(ownerId, 'Schedule owner'),
      goal: resumedGoal,
      revision: current.revision + 1,
      state: 'claimed',
      updatedAt,
    }
    append(input.sessionId, 'schedule.changed', { operation: 'claim', schedule })
    transitionTask(input.sessionId, input.dispatchId, 'running', updatedAt)
    await options.eventStore.flush()
    return structuredClone(schedule)
  }

  async function failPendingScheduleBeforeClaim(
    sessionId: string,
    current: AgentScheduleSnapshot,
    error: string,
    goal?: AgentGoalSnapshot,
  ) {
    if (!current.dispatchId)
      throw new Error(`Pending schedule ${current.id} has no dispatchId`)
    const updatedAt = now()
    append(sessionId, 'schedule.changed', {
      operation: 'fail',
      schedule: {
        ...current,
        lastError: error,
        revision: current.revision + 1,
        state: 'failed',
        updatedAt,
      },
    })
    transitionTask(sessionId, current.dispatchId, 'failed', updatedAt, error)
    if (goal?.phase === 'active') {
      append(sessionId, 'goal.changed', {
        goal: {
          ...goal,
          blockedReason: { code: 'round-limit-reached', message: error },
          phase: 'blocked',
          revision: goal.revision + 1,
          updatedAt,
        },
        operation: 'block',
      })
    }
    await options.eventStore.flush()
  }

  async function settleSchedule(
    input: AgentScheduleSettlementInput,
    ownerId: string,
  ): Promise<AgentScheduleSnapshot> {
    const current = findSchedule(input)
    if (!current || current.state !== 'claimed' || current.dispatchId !== input.dispatchId)
      throw new Error(`Schedule ${input.scheduleId} does not have the claimed dispatch ${input.dispatchId}`)
    if (current.claimedBy !== ownerId)
      throw new Error(`Schedule ${input.scheduleId} owner mismatch`)

    const updatedAt = now()
    const completed = input.status === 'completed'
    const schedule: AgentScheduleSnapshot = {
      ...current,
      claimedBy: undefined,
      dispatchId: current.kind === 'every' && completed ? undefined : current.dispatchId,
      lastError: completed ? undefined : requiredText(input.error ?? 'Scheduled turn failed', 'Schedule error'),
      occurrenceAt: current.kind === 'every' && completed ? undefined : current.occurrenceAt,
      revision: current.revision + 1,
      state: completed ? (current.kind === 'every' ? 'scheduled' : 'completed') : 'failed',
      updatedAt,
    }
    append(input.sessionId, 'schedule.changed', {
      operation: completed ? 'complete' : 'fail',
      schedule,
    })
    transitionTask(input.sessionId, input.dispatchId, completed ? 'completed' : 'failed', updatedAt, input.error)
    await options.eventStore.flush()
    return structuredClone(schedule)
  }

  async function releaseOwner(ownerId: string): Promise<AgentScheduleSnapshot[]> {
    const released: AgentScheduleSnapshot[] = []
    const updatedAt = now()
    for (const [sessionId, state] of projections) {
      for (const current of [...state.schedules]) {
        if (current.state !== 'claimed' || current.claimedBy !== ownerId || !current.dispatchId)
          continue
        const schedule: AgentScheduleSnapshot = {
          ...current,
          claimedBy: undefined,
          revision: current.revision + 1,
          state: 'pending',
          updatedAt,
        }
        append(sessionId, 'schedule.changed', { operation: 'release', schedule })
        transitionTask(sessionId, current.dispatchId, 'queued', updatedAt)
        released.push(schedule)
      }
    }
    if (released.length > 0)
      await options.eventStore.flush()
    return released.map(schedule => structuredClone(schedule))
  }

  function get(query: AgentAutonomyQuery): AgentAutonomyProjection {
    return structuredClone(projection(query.sessionId))
  }

  function subscribeDue(listener: (notice: AgentScheduleDueNotice) => void) {
    dueListeners.add(listener)
    return () => dueListeners.delete(listener)
  }

  function transitionTask(
    sessionId: string,
    taskId: string,
    state: AgentBackgroundTaskSnapshot['state'],
    updatedAt: number,
    error?: string,
  ) {
    const current = projection(sessionId).tasks.find(task => task.id === taskId)
    if (!current)
      throw new Error(`Unknown background task ${taskId}`)
    appendTask(sessionId, {
      ...current,
      error,
      revision: current.revision + 1,
      state,
      updatedAt,
    })
  }

  function appendTask(sessionId: string, task: AgentBackgroundTaskSnapshot) {
    append(sessionId, 'task.changed', { task })
  }

  function append<TType extends AgentSessionEventInput['type']>(
    sessionId: string,
    type: TType,
    payload: Extract<AgentSessionEventInput, { type: TType }>['payload'],
  ) {
    options.eventStore.append({ payload, sessionId, type } as AgentSessionEventInput)
    replaySession(sessionId)
  }

  function replaySession(sessionId: string) {
    projections.set(sessionId, foldAgentAutonomy(options.eventStore.list({ sessionId })))
  }

  function projection(sessionId: string): AgentAutonomyProjection {
    const current = projections.get(sessionId)
    if (current)
      return current
    const empty = foldAgentAutonomy([])
    projections.set(sessionId, empty)
    return empty
  }

  function requireGoal(sessionId: string, goalId: string, revision: number): AgentGoalSnapshot {
    const goal = projection(sessionId).goal
    if (!goal || goal.id !== goalId)
      throw new Error(`Unknown goal ${goalId} in session ${sessionId}`)
    if (goal.revision !== revision)
      throw new Error(`Goal revision mismatch: expected ${goal.revision}, received ${revision}`)
    return goal
  }

  function findSchedule(input: AgentScheduleClaimInput): AgentScheduleSnapshot | undefined {
    return projection(input.sessionId).schedules.find(schedule => schedule.id === input.scheduleId)
  }

  return {
    cancelSchedule,
    claimSchedule,
    createSchedule,
    drive,
    get,
    putGoal,
    releaseOwner,
    settleSchedule,
    subscribeDue,
    transitionGoal,
  }
}

function noticeFor(sessionId: string, schedule: AgentScheduleSnapshot): AgentScheduleDueNotice {
  if (!schedule.dispatchId)
    throw new Error(`Pending schedule ${schedule.id} has no dispatchId`)
  return {
    dispatchId: schedule.dispatchId,
    scheduleId: schedule.id,
    sessionId,
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${field} must be a positive safe integer`)
  return value
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized)
    throw new Error(`${field} must be non-empty`)
  return normalized
}

function requireEveryMs(schedule: AgentScheduleSnapshot): number {
  if (schedule.everyMs === undefined)
    throw new Error(`Every schedule ${schedule.id} has no everyMs`)
  return schedule.everyMs
}

function safeTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer`)
  return value
}

function scheduleRule(input: AgentScheduleCreateInput, now: number) {
  switch (input.kind) {
    case 'after': {
      const afterMs = positiveInteger(input.afterMs, 'Schedule afterMs')
      return { afterMs, scheduledAt: safeTimestamp(now + afterMs, 'Schedule target') }
    }
    case 'at':
      if (input.at <= now)
        throw new Error('Schedule at target must be in the future')
      return { scheduledAt: safeTimestamp(input.at, 'Schedule target') }
    case 'every': {
      const everyMs = positiveInteger(input.everyMs, 'Schedule everyMs')
      if (everyMs < MIN_EVERY_MS)
        throw new Error(`Schedule everyMs must be at least ${MIN_EVERY_MS}`)
      return { everyMs, scheduledAt: safeTimestamp(now + everyMs, 'Schedule target') }
    }
  }
}

import type { AgentGoalSnapshot, AgentScheduleSnapshot } from '@proj-airi/core-agent'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import {
  cancelChatSchedule,
  createChatSchedule,
  getChatAutonomy,
  hasChatAutonomyTransport,
  putChatGoal,
  transitionChatGoal,
} from '../chat-autonomy'

export const SELF_PROMPT_WAKE_DELAY_MS = 45_000

/** Renderer cache for the Goal/Schedule created by one trailing Self Prompt. */
export interface PendingSelfPrompt {
  capturedAt: string
  createdAt: number
  goalId?: string
  goalRevision?: number
  id: string
  prompt: string
  scheduledAt?: number
  scheduleId?: string
  sessionId: string
  sourceText: string
}

/**
 * Goal inbox for Self Prompt input.
 *
 * The local single slot is only a fast UI cache. Electron's append-only
 * session log owns the Goal and Schedule snapshots, so restart recovery and
 * autonomous wake-up never depend on a renderer timeout or a manual memory
 * write.
 */
export const useSelfPromptStore = defineStore('self-prompt', () => {
  const pendingPrompt = useLocalStorageManualReset<null | PendingSelfPrompt>('memory/self/pending-prompt', null)
  const hasPending = computed(() => !!pendingPrompt.value)

  async function captureSelfPrompt(event: { prompt: string, sessionId: string, sourceText: string }) {
    const replaced = pendingPrompt.value
    const createdAt = Date.now()
    const record: PendingSelfPrompt = {
      capturedAt: new Date(createdAt).toISOString(),
      createdAt,
      id: nanoid(),
      prompt: event.prompt,
      sessionId: event.sessionId,
      sourceText: event.sourceText,
    }
    pendingPrompt.value = record

    if (!hasChatAutonomyTransport())
      return record

    try {
      await cancelRecordSchedule(replaced)
      const goal = await putChatGoal({
        id: `goal:${record.id}`,
        objective: record.prompt,
        sessionId: record.sessionId,
        source: 'self-prompt',
        sourceText: record.sourceText,
      })
      const schedule = await createWakeSchedule(record, goal)
      const persisted = withAutonomy(record, goal, schedule)
      if (pendingPrompt.value?.id === record.id)
        pendingPrompt.value = persisted
      return persisted
    }
    catch (error) {
      // The captured intent remains visible and manually actionable even if
      // the desktop autonomy host is temporarily unavailable.
      console.warn('Failed to create durable Self Prompt Goal/Schedule:', error)
      return record
    }
  }

  function consumePending(scheduleId?: string): null | PendingSelfPrompt {
    const record = pendingPrompt.value
    if (scheduleId && record?.scheduleId !== scheduleId)
      return null
    pendingPrompt.value = null
    return record
  }

  /** Cancels only the wake delivery while retaining the Goal for manual execution. */
  async function cancelWake(record: null | PendingSelfPrompt | undefined = pendingPrompt.value) {
    await cancelRecordSchedule(record)
  }

  /** Cancels the scheduled continuation and completes the matching Goal. */
  async function clearPending() {
    const record = pendingPrompt.value
    pendingPrompt.value = null
    if (!record || !hasChatAutonomyTransport())
      return

    await cancelRecordSchedule(record)
    await transitionMatchingGoal(record, 'complete')
  }

  /** Replaces the durable wake target with a fresh 45-second `after` rule. */
  async function restartWake(): Promise<PendingSelfPrompt | undefined> {
    const record = pendingPrompt.value
    if (!record || !hasChatAutonomyTransport())
      return record ?? undefined

    await cancelRecordSchedule(record)
    let projection = await getChatAutonomy({ sessionId: record.sessionId })
    let goal = projection.goal
    if (!goal || goal.phase === 'complete') {
      goal = await putChatGoal({
        id: `goal:${record.id}:${nanoid()}`,
        objective: record.prompt,
        sessionId: record.sessionId,
        source: 'self-prompt',
        sourceText: record.sourceText,
      })
    }
    else if (goal.phase === 'blocked' || goal.phase === 'paused') {
      goal = await transitionChatGoal({
        goalId: goal.id,
        revision: goal.revision,
        sessionId: record.sessionId,
        transition: 'resume',
      })
    }

    projection = await getChatAutonomy({ sessionId: record.sessionId })
    goal = projection.goal ?? goal
    const schedule = await createWakeSchedule(record, goal)
    const persisted = withAutonomy(record, goal, schedule)
    pendingPrompt.value = persisted
    return persisted
  }

  /** Restores the UI cache from the authoritative event-derived projection. */
  async function restoreFromAutonomy(sessionId: string): Promise<PendingSelfPrompt | undefined> {
    if (!hasChatAutonomyTransport())
      return pendingPrompt.value ?? undefined

    const projection = await getChatAutonomy({ sessionId })
    const schedule = projection.schedules
      .filter(item => item.state === 'claimed' || item.state === 'pending' || item.state === 'scheduled')
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    if (!schedule)
      return pendingPrompt.value?.sessionId === sessionId ? pendingPrompt.value : undefined

    const cached = pendingPrompt.value
    const record: PendingSelfPrompt = {
      capturedAt: cached?.scheduleId === schedule.id
        ? cached.capturedAt
        : new Date(schedule.createdAt).toISOString(),
      createdAt: cached?.scheduleId === schedule.id ? cached.createdAt : schedule.createdAt,
      goalId: schedule.goal?.id,
      goalRevision: schedule.goal?.revision,
      id: cached?.scheduleId === schedule.id ? cached.id : `schedule:${schedule.id}`,
      prompt: schedule.prompt,
      scheduledAt: schedule.scheduledAt,
      scheduleId: schedule.id,
      sessionId,
      sourceText: projection.goal?.sourceText ?? cached?.sourceText ?? '',
    }
    pendingPrompt.value = record
    return record
  }

  /** Restores a consumed prompt after a delivery failure for explicit retry. */
  async function restoreFailed(record: PendingSelfPrompt, _error: string) {
    pendingPrompt.value = record
  }

  /** Restores a consumed prompt when a turn cannot start. */
  function restorePending(record: PendingSelfPrompt) {
    pendingPrompt.value = record
  }

  async function cancelRecordSchedule(record: null | PendingSelfPrompt | undefined) {
    if (!record?.scheduleId || !hasChatAutonomyTransport())
      return
    try {
      await cancelChatSchedule({ scheduleId: record.scheduleId, sessionId: record.sessionId })
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? ''
      // A claimed/completed schedule is already owned by its delivery flow and
      // cannot be cancelled by replacement or renderer cache cleanup.
      if (!message.includes('Claimed schedule') && !message.includes('Completed schedule'))
        console.warn('Failed to cancel Self Prompt schedule:', error)
    }
  }

  async function transitionMatchingGoal(record: PendingSelfPrompt, transition: 'complete' | 'pause') {
    try {
      const goal = (await getChatAutonomy({ sessionId: record.sessionId })).goal
      if (!goal || goal.id !== record.goalId || goal.phase === 'complete')
        return
      await transitionChatGoal({
        goalId: goal.id,
        revision: goal.revision,
        sessionId: record.sessionId,
        transition,
      })
    }
    catch (error) {
      console.warn(`Failed to ${transition} Self Prompt Goal:`, error)
    }
  }

  return {
    cancelWake,
    captureSelfPrompt,
    clearPending,
    consumePending,
    hasPending,
    pendingPrompt,
    restartWake,
    restoreFailed,
    restoreFromAutonomy,
    restorePending,
  }
})

async function createWakeSchedule(record: PendingSelfPrompt, goal: AgentGoalSnapshot): Promise<AgentScheduleSnapshot> {
  return await createChatSchedule({
    afterMs: SELF_PROMPT_WAKE_DELAY_MS,
    goal: { id: goal.id, revision: goal.revision },
    id: `schedule:${record.id}:${nanoid()}`,
    kind: 'after',
    prompt: record.prompt,
    sessionId: record.sessionId,
  })
}

function withAutonomy(
  record: PendingSelfPrompt,
  goal: AgentGoalSnapshot,
  schedule: AgentScheduleSnapshot,
): PendingSelfPrompt {
  return {
    ...record,
    goalId: goal.id,
    goalRevision: goal.revision,
    scheduledAt: schedule.scheduledAt,
    scheduleId: schedule.id,
  }
}

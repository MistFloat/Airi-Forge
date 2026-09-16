import type { AgentAutonomyProjection, AgentGoalTransitionInput } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import {
  cancelChatSchedule,
  createChatSchedule,
  getChatAutonomy,
  putChatGoal,
  transitionChatGoal,
} from '@proj-airi/stage-ui/stores/chat-autonomy'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { tool } from '@xsai/tool'
import { z } from 'zod'

const goalParameters = z.object({
  action: z.enum(['set', 'pause', 'resume', 'complete', 'status']),
  maxRounds: z.number().int().positive().nullable(),
  objective: z.string().nullable(),
}).strict()

const scheduleParameters = z.object({
  action: z.enum(['create', 'cancel', 'list']),
  afterSeconds: z.number().int().positive().nullable(),
  at: z.string().nullable(),
  everySeconds: z.number().int().min(300).nullable(),
  kind: z.enum(['after', 'at', 'every']).nullable(),
  prompt: z.string().nullable(),
  scheduleId: z.string().nullable(),
}).strict()

type GoalToolInput = z.infer<typeof goalParameters>
type ScheduleToolInput = z.infer<typeof scheduleParameters>

/** Model tools for durable Goals and after/at/every autonomous follow-ups. */
export async function agentAutonomyTools(): Promise<Tool[]> {
  return await Promise.all([
    tool({
      description: 'Create, inspect, pause, resume, or complete AIRI\'s durable long-term Goal for this conversation. Use set only for a real multi-turn objective.',
      execute: executeGoalAction,
      name: 'agent_goal',
      parameters: goalParameters,
    }),
    tool({
      description: 'Create, list, or cancel a durable autonomous follow-up Schedule. Supports after seconds, an absolute ISO time, or a fixed interval of at least five minutes. A due prompt returns as an ordinary conversation turn even after refresh.',
      execute: executeScheduleAction,
      name: 'agent_schedule',
      parameters: scheduleParameters,
    }),
  ])
}

async function executeGoalAction(input: GoalToolInput): Promise<string> {
  const sessionId = useChatSessionStore().activeSessionId
  if (input.action === 'set') {
    const objective = input.objective?.trim()
    if (!objective)
      throw new Error('objective is required when setting a Goal')
    const goal = await putChatGoal({
      id: `goal:${crypto.randomUUID()}`,
      ...(input.maxRounds === null ? {} : { maxRounds: input.maxRounds }),
      objective,
      sessionId,
      source: 'system',
    })
    return renderProjection(await getChatAutonomy({ sessionId }), `Goal ${goal.id} is active.`)
  }

  const projection = await getChatAutonomy({ sessionId })
  if (input.action === 'status')
    return renderProjection(projection)
  const goal = projection.goal
  if (!goal)
    throw new Error('This conversation has no Goal')

  const transition = input.action satisfies AgentGoalTransitionInput['transition']
  const updated = await transitionChatGoal({
    goalId: goal.id,
    revision: goal.revision,
    sessionId,
    transition,
  })
  return renderProjection(await getChatAutonomy({ sessionId }), `Goal ${updated.id} is ${updated.phase}.`)
}

async function executeScheduleAction(input: ScheduleToolInput): Promise<string> {
  const sessionId = useChatSessionStore().activeSessionId
  if (input.action === 'list')
    return renderProjection(await getChatAutonomy({ sessionId }))
  if (input.action === 'cancel') {
    const scheduleId = input.scheduleId?.trim()
    if (!scheduleId)
      throw new Error('scheduleId is required when cancelling a Schedule')
    const schedule = await cancelChatSchedule({ scheduleId, sessionId })
    return `Schedule ${schedule.id} is ${schedule.state}.`
  }

  const prompt = input.prompt?.trim()
  if (!prompt || !input.kind)
    throw new Error('kind and prompt are required when creating a Schedule')
  const projection = await getChatAutonomy({ sessionId })
  const goal = projection.goal && projection.goal.phase !== 'complete'
    ? { id: projection.goal.id, revision: projection.goal.revision }
    : undefined
  const base = {
    ...(goal ? { goal } : {}),
    id: `schedule:${crypto.randomUUID()}`,
    prompt,
    sessionId,
  }
  const schedule = input.kind === 'after'
    ? await createChatSchedule({
        ...base,
        afterMs: requireSeconds(input.afterSeconds, 'afterSeconds') * 1_000,
        kind: 'after',
      })
    : input.kind === 'every'
      ? await createChatSchedule({
          ...base,
          everyMs: requireSeconds(input.everySeconds, 'everySeconds') * 1_000,
          kind: 'every',
        })
      : await createChatSchedule({
          ...base,
          at: parseFutureTime(input.at),
          kind: 'at',
        })
  return `Schedule ${schedule.id} is ${schedule.state} for ${new Date(schedule.scheduledAt).toISOString()}.`
}

function parseFutureTime(value: null | string): number {
  const timestamp = value ? Date.parse(value) : Number.NaN
  if (!Number.isSafeInteger(timestamp) || timestamp <= Date.now())
    throw new Error('at must be a valid future ISO timestamp')
  return timestamp
}

function renderProjection(projection: AgentAutonomyProjection, prefix?: string): string {
  const snapshot = {
    goal: projection.goal
      ? {
          blockedReason: projection.goal.blockedReason,
          id: projection.goal.id,
          maxRounds: projection.goal.maxRounds,
          objective: projection.goal.objective,
          phase: projection.goal.phase,
          revision: projection.goal.revision,
          rounds: projection.goal.rounds,
        }
      : null,
    schedules: projection.schedules.map(schedule => ({
      id: schedule.id,
      kind: schedule.kind,
      lastError: schedule.lastError,
      scheduledAt: new Date(schedule.scheduledAt).toISOString(),
      state: schedule.state,
    })),
    tasks: projection.tasks.map(task => ({ id: task.id, objective: task.objective, state: task.state })),
  }
  return [prefix, JSON.stringify(snapshot)].filter(Boolean).join('\n')
}

function requireSeconds(value: null | number, field: string): number {
  if (!Number.isSafeInteger(value) || value === null || value <= 0)
    throw new Error(`${field} must be a positive integer`)
  return value
}

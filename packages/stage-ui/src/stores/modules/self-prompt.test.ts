import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SELF_PROMPT_WAKE_DELAY_MS, useSelfPromptStore } from './self-prompt'

const storageMock = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}))

const autonomyMocks = vi.hoisted(() => ({
  cancelSchedule: vi.fn(),
  createSchedule: vi.fn(),
  get: vi.fn(),
  putGoal: vi.fn(),
  transitionGoal: vi.fn(),
}))

vi.mock('@proj-airi/stage-shared/composables', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    useLocalStorageManualReset: <T>(key: string, initialValue: T) => {
      const value = vue.ref((storageMock.values.has(key) ? storageMock.values.get(key) : initialValue) as T)
      vue.watch(value, next => storageMock.values.set(key, next), { deep: true, flush: 'sync' })
      return Object.assign(value, {
        reset: () => {
          value.value = initialValue
        },
      })
    },
  }
})

vi.mock('../chat-autonomy', () => ({
  cancelChatSchedule: autonomyMocks.cancelSchedule,
  createChatSchedule: autonomyMocks.createSchedule,
  getChatAutonomy: autonomyMocks.get,
  hasChatAutonomyTransport: () => true,
  putChatGoal: autonomyMocks.putGoal,
  transitionChatGoal: autonomyMocks.transitionGoal,
}))

describe('useSelfPromptStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storageMock.values.clear()
    for (const mock of Object.values(autonomyMocks))
      mock.mockReset()

    autonomyMocks.putGoal.mockResolvedValue({
      createdAt: 100,
      id: 'goal-1',
      maxRounds: 8,
      objective: 'continue',
      phase: 'active',
      revision: 1,
      rounds: 0,
      source: 'self-prompt',
      updatedAt: 100,
    })
    autonomyMocks.createSchedule.mockImplementation(async input => ({
      afterMs: input.afterMs,
      createdAt: 100,
      goal: input.goal,
      id: input.id,
      kind: input.kind,
      prompt: input.prompt,
      revision: 1,
      scheduledAt: 100 + input.afterMs,
      state: 'scheduled',
      updatedAt: 100,
    }))
    autonomyMocks.cancelSchedule.mockResolvedValue({ state: 'cancelled' })
    autonomyMocks.get.mockResolvedValue({ schedules: [], tasks: [], workflows: [] })
  })

  it('converts a captured Self Prompt into a Goal and durable after Schedule', async () => {
    const store = useSelfPromptStore()
    const record = await store.captureSelfPrompt({
      prompt: '继续调查量子纠缠',
      sessionId: 'session-1',
      sourceText: '正文\n// 继续调查量子纠缠',
    })

    expect(autonomyMocks.putGoal).toHaveBeenCalledWith(expect.objectContaining({
      objective: '继续调查量子纠缠',
      sessionId: 'session-1',
      source: 'self-prompt',
    }))
    expect(autonomyMocks.createSchedule).toHaveBeenCalledWith(expect.objectContaining({
      afterMs: SELF_PROMPT_WAKE_DELAY_MS,
      goal: { id: 'goal-1', revision: 1 },
      kind: 'after',
      prompt: '继续调查量子纠缠',
    }))
    expect(record.scheduleId).toMatch(/^schedule:/)
    expect(store.pendingPrompt?.goalId).toBe('goal-1')
    expect(store.pendingPrompt?.scheduledAt).toBe(100 + SELF_PROMPT_WAKE_DELAY_MS)
  })

  it('cancels the replaced schedule while retaining a bounded UI slot', async () => {
    const store = useSelfPromptStore()
    await store.captureSelfPrompt({ prompt: '第一句', sessionId: 's', sourceText: 'a' })
    const firstScheduleId = store.pendingPrompt?.scheduleId
    await store.captureSelfPrompt({ prompt: '第二句', sessionId: 's', sourceText: 'b' })

    expect(autonomyMocks.cancelSchedule).toHaveBeenCalledWith({
      scheduleId: firstScheduleId,
      sessionId: 's',
    })
    expect(store.pendingPrompt?.prompt).toBe('第二句')
  })

  it('clears the cache, cancels its Schedule, and completes the matching Goal', async () => {
    const store = useSelfPromptStore()
    await store.captureSelfPrompt({ prompt: '用户决定停止', sessionId: 's', sourceText: 'x' })
    autonomyMocks.get.mockResolvedValue({
      goal: {
        id: 'goal-1',
        phase: 'active',
        revision: 1,
      },
      schedules: [],
      tasks: [],
      workflows: [],
    })

    await store.clearPending()

    expect(store.pendingPrompt).toBeNull()
    expect(autonomyMocks.cancelSchedule).toHaveBeenCalledTimes(1)
    expect(autonomyMocks.transitionGoal).toHaveBeenCalledWith({
      goalId: 'goal-1',
      revision: 1,
      sessionId: 's',
      transition: 'complete',
    })
  })

  it('restores the UI slot from event-derived Schedule state after refresh', async () => {
    autonomyMocks.get.mockResolvedValue({
      goal: { id: 'goal-restored', sourceText: 'original reply' },
      schedules: [{
        createdAt: 200,
        goal: { id: 'goal-restored', revision: 3 },
        id: 'schedule-restored',
        kind: 'after',
        prompt: 'resume this',
        revision: 2,
        scheduledAt: 45_200,
        state: 'pending',
        updatedAt: 201,
      }],
      tasks: [],
      workflows: [],
    })
    const store = useSelfPromptStore()

    await store.restoreFromAutonomy('session-1')

    expect(store.pendingPrompt).toMatchObject({
      goalId: 'goal-restored',
      goalRevision: 3,
      prompt: 'resume this',
      scheduleId: 'schedule-restored',
      sessionId: 'session-1',
    })
  })

  it('keeps a failed delivery available for an explicit retry', async () => {
    const store = useSelfPromptStore()
    await store.captureSelfPrompt({ prompt: 'retry me', sessionId: 's', sourceText: 'x' })
    const pending = store.consumePending()
    if (!pending)
      throw new Error('Expected a pending prompt')

    await store.restoreFailed(pending, 'provider unavailable')

    expect(store.pendingPrompt?.id).toBe(pending.id)
  })
})

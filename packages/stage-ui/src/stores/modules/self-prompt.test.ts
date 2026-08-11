import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSelfPromptStore } from './self-prompt'

const storageMock = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}))

vi.mock('@proj-airi/stage-shared/composables', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')

  return {
    useLocalStorageManualReset: <T>(key: string, initialValue: T) => {
      const value = vue.ref((storageMock.values.has(key) ? storageMock.values.get(key) : initialValue) as T)

      storageMock.values.set(key, value.value)
      vue.watch(value, (newValue) => {
        storageMock.values.set(key, newValue)
      }, { flush: 'sync' })

      return Object.assign(value, {
        reset: () => {
          value.value = initialValue
        },
      })
    },
  }
})

// memory-long-term is only touched when configured; stub it so the store can be
// imported without wiring up PostgreSQL/embedding backends.
const longTermMock = vi.hoisted(() => ({
  configured: false,
  saveMemory: vi.fn(),
}))

const selfPromptRepoMocks = vi.hoisted(() => ({
  markDiscarded: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
  markSent: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../composables/use-duck-db', () => ({
  useDuckDb: () => ({
    getDb: vi.fn().mockResolvedValue({ value: {} }),
  }),
}))

vi.mock('../../database/repos/self-prompt.repo', () => ({
  createSelfPromptRepo: () => selfPromptRepoMocks,
}))

vi.mock('./memory-long-term', () => ({
  useMemoryLongTermStore: () => longTermMock,
}))

describe('useSelfPromptStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    storageMock.values.clear()
    longTermMock.configured = false
    longTermMock.saveMemory.mockReset()
    for (const repoMock of Object.values(selfPromptRepoMocks))
      repoMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('captures a self prompt into the single-slot pending channel', async () => {
    const store = useSelfPromptStore()

    expect(store.hasPending).toBe(false)

    await store.captureSelfPrompt({
      prompt: '我想去查一下量子纠缠的最新进展',
      sessionId: 'session-1',
      sourceText: '正文\n// 我想去查一下量子纠缠的最新进展',
    })

    expect(store.hasPending).toBe(true)
    expect(store.pendingPrompt?.prompt).toBe('我想去查一下量子纠缠的最新进展')
    expect(store.pendingPrompt?.sessionId).toBe('session-1')
    expect(selfPromptRepoMocks.save).toHaveBeenCalledWith(expect.objectContaining({
      deliveryStatus: 'pending',
      prompt: '我想去查一下量子纠缠的最新进展',
      sessionId: 'session-1',
    }))
  })

  it('replaces the previous pending prompt (single-slot, bounded queue)', async () => {
    const store = useSelfPromptStore()

    await store.captureSelfPrompt({ prompt: '第一句', sessionId: 's', sourceText: 'a' })
    const firstId = store.pendingPrompt?.id
    await store.captureSelfPrompt({ prompt: '第二句', sessionId: 's', sourceText: 'b' })

    expect(store.pendingPrompt?.prompt).toBe('第二句')
    expect(selfPromptRepoMocks.markDiscarded).toHaveBeenCalledWith(firstId, expect.any(Number))
  })

  it('consumePending drains the slot and returns the record', async () => {
    const store = useSelfPromptStore()

    await store.captureSelfPrompt({ prompt: '要消费的一句', sessionId: 's', sourceText: 'x' })

    const consumed = store.consumePending()
    expect(consumed?.prompt).toBe('要消费的一句')
    expect(store.hasPending).toBe(false)
    expect(store.consumePending()).toBeNull()
  })

  it('clears a pending prompt without consuming it as a turn', async () => {
    const store = useSelfPromptStore()

    await store.captureSelfPrompt({ prompt: '用户决定不发送', sessionId: 's', sourceText: 'x' })
    await store.clearPending()

    expect(store.hasPending).toBe(false)
    expect(store.pendingPrompt).toBeNull()
    expect(selfPromptRepoMocks.markDiscarded).toHaveBeenCalledWith(expect.any(String), expect.any(Number))
  })

  it('marks a successfully delivered prompt as sent', async () => {
    const store = useSelfPromptStore()
    await store.captureSelfPrompt({ prompt: '已经发送', sessionId: 's', sourceText: 'x' })
    const pending = store.consumePending()
    if (!pending)
      throw new Error('Expected a pending prompt')

    await store.markSent(pending.id)

    expect(selfPromptRepoMocks.markSent).toHaveBeenCalledWith(pending.id, expect.any(Number))
  })

  it('keeps a failed prompt pending and records its last error', async () => {
    const store = useSelfPromptStore()
    await store.captureSelfPrompt({ prompt: '发送失败', sessionId: 's', sourceText: 'x' })
    const pending = store.consumePending()
    if (!pending)
      throw new Error('Expected a pending prompt')

    await store.restoreFailed(pending, 'provider unavailable')

    expect(store.pendingPrompt?.id).toBe(pending.id)
    expect(selfPromptRepoMocks.markFailed).toHaveBeenCalledWith(pending.id, 'provider unavailable')
  })

  it('persists a best-effort copy to long-term memory when configured', async () => {
    longTermMock.configured = true
    longTermMock.saveMemory.mockResolvedValue(undefined)
    const store = useSelfPromptStore()

    await store.captureSelfPrompt({
      prompt: '值得记住的问题',
      sessionId: 's',
      sourceText: '正文',
    })

    expect(longTermMock.saveMemory).toHaveBeenCalledTimes(1)
    const arg = longTermMock.saveMemory.mock.calls[0][0]
    expect(arg.content).toBe('值得记住的问题')
    expect(arg.tags).toContain('self-prompt')
    // The local slot stays the source of truth even when the durable copy is written.
    expect(store.hasPending).toBe(true)
  })

  it('fails open when long-term memory persistence throws', async () => {
    longTermMock.configured = true
    longTermMock.saveMemory.mockRejectedValue(new Error('db down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = useSelfPromptStore()
    await store.captureSelfPrompt({ prompt: '即使记忆库挂了也要保留', sessionId: 's', sourceText: '正文' })

    expect(store.pendingPrompt?.prompt).toBe('即使记忆库挂了也要保留')
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })
})

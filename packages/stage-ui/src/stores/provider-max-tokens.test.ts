import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProviderMaxTokensStore } from './provider-max-tokens'

vi.mock('@proj-airi/stage-shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@proj-airi/stage-shared')>()
  return {
    ...original,
    isStageTamagotchi: () => true,
  }
})

describe('provider max tokens store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('uses project persistence as the authoritative provider override', async () => {
    const save = vi.fn(async ({ maxTokens, providerId }: { maxTokens?: number, providerId: string }) => ({
      default: 16384,
      providers: maxTokens === undefined ? {} : { [providerId]: maxTokens },
      version: 1 as const,
    }))
    const store = useProviderMaxTokensStore()
    store.configurePersistence({
      load: async () => ({ default: 16384, providers: { deepseek: 65536 }, version: 1 }),
      set: save,
    })

    await store.initialize()
    await store.setProviderMaxTokens('deepseek', 32768)

    expect(store.getProviderMaxTokens('deepseek')).toBe(32768)
    expect(save).toHaveBeenCalledWith({ maxTokens: 32768, providerId: 'deepseek' })
  })

  it('migrates and removes the old provider-local maxTokens field', async () => {
    const save = vi.fn(async ({ maxTokens, providerId }: { maxTokens?: number, providerId: string }) => ({
      default: 16384,
      providers: maxTokens === undefined ? {} : { [providerId]: maxTokens },
      version: 1 as const,
    }))
    const store = useProviderMaxTokensStore()
    store.configurePersistence({
      load: async () => ({ default: 16384, providers: {}, version: 1 }),
      set: save,
    })
    const legacyConfig: Record<string, unknown> = {
      apiKey: 'kept-in-existing-storage',
      maxTokens: 65536,
    }

    await store.migrateProviderConfig('deepseek', legacyConfig)

    expect(legacyConfig).toEqual({ apiKey: 'kept-in-existing-storage' })
    expect(store.getProviderMaxTokens('deepseek')).toBe(65536)
    expect(save).toHaveBeenCalledWith({ maxTokens: 65536, providerId: 'deepseek' })
  })

  it('refreshes values changed by another Electron window before a request', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce({ default: 16384, providers: { deepseek: 32768 }, version: 1 })
      .mockResolvedValueOnce({ default: 16384, providers: { deepseek: 65536 }, version: 1 })
    const store = useProviderMaxTokensStore()
    store.configurePersistence({
      load,
      set: vi.fn(),
    })

    await store.initialize()
    await store.refresh()

    expect(store.getProviderMaxTokens('deepseek')).toBe(65536)
    expect(load).toHaveBeenCalledTimes(2)
  })
})

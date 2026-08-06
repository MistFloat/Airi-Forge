import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStageModel } from '../settings/stage-model'
import { useAiriCardStore } from './airi-card'

vi.mock('./artistry', async () => {
  const { defineStore } = await import('pinia')

  return {
    useArtistryStore: defineStore('artistry', {
      actions: {
        resetToGlobal() {},
      },
      state: () => ({
        activeModel: 'mock-artistry-model',
        activeProvider: 'mock-artistry-provider',
        defaultPromptPrefix: 'mock-artistry-prefix',
        globalModel: 'mock-artistry-model',
        globalPromptPrefix: 'mock-artistry-prefix',
        globalProvider: 'mock-artistry-provider',
        globalProviderOptions: {},
        providerOptions: {},
      }),
    }),
  }
})

vi.mock('./consciousness', async () => {
  const { defineStore } = await import('pinia')

  return {
    useConsciousnessStore: defineStore('consciousness', {
      state: () => ({
        activeModel: 'mock-consciousness-model',
        activeProvider: 'mock-consciousness-provider',
      }),
    }),
  }
})

vi.mock('./speech', async () => {
  const { defineStore } = await import('pinia')

  return {
    useSpeechStore: defineStore('speech', {
      state: () => ({
        activeSpeechModel: 'mock-speech-model',
        activeSpeechProvider: 'mock-speech-provider',
        activeSpeechVoiceId: 'mock-speech-voice',
      }),
    }),
  }
})

vi.mock('./vision', async () => {
  const { defineStore } = await import('pinia')

  return {
    useVisionStore: defineStore('vision', {
      state: () => ({
        activeModel: 'mock-vision-model',
        activeProvider: 'mock-vision-provider',
      }),
    }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

/**
 * @example
 * describe('airi-card store', () => {})
 */
describe('airi-card store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /**
   * @example
   * it('persists selected module config on active card', () => {})
   */
  it('persists selected module config on active card', () => {
    const stageModelStore = useSettingsStageModel()
    stageModelStore.stageModelSelected = 'preset-live2d-1'

    const cardStore = useAiriCardStore()
    cardStore.initialize()

    expect(cardStore.updateActiveCardDisplayModel('display-model-iru-v2')).toBe(true)
    expect(cardStore.updateActiveCardConsciousness({ model: 'anthropic/claude-sonnet', provider: 'openrouter-ai' })).toBe(true)
    expect(cardStore.updateActiveCardVision({ model: 'llava', provider: 'ollama' })).toBe(true)
    expect(cardStore.updateActiveCardSpeech({ model: 'eleven_multilingual_v2', provider: 'elevenlabs', voice_id: 'aria' })).toBe(true)
    expect(cardStore.activeCard?.extensions.airi.modules).toMatchObject({
      consciousness: { model: 'anthropic/claude-sonnet', provider: 'openrouter-ai' },
      displayModelId: 'display-model-iru-v2',
      speech: { model: 'eleven_multilingual_v2', provider: 'elevenlabs', voice_id: 'aria' },
      vision: { model: 'llava', provider: 'ollama' },
    })
    expect(stageModelStore.stageModelSelected).toBe('preset-live2d-1')
  })

  /**
   * @example
   * it('updates speech config on the active card', () => {})
   */
  it('updates speech config on the active card', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()

    expect(cardStore.updateActiveCardSpeech({ model: 'eleven_multilingual_v2', provider: 'elevenlabs', voice_id: 'aria' })).toBe(true)
    expect(cardStore.activeCard?.extensions.airi.modules.speech).toMatchObject({
      model: 'eleven_multilingual_v2',
      provider: 'elevenlabs',
      voice_id: 'aria',
    })
  })
})

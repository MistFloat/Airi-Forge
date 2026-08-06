import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OFFICIAL_SPEECH_PROVIDER_ID, OFFICIAL_SPEECH_STREAMING_PROVIDER_ID, providerOfficialSpeech, providerOfficialSpeechStreaming } from '../../libs/providers/providers/official'
import { useProvidersStore } from '../providers'
import { convertProviderDefinitionToMetadata } from '../providers/converters'
import { toSignedPercent, useSpeechStore } from './speech'

// NOTICE:
// convertProviderDefinitionToMetadata expects a ComposerTranslation for
// descriptionLocalize/nameLocalize/onboardingFields. The official speech
// definitions resolve those through their own identity extractor and expose
// no onboarding fields/validators, so a plain identity key function suffices.
const translateKey = (key: string): string => key

const i18nState = vi.hoisted(() => ({
  locale: { value: 'en-US' },
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: i18nState.locale,
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

describe('speech store helpers', () => {
  beforeEach(() => {
    i18nState.locale.value = 'en-US'
    setActivePinia(createPinia())

    // NOTICE:
    // vitest does not run unplugin-info, so `translatedProviderMetadata` is
    // empty and the `defineProvider()` registry never reaches `providerMetadata`
    // (providers.ts). Production gets these entries injected at build time.
    // Run the definitions through the same converter the build uses so the
    // resulting metadata exposes `capabilities.listVoices/listModels` wired to
    // the real implementations (which also populate the server `recommended`
    // voice map the auto-pick assertions rely on).
    const providersStore = useProvidersStore()
    providersStore.providerMetadata[OFFICIAL_SPEECH_PROVIDER_ID] = convertProviderDefinitionToMetadata(providerOfficialSpeech, translateKey)
    providersStore.providerMetadata[OFFICIAL_SPEECH_STREAMING_PROVIDER_ID] = convertProviderDefinitionToMetadata(providerOfficialSpeechStreaming, translateKey)
    providersStore.providerRuntimeState[OFFICIAL_SPEECH_PROVIDER_ID] = {
      isConfigured: true,
      isLoadingModels: false,
      modelLoadError: null,
      models: [],
    }
    providersStore.providerRuntimeState[OFFICIAL_SPEECH_STREAMING_PROVIDER_ID] = {
      isConfigured: false,
      isLoadingModels: false,
      modelLoadError: null,
      models: [],
    }
  })

  it('formats positive percentages with a plus sign', () => {
    expect(toSignedPercent(25)).toBe('+25%')
  })

  it('formats negative percentages without a double minus', () => {
    expect(toSignedPercent(-20)).toBe('-20%')
    expect(toSignedPercent(-20)).not.toContain('--')
  })

  it('formats zero as 0%', () => {
    expect(toSignedPercent(0)).toBe('0%')
  })

  /**
   * @example
   * speechStore.resolveSpeechInput({ text, voice, providerConfig: { voice: 'plain' } })
   */
  it('leaves speech input unchanged by default', () => {
    const speechStore = useSpeechStore()
    const voice = {
      id: 'plain-voice',
      languages: [{ code: 'en-US', title: 'English' }],
      name: 'Plain Voice',
      provider: 'openai-compatible-audio-speech',
    }

    const request = speechStore.resolveSpeechInput({
      providerConfig: { voice: 'plain-voice' },
      text: 'hello',
      voice,
    })

    expect(request.input).toBe('hello')
    expect(request.providerConfig).toEqual({ voice: 'plain-voice' })
  })

  it('applies configured pitch through SSML when supported', () => {
    const speechStore = useSpeechStore()
    const voice = {
      gender: 'neutral',
      id: 'voice-1',
      languages: [{ code: 'en-US', title: 'English' }],
      name: 'Voice 1',
      provider: OFFICIAL_SPEECH_PROVIDER_ID,
    }

    const request = speechStore.resolveSpeechInput({
      forceSSML: true,
      providerConfig: { pitch: 20 },
      supportsSSML: true,
      text: 'hello',
      voice,
    })

    expect(request.input).toContain('<prosody')
    expect(request.input).toContain('pitch="+20%"')
  })

  /**
   * @example
   * speechStore.resolveSpeechInput({ text, voice, forceSSML: true, supportsSSML: false })
   */
  it('keeps official adapter-backed speech input as plain text when global SSML is enabled', () => {
    const speechStore = useSpeechStore()
    const voice = {
      gender: 'neutral',
      id: 'voice-1',
      languages: [{ code: 'en-US', title: 'English' }],
      name: 'Voice 1',
      provider: OFFICIAL_SPEECH_PROVIDER_ID,
    }

    // ROOT CAUSE:
    //
    // Auto TTS can enable global SSML before the server routes the official
    // speech provider to DashScope CosyVoice. DashScope rejects `<speak>...`
    // payloads with `SSML text is not supported at the moment!`, so providers
    // that apply prosody through adapter options must keep the text field plain.
    const request = speechStore.resolveSpeechInput({
      forceSSML: true,
      providerConfig: { pitch: 0 },
      supportsSSML: false,
      text: 'hello',
      voice,
    })

    expect(request.input).toBe('hello')
    expect(request.input).not.toContain('<speak')
  })

  /**
   * @example
   * await speechStore.loadVoicesForProvider(OFFICIAL_SPEECH_STREAMING_PROVIDER_ID, 'volcengine/seed-tts-2.0')
   */
  it('does not load streaming voices before server availability is confirmed', async () => {
    const providersStore = useProvidersStore()
    const speechStore = useSpeechStore()
    const listVoices = vi.fn(async () => [])
    const metadata = providersStore.providerMetadata[OFFICIAL_SPEECH_STREAMING_PROVIDER_ID]
    metadata.capabilities.listVoices = listVoices
    providersStore.providerRuntimeState[OFFICIAL_SPEECH_STREAMING_PROVIDER_ID].isConfigured = false

    const voices = await speechStore.loadVoicesForProvider(
      OFFICIAL_SPEECH_STREAMING_PROVIDER_ID,
      'volcengine/seed-tts-2.0',
    )

    expect(voices).toEqual([])
    expect(listVoices).not.toHaveBeenCalled()
  })

  /**
   * @example
   * speechStore.ensureActiveSpeechModel()
   */
  it('keeps a real Voice Pack TTS model selected for the regular official provider', () => {
    const providersStore = useProvidersStore()
    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = OFFICIAL_SPEECH_PROVIDER_ID
    speechStore.activeSpeechModel = 'volcengine/pool-a'
    speechStore.activeSpeechVoiceId = 'voice-a'
    providersStore.providerRuntimeState[OFFICIAL_SPEECH_PROVIDER_ID].models = [
      { id: 'volcengine/pool-a', name: 'volcengine/pool-a', provider: OFFICIAL_SPEECH_PROVIDER_ID },
      { id: 'microsoft/v1', name: 'microsoft/v1', provider: OFFICIAL_SPEECH_PROVIDER_ID },
    ]

    speechStore.ensureActiveSpeechModel()

    expect(speechStore.activeSpeechModel).toBe('volcengine/pool-a')
    expect(speechStore.activeSpeechVoiceId).toBe('voice-a')
  })

  /**
   * @example
   * speechStore.ensureActiveSpeechModel()
   */
  it('resets stale streaming model to the server default when the regular official speech provider is active', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('/api/v1/audio/models')) {
        return new Response(JSON.stringify({
          default: 'microsoft/v1',
          models: [
            { id: 'alibaba/cosyvoice-v2', name: 'alibaba/cosyvoice-v2' },
            { id: 'microsoft/v1', name: 'microsoft/v1' },
          ],
        }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
      }
      return new Response(JSON.stringify({ recommended: {}, voices: [] }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }) as typeof fetch)

    const providersStore = useProvidersStore()
    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = OFFICIAL_SPEECH_PROVIDER_ID
    speechStore.activeSpeechModel = 'volcengine/seed-tts-2.0'
    speechStore.activeSpeechVoiceId = 'zh_female_x'
    speechStore.activeSpeechVoice = {
      id: 'zh_female_x',
      languages: [],
      name: 'X',
      provider: OFFICIAL_SPEECH_STREAMING_PROVIDER_ID,
    }
    try {
      providersStore.providerRuntimeState[OFFICIAL_SPEECH_PROVIDER_ID].models = await providerOfficialSpeech.extraMethods!.listModels!(
        {},
        providerOfficialSpeech.createProvider({}),
      )

      speechStore.ensureActiveSpeechModel()

      expect(speechStore.activeSpeechModel).toBe('microsoft/v1')
      expect(speechStore.activeSpeechVoiceId).toBe('')
      expect(speechStore.activeSpeechVoice).toBeUndefined()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  /**
   * @example
   * await speechStore.loadVoicesForProvider(OFFICIAL_SPEECH_PROVIDER_ID, 'microsoft/v1')
   */
  it('uses the server recommended voice when the persisted official voice is stale', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('/api/v1/audio/models')) {
        return new Response(JSON.stringify({
          default: 'microsoft/v1',
          models: [{ id: 'microsoft/v1', name: 'microsoft/v1' }],
        }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
      }
      return new Response(JSON.stringify({
        recommended: { 'en-US': 'en-US-AvaMultilingualNeural' },
        voices: [
          {
            id: 'en-US-JennyNeural',
            languages: [{ code: 'en-US', title: 'English' }],
            name: 'Jenny',
          },
          {
            id: 'en-US-AvaMultilingualNeural',
            languages: [{ code: 'en-US', title: 'English' }],
            name: 'Ava',
          },
        ],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
    }) as typeof fetch)

    const providersStore = useProvidersStore()
    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = OFFICIAL_SPEECH_PROVIDER_ID
    speechStore.activeSpeechModel = 'old-model'
    speechStore.activeSpeechVoiceId = 'old-model-voice'

    try {
      providersStore.providerRuntimeState[OFFICIAL_SPEECH_PROVIDER_ID].models = await providerOfficialSpeech.extraMethods!.listModels!(
        {},
        providerOfficialSpeech.createProvider({}),
      )

      speechStore.ensureActiveSpeechModel()
      await speechStore.loadVoicesForProvider(OFFICIAL_SPEECH_PROVIDER_ID, speechStore.activeSpeechModel)

      expect(speechStore.activeSpeechModel).toBe('microsoft/v1')
      expect(speechStore.activeSpeechVoiceId).toBe('en-US-AvaMultilingualNeural')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  /**
   * @example
   * await speechStore.loadVoicesForProvider(OFFICIAL_SPEECH_PROVIDER_ID, 'microsoft/v1')
   */
  it('uses another server recommended voice when the current locale has no recommendation', async () => {
    i18nState.locale.value = 'ko-KR'
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString()
      if (url.includes('/api/v1/audio/models')) {
        return new Response(JSON.stringify({
          default: 'microsoft/v1',
          models: [{ id: 'microsoft/v1', name: 'microsoft/v1' }],
        }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
      }
      return new Response(JSON.stringify({
        recommended: { 'zh-CN': 'zh-CN-XiaochenNeural' },
        voices: [
          {
            id: 'ko-KR-SunHiNeural',
            languages: [{ code: 'ko-KR', title: 'Korean' }],
            name: 'SunHi',
          },
          {
            id: 'zh-CN-XiaochenNeural',
            languages: [{ code: 'zh-CN', title: 'Chinese' }],
            name: 'Xiaochen',
          },
        ],
      }), { headers: { 'Content-Type': 'application/json' }, status: 200 })
    }) as typeof fetch)

    const providersStore = useProvidersStore()
    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = OFFICIAL_SPEECH_PROVIDER_ID

    try {
      providersStore.providerRuntimeState[OFFICIAL_SPEECH_PROVIDER_ID].models = await providerOfficialSpeech.extraMethods!.listModels!(
        {},
        providerOfficialSpeech.createProvider({}),
      )

      speechStore.ensureActiveSpeechModel()
      await speechStore.loadVoicesForProvider(OFFICIAL_SPEECH_PROVIDER_ID, speechStore.activeSpeechModel)

      expect(speechStore.activeSpeechModel).toBe('microsoft/v1')
      expect(speechStore.activeSpeechVoiceId).toBe('zh-CN-XiaochenNeural')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})

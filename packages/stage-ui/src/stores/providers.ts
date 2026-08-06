import type {
  ChatProvider,
  ChatProviderWithExtraOptions,
  EmbedProvider,
  EmbedProviderWithExtraOptions,
  SpeechProvider,
  SpeechProviderWithExtraOptions,
  TranscriptionProvider,
  TranscriptionProviderWithExtraOptions,
} from '@xsai-ext/providers/utils'
import type { ProgressInfo } from '@xsai-transformers/shared/types'
import type {
  ListVoicesOptions,
  UnAlibabaCloudOptions,
  UnDeepgramOptions,
  UnElevenLabsOptions,
  UnMicrosoftOptions,
  UnVolcengineOptions,
  VoiceProviderWithExtraOptions,
} from 'unspeech'

import type { ProviderSourceDeployment, ProviderSourcePricing } from '../libs/providers/source-metadata'
import type { ProviderOnboardingField } from '../libs/providers/types'
import type { AliyunRealtimeSpeechExtraOptions } from './providers/aliyun/stream-transcription'

import { errorMessageFrom } from '@moeru/std'
import { isCustomProvidersDisabled, isStageCapacitor, isStageTamagotchi, isUrl } from '@proj-airi/stage-shared'
import { getCachedWebGPUCapabilities, isWebGPUSupported } from '@proj-airi/stage-shared/webgpu'
import { computedAsync, useIntervalFn, useLocalStorage } from '@vueuse/core'
import {
  createOpenAI,
} from '@xsai-ext/providers/create'
import { createPlayer2 } from '@xsai-ext/providers/special/create'
import {
  createModelProvider,
  createSpeechProvider,
  createTranscriptionProvider,
  merge,
} from '@xsai-ext/providers/utils'
import { listModels } from '@xsai/model'
import { uniqBy } from 'es-toolkit'
import { defineStore } from 'pinia'
import {
  createUnAlibabaCloud,
  createUnDeepgram,
  createUnElevenLabs,
  createUnMicrosoft,
  createUnVolcengine,
  listVoices,
} from 'unspeech'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { getKokoroAdapter } from '../libs/inference/adapters/kokoro'
import { getProviderValidationIntervalMs, listProviders as listDefinedProviders, ProviderValidationCheck } from '../libs/providers'
import { resolveProviderSourceMetadata } from '../libs/providers/source-metadata'
import { getDefaultKokoroModel, KOKORO_MODELS, kokoroModelsToModelInfo } from '../workers/kokoro/constants'
import { capturePosthogEvent, ensurePosthogInitialized, isPosthogAvailableInBuild } from './analytics/posthog'
import { useAuthStore } from './auth'
import { createAliyunNLSProvider as createAliyunNlsStreamProvider } from './providers/aliyun/stream-transcription'
import { convertProviderDefinitionsToMetadata } from './providers/converters'
import { models as elevenLabsModels } from './providers/elevenlabs/list-models'
import { buildGoogleGeminiSpeechProvider } from './providers/google-gemini-speech'
import { buildKnowlezTtsProvider } from './providers/knowlez-tts'
import { buildMimoAudioTranscriptionProvider } from './providers/mimo-audio-transcription'
import { buildOpenAICompatibleProvider } from './providers/openai-compatible-builder'
import { buildOpenRouterAudioSpeechProvider } from './providers/openrouter/audio-speech'
import { createWebSpeechAPIProvider } from './providers/web-speech-api'
import { useSettingsAnalytics } from './settings/analytics'

const ALIYUN_NLS_REGIONS = [
  'cn-shanghai',
  'cn-shanghai-internal',
  'cn-beijing',
  'cn-beijing-internal',
  'cn-shenzhen',
  'cn-shenzhen-internal',
] as const

export interface ModelInfo {
  capabilities?: string[]
  contextLength?: number
  deprecated?: boolean
  description?: string
  id: string
  name: string
  provider: string
}

export interface ProviderMetadata {
  beginnerRecommended?: boolean
  capabilities: {
    listModels?: (config: Record<string, unknown>) => Promise<ModelInfo[]>
    listVoices?: (config: Record<string, unknown>, model?: string) => Promise<VoiceInfo[]>
    loadModel?: (config: Record<string, unknown>, hooks?: { onProgress?: (progress: ProgressInfo) => Promise<void> | void }) => Promise<void>
  }
  category: 'chat' | 'embed' | 'speech' | 'transcription' | 'vision'
  configured?: boolean
  createProvider: (
    config: Record<string, unknown>,
  ) =>
    | ChatProvider
    | ChatProviderWithExtraOptions
    | EmbedProvider
    | EmbedProviderWithExtraOptions
    | Promise<ChatProvider>
    | Promise<ChatProviderWithExtraOptions>
    | Promise<EmbedProvider>
    | Promise<EmbedProviderWithExtraOptions>
    | Promise<SpeechProvider>
    | Promise<SpeechProviderWithExtraOptions>
    | Promise<TranscriptionProvider>
    | Promise<TranscriptionProviderWithExtraOptions>
    | SpeechProvider
    | SpeechProviderWithExtraOptions
    | TranscriptionProvider
    | TranscriptionProviderWithExtraOptions
  defaultOptions?: () => Record<string, unknown>
  deployment?: ProviderSourceDeployment
  description: string // Default description (fallback)
  descriptionKey: string // i18n key for description
  /**
   * Iconify JSON icon name for the provider.
   *
   * Icons are available for most of the AI provides under @proj-airi/lobe-icons.
   */
  icon?: string
  iconColor?: string
  /**
   * In case of having image instead of icon, you can specify the image URL here.
   */
  iconImage?: string
  id: string
  /**
   * Indicates whether the provider is available.
   * If not specified, the provider is always available.
   *
   * May be specified when any of the following criteria is required:
   *
   * Platform requirements:
   *
   * - app-* providers are only available on desktop, this is responsible for Tauri runtime checks
   * - web-* providers are only available on web, this means Node.js and Tauri should not be imported or used
   *
   * System spec requirements:
   *
   * - may requires WebGPU / NVIDIA / other types of GPU,
   *   on Web, WebGPU will automatically compiled to use targeting GPU hardware
   * - may requires significant amount of GPU memory to run, especially for
   *   using of small language models within browser or Tauri app
   * - may requires significant amount of memory to run, especially for those
   *   non-WebGPU supported environments.
   */
  isAvailableBy?: () => boolean | Promise<boolean>
  localizedDescription?: string
  localizedName?: string
  name: string // Default name (fallback)
  nameKey: string // i18n key for provider name
  onboardingFields?: ProviderOnboardingField[]
  order?: number
  pricing?: ProviderSourcePricing
  /**
   * If true, the provider does not require user-provided credentials (e.g. API keys).
   * Used for official/built-in providers that authenticate via session.
   */
  requiresCredentials?: boolean
  tasks: string[]
  to?: string
  transcriptionFeatures?: {
    supportsGenerate: boolean
    supportsStreamInput: boolean
    supportsStreamOutput: boolean
  }
  validators: {
    /**
     * Whether the "skip chat ping check" checkbox should be shown in the UI.
     *
     * Automatically derived: `true` when the provider has a ChatCompletions
     * runtime validator AND `disableChatPingCheckUI` is not set on the definition.
     */
    chatPingCheckAvailable: boolean
    /**
     * Validate a provider's configuration.
     *
     * PITFALL: When `skipChatPingCheck` is not set, the ChatCompletions validator
     * (if present) may send a real `generateText("ping")` request that consumes
     * API tokens. All automatic/background callers may consider pass `skipChatPingCheck: true`.
     */
    validateProviderConfig: (config: Record<string, unknown>, options?: { onlyChatPingCheck?: boolean, skipChatPingCheck?: boolean }) => Promise<{
      errors: unknown[]
      reason: string
      valid: boolean
    }> | {
      errors: unknown[]
      reason: string
      valid: boolean
    }
  }
}

export interface ProviderRuntimeState {
  isConfigured: boolean
  isLoadingModels: boolean
  modelLoadError: null | string
  models: ModelInfo[]
  validatedCredentialHash?: string
}

export interface VoiceInfo {
  compatibleModels?: string[]
  deprecated?: boolean
  description?: string
  gender?: string
  id: string
  languages: {
    code: string
    title: string
  }[]
  name: string
  previewURL?: string
  provider: string
}

type AliyunNlsRegion = typeof ALIYUN_NLS_REGIONS[number]

/**
 * Classifies provider ids into bounded analytics buckets.
 */
function analyticsProviderMode(providerId: string): 'custom' | 'official' | 'unknown' {
  if (!providerId)
    return 'unknown'
  return providerId.startsWith('official-provider') || providerId.startsWith('vision-official-provider') ? 'official' : 'custom'
}

/**
 * Resolves the current app surface without importing the analytics store.
 */
function analyticsSurface(): 'electron' | 'mobile' | 'web' {
  if (isStageTamagotchi())
    return 'electron'

  if (isStageCapacitor())
    return 'mobile'

  return 'web'
}

/**
 * Checks analytics settings and initializes PostHog without loading build metadata.
 */
function canCaptureProviderAnalytics(): boolean {
  if (!isPosthogAvailableInBuild())
    return false

  const settingsAnalytics = useSettingsAnalytics()
  if (!settingsAnalytics.analyticsEnabled)
    return false

  return ensurePosthogInitialized(true)
}

function toListVoicesOptions<T>(provider: VoiceProviderWithExtraOptions<T>, options?: T): ListVoicesOptions {
  const { fetch: _fetch, ...voiceOptions } = provider.voice(options)
  return voiceOptions
}

/**
 * Emits model-list failure analytics from the provider store without loading build metadata.
 */
function trackModelListFailed(properties: {
  duration_ms: number
  error_code: string
  provider_id: string
  provider_mode: 'custom' | 'official' | 'unknown'
}) {
  if (!canCaptureProviderAnalytics())
    return

  capturePosthogEvent('model_list_failed', {
    ...properties,
    app_surface: analyticsSurface(),
  })
}

/**
 * Emits model-list analytics from the provider store without loading build metadata.
 */
function trackModelListLoaded(properties: {
  duration_ms: number
  model_count: number
  provider_id: string
  provider_mode: 'custom' | 'official' | 'unknown'
}) {
  if (!canCaptureProviderAnalytics())
    return

  capturePosthogEvent('model_list_loaded', {
    ...properties,
    app_surface: analyticsSurface(),
  })
}

export const useProvidersStore = defineStore('providers', () => {
  const providerCredentials = useLocalStorage<Record<string, Record<string, unknown>>>('settings/credentials/providers', {})
  const addedProviders = useLocalStorage<Record<string, boolean>>('settings/providers/added', {})
  const providerInstanceCache = ref<Record<string, unknown>>({})
  const { t } = useI18n()
  const baseUrlValidator = computed(() => (baseUrl: unknown) => {
    let msg = ''
    if (!baseUrl) {
      msg = 'Base URL is required.'
    }
    else if (typeof baseUrl !== 'string') {
      msg = 'Base URL must be a string.'
    }
    else if (!isUrl(baseUrl) || new URL(baseUrl).host.length === 0) {
      msg = 'Base URL is not absolute. Try to include a scheme (http:// or https://).'
    }
    else if (!baseUrl.endsWith('/')) {
      msg = 'Base URL must end with a trailing slash (/).'
    }
    if (msg) {
      return {
        errors: [new Error(msg)],
        reason: msg,
        valid: false,
      }
    }
    return null
  })

  async function isBrowserAndMemoryEnough() {
    if (isStageTamagotchi())
      return false

    const webGPUAvailable = await isWebGPUSupported()
    if (webGPUAvailable) {
      return true
    }

    if ('navigator' in globalThis && globalThis.navigator != null && 'deviceMemory' in globalThis.navigator && typeof globalThis.navigator.deviceMemory === 'number') {
      const memory = globalThis.navigator.deviceMemory
      // Check if the device has at least 8GB of RAM
      if (memory >= 8) {
        return true
      }
    }

    return false
  }

  // Centralized provider metadata with provider factory functions
  const authState = useAuthStore()
  const providerMetadata: Record<string, ProviderMetadata> = {
    'alibaba-cloud-model-studio': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: '',
              id: 'cosyvoice-v1',
              name: 'CosyVoice',
              provider: 'alibaba-cloud-model-studio',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: '',
              id: 'cosyvoice-v2',
              name: 'CosyVoice (New)',
              provider: 'alibaba-cloud-model-studio',
            },
          ]
        },
        listVoices: async (config) => {
          const provider = createUnAlibabaCloud((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnAlibabaCloudOptions>

          const voices = await listVoices(toListVoicesOptions(provider))

          return voices.map((voice) => {
            return {
              compatibleModels: voice.compatible_models,
              gender: voice.labels?.gender,
              id: voice.id,
              languages: voice.languages,
              name: voice.name,
              previewURL: voice.preview_audio_url,
              provider: 'alibaba-cloud-model-studio',
            }
          })
        },
      },
      category: 'speech',
      createProvider: async config => createUnAlibabaCloud((config.apiKey as string).trim(), (config.baseUrl as string).trim()),
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
      }),
      description: 'bailian.console.aliyun.com',
      descriptionKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio.description',
      iconColor: 'i-lobe-icons:alibabacloud',
      id: 'alibaba-cloud-model-studio',
      name: 'Alibaba Cloud Model Studio',
      nameKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'aliyun-nls-transcription': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: 'Realtime streaming transcription using Aliyun NLS.',
              id: 'aliyun-nls-v1',
              name: 'Aliyun NLS Realtime',
              provider: 'aliyun-nls-transcription',
            },
          ]
        },
      },
      category: 'transcription',
      createProvider: async (config) => {
        const toString = (value: unknown) => typeof value === 'string' ? value.trim() : ''

        const accessKeyId = toString(config.accessKeyId)
        const accessKeySecret = toString(config.accessKeySecret)
        const appKey = toString(config.appKey)
        const region = toString(config.region)
        const resolvedRegion = ALIYUN_NLS_REGIONS.includes(region as AliyunNlsRegion) ? region as AliyunNlsRegion : 'cn-shanghai'

        if (!accessKeyId || !accessKeySecret || !appKey)
          throw new Error('Aliyun NLS credentials are incomplete.')

        const provider = createAliyunNlsStreamProvider(accessKeyId, accessKeySecret, appKey, { region: resolvedRegion })

        return {
          transcription: (model: string, extraOptions?: AliyunRealtimeSpeechExtraOptions) => provider.speech(model, {
            ...extraOptions,
            sessionOptions: {
              enable_intermediate_result: true,
              enable_punctuation_prediction: true,
              enable_words: true,
              format: 'pcm',
              sample_rate: 16000,
              ...extraOptions?.sessionOptions,
            },
          }),
        } as TranscriptionProviderWithExtraOptions<string, AliyunRealtimeSpeechExtraOptions>
      },
      defaultOptions: () => ({
        accessKeyId: '',
        accessKeySecret: '',
        appKey: '',
        region: 'cn-shanghai',
      }),
      description: 'nls-console.aliyun.com',
      descriptionKey: 'settings.pages.providers.provider.aliyun-nls.description',
      icon: 'i-lobe-icons:alibabacloud',
      id: 'aliyun-nls-transcription',
      name: 'Aliyun NLS',
      nameKey: 'settings.pages.providers.provider.aliyun-nls.title',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt', 'streaming-transcription'],
      transcriptionFeatures: {
        supportsGenerate: false,
        supportsStreamInput: true,
        supportsStreamOutput: true,
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors: Error[] = []
          const toString = (value: unknown) => typeof value === 'string' ? value.trim() : ''

          const accessKeyId = toString(config.accessKeyId)
          const accessKeySecret = toString(config.accessKeySecret)
          const appKey = toString(config.appKey)
          const region = toString(config.region)

          if (!accessKeyId)
            errors.push(new Error('Access Key ID is required.'))
          if (!accessKeySecret)
            errors.push(new Error('Access Key Secret is required.'))
          if (!appKey)
            errors.push(new Error('App Key is required.'))
          if (region && !ALIYUN_NLS_REGIONS.includes(region as AliyunNlsRegion))
            errors.push(new Error('Region is invalid.'))

          return {
            errors,
            reason: errors.length > 0 ? errors.map(error => error.message).join(', ') : '',
            valid: errors.length === 0,
          }
        },
      },
    },
    'app-local-audio-speech': buildOpenAICompatibleProvider({
      category: 'speech',
      creator: createOpenAI,
      description: 'https://github.com/huggingface/candle',
      descriptionKey: 'settings.pages.providers.provider.app-local-audio-speech.description',
      icon: 'i-lobe-icons:huggingface',
      id: 'app-local-audio-speech',
      isAvailableBy: isStageTamagotchi,
      name: 'App (Local)',
      nameKey: 'settings.pages.providers.provider.app-local-audio-speech.title',
      tasks: ['text-to-speech', 'tts'],
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'app-local-audio-transcription': buildOpenAICompatibleProvider({
      category: 'transcription',
      creator: createOpenAI,
      description: 'https://github.com/huggingface/candle',
      descriptionKey: 'settings.pages.providers.provider.app-local-audio-transcription.description',
      icon: 'i-lobe-icons:huggingface',
      id: 'app-local-audio-transcription',
      isAvailableBy: isStageTamagotchi,
      name: 'App (Local)',
      nameKey: 'settings.pages.providers.provider.app-local-audio-transcription.title',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'browser-local-audio-speech': buildOpenAICompatibleProvider({
      category: 'speech',
      creator: createOpenAI,
      description: 'https://github.com/moeru-ai/xsai-transformers',
      descriptionKey: 'settings.pages.providers.provider.browser-local-audio-speech.description',
      icon: 'i-lobe-icons:huggingface',
      id: 'browser-local-audio-speech',
      isAvailableBy: isBrowserAndMemoryEnough,
      name: 'Browser (Local)',
      nameKey: 'settings.pages.providers.provider.browser-local-audio-speech.title',
      tasks: ['text-to-speech', 'tts'],
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'browser-local-audio-transcription': buildOpenAICompatibleProvider({
      category: 'transcription',
      creator: createOpenAI,
      description: 'https://github.com/moeru-ai/xsai-transformers',
      descriptionKey: 'settings.pages.providers.provider.browser-local-audio-transcription.description',
      icon: 'i-lobe-icons:huggingface',
      id: 'browser-local-audio-transcription',
      isAvailableBy: isBrowserAndMemoryEnough,
      name: 'Browser (Local)',
      nameKey: 'settings.pages.providers.provider.browser-local-audio-transcription.title',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'browser-web-speech-api': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: 'Browser-native speech recognition (no API keys required)',
              id: 'web-speech-api',
              name: 'Web Speech API',
              provider: 'browser-web-speech-api',
            },
          ]
        },
      },
      category: 'transcription',
      createProvider: async (_config) => {
        // Web Speech API doesn't need config, but we accept it for consistency
        return createWebSpeechAPIProvider()
      },
      defaultOptions: () => ({
        continuous: true,
        interimResults: true,
        language: 'en-US',
        maxAlternatives: 1,
      }),
      description: 'Browser-native speech recognition. No API keys.',
      descriptionKey: 'settings.pages.providers.provider.browser-web-speech-api.description',
      icon: 'i-solar:microphone-bold-duotone',
      id: 'browser-web-speech-api',
      isAvailableBy: async () => {
        // Web Speech API is only available in browser contexts, NOT in Electron
        // Even though Electron uses Chromium, Web Speech API requires Google's embedded API keys
        // which are not available in Electron, causing it to fail at runtime
        if (typeof window === 'undefined')
          return false

        // Explicitly exclude Electron - Web Speech API doesn't work there
        if (isStageTamagotchi())
          return false

        // Check if API is available in browser
        return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
      },
      name: 'Web Speech API (Browser)',
      nameKey: 'settings.pages.providers.provider.browser-web-speech-api.title',
      requiresCredentials: false,
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt', 'streaming-transcription'],
      transcriptionFeatures: {
        supportsGenerate: false,
        supportsStreamInput: true,
        supportsStreamOutput: true,
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: () => {
          // Web Speech API requires no configuration, just browser support
          // Always return valid if browser supports it, so it auto-configures
          const isAvailable = typeof window !== 'undefined'
            && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)

          if (!isAvailable) {
            return {
              errors: [new Error('Web Speech API is not available. It requires a browser context with SpeechRecognition support (Chrome, Edge, Safari).')],
              reason: 'Web Speech API is not available in this environment.',
              valid: false,
            }
          }

          // Auto-configure if available (no credentials needed)
          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    },
    'comet-api-speech': buildOpenAICompatibleProvider({
      category: 'speech',
      creator: (apiKey, baseURL = 'https://api.cometapi.com/v1/') => merge(
        createModelProvider({ apiKey, baseURL }),
        createSpeechProvider({ apiKey, baseURL }),
      ),
      defaultBaseUrl: 'https://api.cometapi.com/v1/',
      description: 'cometapi.com',
      descriptionKey: 'settings.pages.providers.provider.comet-api.description',
      icon: 'i-lobe-icons:cometapi',
      id: 'comet-api-speech',
      name: 'CometAPI Speech',
      nameKey: 'settings.pages.providers.provider.comet-api.title',
      tasks: ['text-to-speech'],
      validation: [ProviderValidationCheck.ModelList],
    }),
    'comet-api-transcription': buildOpenAICompatibleProvider({
      category: 'transcription',
      creator: (apiKey, baseURL = 'https://api.cometapi.com/v1/') => merge(
        createModelProvider({ apiKey, baseURL }),
        createTranscriptionProvider({ apiKey, baseURL }),
      ),
      defaultBaseUrl: 'https://api.cometapi.com/v1/',
      description: 'cometapi.com',
      descriptionKey: 'settings.pages.providers.provider.comet-api.description',
      icon: 'i-lobe-icons:cometapi',
      id: 'comet-api-transcription',
      name: 'CometAPI Transcription',
      nameKey: 'settings.pages.providers.provider.comet-api.title',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      validation: [ProviderValidationCheck.ModelList],
    }),
    'deepgram-tts': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: 'Latest generation Aura model',
              id: 'aura-2',
              name: 'Aura 2',
              provider: 'deepgram-tts',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'First generation Aura model',
              id: 'aura-1',
              name: 'Aura 1',
              provider: 'deepgram-tts',
            },
            {
              contextLength: 0,
              deprecated: true,
              description: 'Original Aura model',
              id: 'aura',
              name: 'Aura (Legacy)',
              provider: 'deepgram-tts',
            },
          ]
        },
        listVoices: async (config) => {
          const provider = createUnDeepgram((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnDeepgramOptions>

          const voices = await listVoices(toListVoicesOptions(provider))

          return voices.map((voice) => {
            return {
              description: voice.description,
              gender: voice.labels?.gender,
              id: voice.id,
              languages: voice.languages,
              name: voice.name,
              provider: 'deepgram-tts',
            }
          })
        },
      },
      category: 'speech',
      createProvider: async (config) => {
        const provider = createUnDeepgram((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as SpeechProviderWithExtraOptions<string, UnDeepgramOptions>
        return provider
      },
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
      }),
      description: 'deepgram.com',
      descriptionKey: 'settings.pages.providers.provider.deepgram-tts.description',
      icon: 'i-simple-icons:deepgram',
      id: 'deepgram-tts',
      name: 'Deepgram',
      nameKey: 'settings.pages.providers.provider.deepgram-tts.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors: Error[] = []
          if (!config.apiKey) {
            errors.push(new Error('API key is required.'))
          }

          const baseUrlValidationResult = baseUrlValidator.value(config.baseUrl)
          if (baseUrlValidationResult) {
            errors.push(...(baseUrlValidationResult.errors as Error[]))
          }

          return {
            errors,
            reason: errors.map(e => e.message).join(', '),
            valid: errors.length === 0,
          }
        },
      },
    },
    'elevenlabs': {
      capabilities: {
        listModels: async () => {
          return elevenLabsModels.map((model) => {
            return {
              contextLength: 0,
              deprecated: false,
              description: model.description,
              id: model.model_id,
              name: model.name,
              provider: 'elevenlabs',
            } satisfies ModelInfo
          })
        },
        listVoices: async (config) => {
          const provider = createUnElevenLabs((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnElevenLabsOptions>

          const voices = await listVoices(toListVoicesOptions(provider))

          if (!voices || !Array.isArray(voices)) {
            return []
          }

          // Find indices of Aria and Bill
          const ariaIndex = voices.findIndex(voice => voice.name.includes('Aria'))
          const billIndex = voices.findIndex(voice => voice.name.includes('Bill'))

          // Determine the range to move (ensure valid indices and proper order)
          const startIndex = ariaIndex !== -1 ? ariaIndex : 0
          const endIndex = billIndex !== -1 ? billIndex : voices.length - 1
          const lowerIndex = Math.min(startIndex, endIndex)
          const higherIndex = Math.max(startIndex, endIndex)

          // Rearrange voices: voices outside the range first, then voices within the range
          const rearrangedVoices = [
            ...voices.slice(0, lowerIndex),
            ...voices.slice(higherIndex + 1),
            ...voices.slice(lowerIndex, higherIndex + 1),
          ]

          return rearrangedVoices.map((voice) => {
            return {
              id: voice.id,
              languages: voice.languages,
              name: voice.name,
              previewURL: voice.preview_audio_url,
              provider: 'elevenlabs',
            }
          })
        },
      },
      category: 'speech',
      createProvider: async config => createUnElevenLabs((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as SpeechProviderWithExtraOptions<string, UnElevenLabsOptions>,
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
        voiceSettings: {
          similarityBoost: 0.75,
          stability: 0.5,
        },
      }),
      description: 'elevenlabs.io',
      descriptionKey: 'settings.pages.providers.provider.elevenlabs.description',
      icon: 'i-simple-icons:elevenlabs',
      id: 'elevenlabs',
      name: 'ElevenLabs',
      nameKey: 'settings.pages.providers.provider.elevenlabs.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'google-gemini-audio-speech': buildGoogleGeminiSpeechProvider(v => baseUrlValidator.value(v)),
    'index-tts-vllm': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: 'Default model for Index-TTS vLLM deployment',
              id: 'IndexTTS-1.5',
              name: 'IndexTTS-1.5',
              provider: 'index-tts-vllm',
            },
          ]
        },
        listVoices: async (config) => {
          const voicesUrl = config.baseUrl as string
          const response = await fetch(`${voicesUrl}audio/voices`)
          if (!response.ok) {
            throw new Error(`Failed to fetch voices: ${response.statusText}`)
          }
          const voices = await response.json()
          return Object.keys(voices).map((voice: any) => {
            return {
              id: voice,
              // previewURL: voice.preview_audio_url,
              languages: [{ code: 'cn', title: 'Chinese' }, { code: 'en', title: 'English' }],
              name: voice,
              provider: 'index-tts-vllm',
            }
          })
        },
      },
      category: 'speech',
      createProvider: async (config) => {
        const provider: SpeechProvider = {
          speech: () => {
            const req = {
              baseURL: config.baseUrl as string,
              model: (config.model as string) || 'IndexTTS-1.5',
            }
            return req
          },
        }
        return provider
      },
      defaultOptions: () => ({
        baseUrl: 'http://localhost:11996/tts/',
        model: 'IndexTTS-1.5',
      }),
      description: 'index-tts.github.io',
      descriptionKey: 'settings.pages.providers.provider.index-tts-vllm.description',
      iconColor: 'i-lobe-icons:bilibiliindex',
      id: 'index-tts-vllm',
      name: 'Index-TTS by Bilibili',
      nameKey: 'settings.pages.providers.provider.index-tts-vllm.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: async (config) => {
          const errors = [
            !config.baseUrl && new Error('Base URL is required. Default to http://localhost:11996/tts/ for Index-TTS.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const response = await fetch(`${config.baseUrl as string}audio/voices`, { signal: controller.signal })
            clearTimeout(timeout)

            if (!response.ok) {
              const reason = `IndexTTS unreachable: HTTP ${response.status} ${response.statusText}`
              return { errors: [new Error(reason)], reason, valid: false }
            }
          }
          catch (err) {
            const reason = `IndexTTS connection failed: ${String(err)}`
            return { errors: [err as Error], reason, valid: false }
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: errors.length === 0,
          }
        },
      },
    },
    'knowlez-tts': buildKnowlezTtsProvider(v => baseUrlValidator.value(v)),
    'kokoro-local': {
      capabilities: {
        listModels: async (_config: Record<string, unknown>) => {
          const caps = getCachedWebGPUCapabilities()
          const hasWebGPU = caps?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
          const fp16Supported = caps?.fp16Supported ?? false
          return kokoroModelsToModelInfo(hasWebGPU, t, fp16Supported)
        },

        listVoices: (() => {
          let lastLoadedModelId: null | string = null
          return async (config: Record<string, unknown>) => {
            try {
              const workerManager = await getKokoroAdapter()
              const modelId = config.model as string

              // Reload the model if it hasn't been loaded yet or if the model ID changed
              if (workerManager.state !== 'ready' || (modelId && modelId !== lastLoadedModelId)) {
                if (modelId) {
                  const modelDef = KOKORO_MODELS.find(m => m.id === modelId)
                  if (modelDef) {
                    if (modelDef.platform === 'webgpu') {
                      const hasWebGPU = getCachedWebGPUCapabilities()?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
                      if (!hasWebGPU) {
                        throw new Error('WebGPU is required for this model but is not available in your browser')
                      }
                    }

                    await workerManager.loadModel(modelDef.quantization, modelDef.platform)
                    lastLoadedModelId = modelId
                  }
                }
              }

              const modelVoices = workerManager.getVoices()

              // Language code mapping
              const languageMap: Record<string, { code: string, title: string }> = {
                'en-gb': { code: 'en-GB', title: 'English (UK)' },
                'en-us': { code: 'en-US', title: 'English (US)' },
                'es': { code: 'es', title: 'Spanish' },
                'fr': { code: 'fr', title: 'French' },
                'hi': { code: 'hi', title: 'Hindi' },
                'it': { code: 'it', title: 'Italian' },
                'ja': { code: 'ja', title: 'Japanese' },
                'pt-br': { code: 'pt-BR', title: 'Portuguese (Brazil)' },
                'zh-cn': { code: 'zh-CN', title: 'Chinese (Mandarin)' },
              }

              // Transform the voices object to the expected array format
              return Object.entries(modelVoices).map(([id, voice]: [string, { gender: string, language: string, name: string }]) => {
                const languageCode = voice.language.toLowerCase()
                const languageInfo = languageMap[languageCode] || { code: languageCode, title: voice.language }

                return {
                  gender: voice.gender.toLowerCase(),
                  id,
                  languages: [languageInfo],
                  name: `${voice.name} (${voice.gender}, ${languageInfo.title.split('(')[0].trim()})`,
                  provider: 'kokoro-local',
                }
              })
            }
            catch (error) {
              console.error('Failed to fetch Kokoro voices:', error)
              // Return empty array if model not loaded yet
              return []
            }
          }
        })(),

        loadModel: async (config: Record<string, unknown>, _hooks?: { onProgress?: (progress: ProgressInfo) => Promise<void> | void }) => {
          const modelId = config.model as string

          if (!modelId) {
            throw new Error('No model specified')
          }

          const modelDef = KOKORO_MODELS.find(m => m.id === modelId)
          if (!modelDef) {
            throw new Error(`Invalid model: ${modelId}. Must be one of: ${KOKORO_MODELS.map(m => m.id).join(', ')}`)
          }

          // Validate platform requirements
          if (modelDef.platform === 'webgpu') {
            const hasWebGPU = getCachedWebGPUCapabilities()?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
            if (!hasWebGPU) {
              throw new Error('WebGPU is required for this model but is not available in your browser')
            }
          }

          try {
            const workerManager = await getKokoroAdapter()
            await workerManager.loadModel(modelDef.quantization, modelDef.platform, {
              onProgress: _hooks?.onProgress
                ? (p) => {
                    // Map unified ProgressPayload back to ProgressInfo shape
                    // that the provider hooks expect (HuggingFace transformers format)
                    _hooks.onProgress!({
                      file: p.file ?? '',
                      loaded: p.loaded ?? 0,
                      name: p.file ?? '',
                      progress: p.percent >= 0 ? p.percent : 0,
                      status: 'progress',
                      total: p.total ?? 0,
                    } as ProgressInfo)
                  }
                : undefined,
            })
          }
          catch (error) {
            console.error('Failed to load Kokoro model:', error)
            throw error
          }
        },
      },
      category: 'speech',
      createProvider: async (_config) => {
        // Import the worker manager
        const workerManagerPromise = getKokoroAdapter()

        const provider: SpeechProvider = {
          speech: () => {
            return {
              baseURL: 'http://kokoro-local/v1/',
              fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
                try {
                  // Parse OpenAI-compatible request body
                  if (!init?.body || typeof init.body !== 'string') {
                    throw new Error('Invalid request body')
                  }
                  const body = JSON.parse(init.body)
                  const text = body.input
                  const voice = body.voice

                  if (!voice) {
                    throw new Error('Voice parameter is required')
                  }

                  // Generate audio in the worker thread
                  const buffer = await (await workerManagerPromise).generate(text, voice)

                  return new Response(buffer, {
                    headers: {
                      'Content-Type': 'audio/wav',
                    },
                    status: 200,
                  })
                }
                catch (error) {
                  console.error('Kokoro TTS generation failed:', error)
                  throw error
                }
              },
              model: 'kokoro-82m',
            }
          },
        }

        return provider
      },
      defaultOptions: () => {
        const capabilities = getCachedWebGPUCapabilities()
        const hasWebGPU = capabilities?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
        const fp16Supported = capabilities?.fp16Supported ?? false
        const model = getDefaultKokoroModel(hasWebGPU, fp16Supported)
        return {
          model,
          voiceId: '',
        }
      },
      description: 'Local text-to-speech using Kokoro-82M.',
      descriptionKey: 'settings.pages.providers.provider.kokoro-local.description',
      icon: 'i-lobe-icons:speaker',
      id: 'kokoro-local',
      name: 'Kokoro TTS',

      nameKey: 'settings.pages.providers.provider.kokoro-local.title',

      requiresCredentials: false,

      tasks: ['text-to-speech'],

      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: async (config: any) => {
          const model = config.model as string

          if (!model) {
            return {
              errors: [new Error('No model selected')],
              reason: 'Please select a model from the dropdown menu',
              valid: false,
            }
          }

          if (!KOKORO_MODELS.some(m => m.id === model)) {
            return {
              errors: [new Error(`Invalid model: ${model}`)],
              reason: `Invalid model. Must be one of: ${KOKORO_MODELS.map(m => m.id).join(', ')}`,
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    },
    'microsoft-speech': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: '',
              id: 'v1',
              name: 'v1',
              provider: 'microsoft-speech',
            },
          ]
        },
        listVoices: async (config) => {
          const provider = createUnMicrosoft((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnMicrosoftOptions>

          const voices = await listVoices(toListVoicesOptions(provider, { region: config.region as string }))

          return voices.map((voice) => {
            return {
              gender: voice.labels?.gender,
              id: voice.id,
              languages: voice.languages,
              name: voice.name,
              previewURL: voice.preview_audio_url,
              provider: 'microsoft-speech',
            }
          })
        },
      },
      category: 'speech',
      createProvider: async config => createUnMicrosoft((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as SpeechProviderWithExtraOptions<string, UnMicrosoftOptions>,
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
      }),
      description: 'speech.microsoft.com',
      descriptionKey: 'settings.pages.providers.provider.microsoft-speech.description',
      iconColor: 'i-lobe-icons:microsoft',
      id: 'microsoft-speech',
      name: 'Microsoft / Azure Speech',
      nameKey: 'settings.pages.providers.provider.microsoft-speech.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'mimo-audio-speech': {
      capabilities: {
        listModels: async () => [
          {
            contextLength: 0,
            deprecated: false,
            description: 'Preset voice synthesis with the built-in MiMo voice list',
            id: 'mimo-v2.5-tts',
            name: 'MiMo v2.5 TTS',
            provider: 'mimo-audio-speech',
          },
          {
            contextLength: 0,
            deprecated: false,
            description: 'Design a new voice from a natural language description',
            id: 'mimo-v2.5-tts-voicedesign',
            name: 'MiMo v2.5 TTS Voice Design',
            provider: 'mimo-audio-speech',
          },
          {
            contextLength: 0,
            deprecated: false,
            description: 'Clone a voice from a base64-encoded audio sample',
            id: 'mimo-v2.5-tts-voiceclone',
            name: 'MiMo v2.5 TTS Voice Clone',
            provider: 'mimo-audio-speech',
          },
        ],
        listVoices: async () => [
          { gender: 'female', id: 'mimo_default', languages: [{ code: 'en', title: 'English' }, { code: 'zh', title: 'Chinese' }], name: 'MiMo-默认', provider: 'mimo-audio-speech' },
          { gender: 'female', id: '冰糖', languages: [{ code: 'zh', title: 'Chinese' }], name: '冰糖', provider: 'mimo-audio-speech' },
          { gender: 'female', id: '茉莉', languages: [{ code: 'zh', title: 'Chinese' }], name: '茉莉', provider: 'mimo-audio-speech' },
          { gender: 'male', id: '苏打', languages: [{ code: 'zh', title: 'Chinese' }], name: '苏打', provider: 'mimo-audio-speech' },
          { gender: 'male', id: '白桦', languages: [{ code: 'zh', title: 'Chinese' }], name: '白桦', provider: 'mimo-audio-speech' },
          { gender: 'female', id: 'Mia', languages: [{ code: 'en', title: 'English' }], name: 'Mia', provider: 'mimo-audio-speech' },
          { gender: 'female', id: 'Chloe', languages: [{ code: 'en', title: 'English' }], name: 'Chloe', provider: 'mimo-audio-speech' },
          { gender: 'male', id: 'Milo', languages: [{ code: 'en', title: 'English' }], name: 'Milo', provider: 'mimo-audio-speech' },
          { gender: 'male', id: 'Dean', languages: [{ code: 'en', title: 'English' }], name: 'Dean', provider: 'mimo-audio-speech' },
        ],
      },
      category: 'speech',
      createProvider: async (config) => {
        const apiKey = (config.apiKey as string)?.trim() ?? ''
        const baseUrl = ((config.baseUrl as string) || 'https://api.xiaomimimo.com/v1/').replace(/\/+$/, '')
        const defaultModel = (config.model as string) || 'mimo-v2.5-tts'
        const defaultVoice = (config.voice as string) || 'mimo_default'
        const defaultFormat = (config.format as string) || 'wav'

        const provider: SpeechProvider = {
          speech: () => ({
            baseURL: `${baseUrl}/`,
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
              if (!init?.body || typeof init.body !== 'string') {
                throw new Error('Invalid request body')
              }

              const body = JSON.parse(init.body)
              const text = body.input as string
              const modelId = (body.model as string) || defaultModel
              const format = (body.response_format as string) || defaultFormat
              const stylePrompt = typeof body.style_prompt === 'string'
                ? body.style_prompt.trim()
                : typeof config.stylePrompt === 'string'
                  ? config.stylePrompt.trim()
                  : ''
              const voiceSample = typeof body.voice_sample === 'string'
                ? body.voice_sample.trim()
                : typeof config.voiceSample === 'string'
                  ? config.voiceSample.trim()
                  : ''

              const userPrompt = modelId === 'mimo-v2.5-tts-voiceclone'
                ? stylePrompt
                : stylePrompt || 'Use a natural, clear speaking style.'

              const audio: Record<string, string> = { format }
              if (modelId === 'mimo-v2.5-tts-voiceclone') {
                if (!voiceSample) {
                  throw new Error('MiMo voice clone requires a base64 audio sample in data URI format.')
                }
                audio.voice = voiceSample
              }
              else if (modelId === 'mimo-v2.5-tts') {
                audio.voice = (body.voice as string) || defaultVoice
              }

              if (modelId === 'mimo-v2.5-tts-voicedesign' && !stylePrompt) {
                throw new Error('MiMo voice design requires a style prompt in the user message.')
              }

              const response = await fetch(`${baseUrl}/chat/completions`, {
                body: JSON.stringify({
                  audio,
                  messages: [
                    { content: userPrompt, role: 'user' },
                    { content: text, role: 'assistant' },
                  ],
                  model: modelId,
                }),
                headers: {
                  'api-key': apiKey,
                  'Content-Type': 'application/json',
                },
                method: 'POST',
              })

              if (!response.ok || !response.body) {
                throw new Error(`MiMo TTS request failed: ${response.status} ${response.statusText}`)
              }

              const data = await response.json()
              const audioBase64 = data?.choices?.[0]?.message?.audio?.data
              if (!audioBase64) {
                throw new Error('MiMo TTS response missing audio data')
              }

              const binaryString = atob(audioBase64)
              const bytes = new Uint8Array(binaryString.length)
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i)
              }

              const contentType = format === 'wav' ? 'audio/wav' : format === 'mp3' ? 'audio/mpeg' : `audio/${format}`
              return new Response(bytes.buffer, {
                headers: { 'Content-Type': contentType },
                status: 200,
              })
            },
            model: defaultModel,
          }),
        }
        return provider
      },
      defaultOptions: () => ({
        baseUrl: 'https://api.xiaomimimo.com/v1/',
        format: 'wav',
        model: 'mimo-v2.5-tts',
        voice: 'mimo_default',
      }),
      description: 'api.xiaomimimo.com',
      descriptionKey: 'settings.pages.providers.provider.mimo.description',
      icon: 'i-simple-icons:xiaomi',
      id: 'mimo-audio-speech',
      name: 'Xiaomi MiMo',
      nameKey: 'settings.pages.providers.provider.mimo.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.map(e => (e as Error).message).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'mimo-audio-transcription': buildMimoAudioTranscriptionProvider(baseUrlValidator.value),
    'minimax-speech': {
      capabilities: {
        listModels: async () => [
          {
            contextLength: 0,
            deprecated: false,
            description: 'High-definition TTS model with natural prosody',
            id: 'speech-2.8-hd',
            name: 'Speech 2.8 HD',
            provider: 'minimax-speech',
          },
          {
            contextLength: 0,
            deprecated: false,
            description: 'Fast TTS model for low-latency scenarios',
            id: 'speech-2.8-turbo',
            name: 'Speech 2.8 Turbo',
            provider: 'minimax-speech',
          },
        ],
        listVoices: async () => [
          { gender: 'female', id: 'English_Graceful_Lady', languages: [{ code: 'en', title: 'English' }], name: 'Graceful Lady', provider: 'minimax-speech' },
          { gender: 'male', id: 'English_Insightful_Speaker', languages: [{ code: 'en', title: 'English' }], name: 'Insightful Speaker', provider: 'minimax-speech' },
          { gender: 'female', id: 'English_radiant_girl', languages: [{ code: 'en', title: 'English' }], name: 'Radiant Girl', provider: 'minimax-speech' },
          { gender: 'male', id: 'English_Persuasive_Man', languages: [{ code: 'en', title: 'English' }], name: 'Persuasive Man', provider: 'minimax-speech' },
          { gender: 'neutral', id: 'English_Lucky_Robot', languages: [{ code: 'en', title: 'English' }], name: 'Lucky Robot', provider: 'minimax-speech' },
          { gender: 'neutral', id: 'English_expressive_narrator', languages: [{ code: 'en', title: 'English' }], name: 'Expressive Narrator', provider: 'minimax-speech' },
          { gender: 'female', id: 'Mandarin_Gentle_Woman', languages: [{ code: 'zh', title: 'Chinese' }], name: 'Gentle Woman', provider: 'minimax-speech' },
          { gender: 'male', id: 'Mandarin_Steadfast_Man', languages: [{ code: 'zh', title: 'Chinese' }], name: 'Steadfast Man', provider: 'minimax-speech' },
          { gender: 'female', id: 'Mandarin_Sweet_Girl', languages: [{ code: 'zh', title: 'Chinese' }], name: 'Sweet Girl', provider: 'minimax-speech' },
          { gender: 'male', id: 'Mandarin_Magnetic_Gentleman', languages: [{ code: 'zh', title: 'Chinese' }], name: 'Magnetic Gentleman', provider: 'minimax-speech' },
        ],
      },
      category: 'speech',
      createProvider: async (config) => {
        const apiKey = (config.apiKey as string).trim()
        const baseUrl = ((config.baseUrl as string) || 'https://api.minimax.io').replace(/\/$/, '')

        const provider: SpeechProvider = {
          speech: () => ({
            baseURL: `${baseUrl}/v1/`,
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
              if (!init?.body || typeof init.body !== 'string') {
                throw new Error('Invalid request body')
              }

              const body = JSON.parse(init.body)
              const text = body.input as string
              const voiceId = (body.voice as string) || 'English_Graceful_Lady'
              const model = (body.model as string) || 'speech-2.8-hd'

              const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
                body: JSON.stringify({
                  audio_setting: {
                    bitrate: 128000,
                    channel: 1,
                    format: 'mp3',
                    sample_rate: 32000,
                  },
                  model,
                  stream: true,
                  text,
                  voice_setting: {
                    pitch: 0,
                    speed: 1,
                    voice_id: voiceId,
                    vol: 1,
                  },
                }),
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                method: 'POST',
              })

              if (!response.ok || !response.body) {
                throw new Error(`MiniMax TTS request failed: ${response.status} ${response.statusText}`)
              }

              // Parse SSE stream and collect hex-encoded audio chunks
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              const audioChunks: Uint8Array[] = []
              let buffer = ''

              while (true) {
                const { done, value } = await reader.read()
                if (done)
                  break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() || ''
                for (const line of lines) {
                  if (!line.startsWith('data:'))
                    continue
                  const jsonStr = line.slice(5).trim()
                  if (!jsonStr || jsonStr === '[DONE]')
                    continue
                  try {
                    const eventData = JSON.parse(jsonStr)
                    const audio = eventData?.data?.audio
                    // status 2 is the final summary chunk; skip it to avoid duplication
                    if (audio && eventData?.data?.status !== 2) {
                      const hexStr = audio as string
                      const bytes = new Uint8Array(hexStr.length / 2)
                      for (let i = 0; i < hexStr.length; i += 2) {
                        bytes[i / 2] = Number.parseInt(hexStr.slice(i, i + 2), 16)
                      }
                      audioChunks.push(bytes)
                    }
                  }
                  catch {
                    // ignore malformed SSE events
                  }
                }
              }

              const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
              const combined = new Uint8Array(totalLength)
              let offset = 0
              for (const chunk of audioChunks) {
                combined.set(chunk, offset)
                offset += chunk.length
              }

              return new Response(combined.buffer, {
                headers: { 'Content-Type': 'audio/mpeg' },
                status: 200,
              })
            },
            model: 'speech-2.8-hd',
          }),
        }
        return provider
      },
      defaultOptions: () => ({
        apiKey: '',
        baseUrl: 'https://api.minimax.io',
      }),
      description: 'minimax.io',
      descriptionKey: 'settings.pages.providers.provider.minimax-speech.description',
      icon: 'i-lobe-icons:minimax',
      iconColor: 'i-lobe-icons:minimax-color',
      id: 'minimax-speech',
      name: 'MiniMax Speech',
      nameKey: 'settings.pages.providers.provider.minimax-speech.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
          ].filter(Boolean)

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey,
          }
        },
      },
    },
    'openai-audio-speech': buildOpenAICompatibleProvider({
      capabilities: {
        listModels: async () => {
          // TESTING NOTES: All 4 models tested and confirmed working with fable voice:
          // - tts-1: {model: "tts-1", input: "test", voice: "fable"} ✓
          // - tts-1-hd: {model: "tts-1-hd", input: "test", voice: "fable"} ✓
          // - gpt-4o-mini-tts: {model: "gpt-4o-mini-tts", input: "test", voice: "fable"} ✓
          // - gpt-4o-mini-tts-2025-12-15: {model: "gpt-4o-mini-tts-2025-12-15", input: "test", voice: "fable"} ✓
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: 'Optimized for real-time text-to-speech tasks',
              id: 'tts-1',
              name: 'TTS-1',
              provider: 'openai-audio-speech',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'Higher fidelity audio output',
              id: 'tts-1-hd',
              name: 'TTS-1-HD',
              provider: 'openai-audio-speech',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'GPT-4o Mini optimized for text-to-speech',
              id: 'gpt-4o-mini-tts',
              name: 'GPT-4o Mini TTS',
              provider: 'openai-audio-speech',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'GPT-4o Mini TTS snapshot from 2025-12-15',
              id: 'gpt-4o-mini-tts-2025-12-15',
              name: 'GPT-4o Mini TTS (2025-12-15)',
              provider: 'openai-audio-speech',
            },
          ]
        },
        // NOTE: OpenAI does not provide an API endpoint to retrieve available voices.
        // Voices are hardcoded here - this is a provider limitation, not an application limitation.
        // Voice compatibility per https://platform.openai.com/docs/api-reference/audio/createSpeech:
        // - tts-1 and tts-1-hd support: alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer (9 voices)
        // - gpt-4o-mini-tts supports all 13 voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
        listVoices: async (_config: Record<string, unknown>) => {
          return [
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'alloy',
              languages: [],
              name: 'Alloy',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'ash',
              languages: [],
              name: 'Ash',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'ballad',
              languages: [],
              name: 'Ballad',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'coral',
              languages: [],
              name: 'Coral',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'echo',
              languages: [],
              name: 'Echo',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'fable',
              languages: [],
              name: 'Fable',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'onyx',
              languages: [],
              name: 'Onyx',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'nova',
              languages: [],
              name: 'Nova',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'sage',
              languages: [],
              name: 'Sage',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'shimmer',
              languages: [],
              name: 'Shimmer',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'verse',
              languages: [],
              name: 'Verse',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'marin',
              languages: [],
              name: 'Marin',
              provider: 'openai-audio-speech',
            },
            {
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
              id: 'cedar',
              languages: [],
              name: 'Cedar',
              provider: 'openai-audio-speech',
            },
          ] satisfies VoiceInfo[]
        },
      },
      category: 'speech',
      creator: createOpenAI,
      defaultBaseUrl: 'https://api.openai.com/v1/',
      description: 'openai.com',
      descriptionKey: 'settings.pages.providers.provider.openai.description',
      icon: 'i-lobe-icons:openai',
      id: 'openai-audio-speech',
      name: 'OpenAI',
      nameKey: 'settings.pages.providers.provider.openai.title',
      tasks: ['text-to-speech'],
      validation: [ProviderValidationCheck.Health],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API Key is required'),
            !config.baseUrl && new Error('Base URL is required. Default to https://api.openai.com/v1/ for official OpenAI API.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    }),
    'openai-audio-transcription': buildOpenAICompatibleProvider({
      capabilities: {
        listModels: async () => {
          // OpenAI transcription models are hardcoded (no API endpoint to list them)
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: 'High-quality transcription model',
              id: 'gpt-4o-transcribe',
              name: 'GPT-4o Transcribe',
              provider: 'openai-audio-transcription',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'Faster, cost-effective transcription model',
              id: 'gpt-4o-mini-transcribe',
              name: 'GPT-4o Mini Transcribe',
              provider: 'openai-audio-transcription',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'GPT-4o Mini Transcribe snapshot from 2025-12-15',
              id: 'gpt-4o-mini-transcribe-2025-12-15',
              name: 'GPT-4o Mini Transcribe (2025-12-15)',
              provider: 'openai-audio-transcription',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'Powered by our open source Whisper V2 model',
              id: 'whisper-1',
              name: 'Whisper-1',
              provider: 'openai-audio-transcription',
            },
            {
              contextLength: 0,
              deprecated: false,
              description: 'Transcription with speaker diarization',
              id: 'gpt-4o-transcribe-diarize',
              name: 'GPT-4o Transcribe Diarize',
              provider: 'openai-audio-transcription',
            },
          ] satisfies ModelInfo[]
        },
      },
      category: 'transcription',
      creator: createOpenAI,
      defaultBaseUrl: 'https://api.openai.com/v1/',
      description: 'openai.com',
      descriptionKey: 'settings.pages.providers.provider.openai.description',
      icon: 'i-lobe-icons:openai',
      id: 'openai-audio-transcription',
      name: 'OpenAI',
      nameKey: 'settings.pages.providers.provider.openai.title',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      validation: [ProviderValidationCheck.Health],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API Key is required'),
            !config.baseUrl && new Error('Base URL is required. Default to https://api.openai.com/v1/ for official OpenAI API.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    }),
    'openai-compatible-audio-speech': buildOpenAICompatibleProvider({
      capabilities: {
        listModels: async (config: Record<string, unknown>) => {
          // Filter models to only include TTS models
          const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
          let baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''

          if (!baseUrl.endsWith('/'))
            baseUrl += '/'

          if (!apiKey || !baseUrl) {
            return []
          }

          const provider = await createOpenAI(apiKey, baseUrl)
          if (!provider || typeof provider.model !== 'function') {
            return []
          }

          const models = await listModels({
            apiKey,
            baseURL: baseUrl,
          })

          // Filter for TTS models - look for models with "tts" in the ID
          return models
            .filter((model: any) => {
              const modelId = model.id.toLowerCase()
              // Include models that contain "tts" in their ID
              return modelId.includes('tts')
            })
            .map((model: any) => {
              return {
                contextLength: model.context_length || 0,
                deprecated: false,
                description: model.description || '',
                id: model.id,
                name: model.name || model.display_name || model.id,
                provider: 'openai-compatible-audio-speech',
              } satisfies ModelInfo
            })
        },
        listVoices: async () => {
          return []
        },
      },
      category: 'speech',
      creator: createOpenAI,
      description: 'Connect to any API that follows the OpenAI specification.',
      descriptionKey: 'settings.pages.providers.provider.openai-compatible.description',
      icon: 'i-lobe-icons:openai',
      id: 'openai-compatible-audio-speech',
      name: 'OpenAI Compatible',
      nameKey: 'settings.pages.providers.provider.openai-compatible.title',
      tasks: ['text-to-speech'],
    }),
    'openai-compatible-audio-transcription': buildOpenAICompatibleProvider({
      capabilities: {
        // Override listModels to return empty array - transcription models cannot be fetched from /v1/models
        // Users must manually enter transcription model names (e.g., whisper-1, gpt-4o-transcribe)
        // The /v1/models endpoint only returns chat models, not transcription models
        listModels: async () => {
          return []
        },
      },
      category: 'transcription',
      creator: createOpenAI,
      description: 'Connect to any API that follows the OpenAI specification.',
      descriptionKey: 'settings.pages.providers.provider.openai-compatible.description',
      icon: 'i-lobe-icons:openai',
      id: 'openai-compatible-audio-transcription',
      name: 'OpenAI Compatible',
      nameKey: 'settings.pages.providers.provider.openai-compatible.title',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
    }),
    'openrouter-audio-speech': buildOpenRouterAudioSpeechProvider(v => baseUrlValidator.value(v)),
    'player2-speech': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: 'Default model for Player2 speech endpoint',
              id: 'player2-tts',
              name: 'Player2 Speech',
              provider: 'player2-speech',
            },
          ]
        },
        listVoices: async (config) => {
          const baseUrl = (config.baseUrl as string).endsWith('/') ? (config.baseUrl as string).slice(0, -1) : config.baseUrl as string
          return await fetch(`${baseUrl}/tts/voices`).then(res => res.json()).then(({ voices }) => (voices as { gender: string, id: string, language: 'american_english' | 'brazilian_portuguese' | 'british_english' | 'french' | 'hindi' | 'italian' | 'japanese' | 'mandarin_chinese' | 'spanish', name: string }[]).map(({ gender, id, language, name }) => (
            {

              gender,
              id,
              languages: [{
                american_english: {
                  code: 'en',
                  title: 'English',
                },
                brazilian_portuguese:
                {
                  code: 'pt',
                  title: 'Portuguese',
                },
                british_english: {
                  code: 'en',
                  title: 'English',
                },
                french: {
                  code: 'fr',
                  title: 'French',
                },
                hindi: {
                  code: 'hi',
                  title: 'Hindi',
                },
                italian: {
                  code: 'it',
                  title: 'Italian',
                },
                japanese: {
                  code: 'ja',
                  title: 'Japanese',
                },

                mandarin_chinese: {
                  code: 'zh',
                  title: 'Chinese',
                },
                spanish: {
                  code: 'es',
                  title: 'Spanish',
                },

              }[language]],
              name,
              provider: 'player2-speech',
            }
          )))
        },
      },
      category: 'speech',
      createProvider: async config => createPlayer2((config.baseUrl as string).trim(), 'airi'),
      defaultOptions: () => ({
        baseUrl: 'http://localhost:4315/v1/',
      }),
      description: 'player2.game',
      descriptionKey: 'settings.pages.providers.provider.player2.description',
      icon: 'i-lobe-icons:player2',
      id: 'player2-speech',
      name: 'Player2 Speech',
      nameKey: 'settings.pages.providers.provider.player2.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: async (config) => {
          const errors = [
            !config.baseUrl && new Error('Base URL is required. Default to http://localhost:4315/v1/'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res)
            return res

          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const response = await fetch(`${config.baseUrl as string}health`, {
              headers: {
                'player2-game-key': 'airi',
              },
              method: 'GET',
              signal: controller.signal,
            })
            clearTimeout(timeout)

            if (!response.ok) {
              const reason = `Player2 speech unreachable: HTTP ${response.status} ${response.statusText}`
              return { errors: [new Error(reason)], reason, valid: false }
            }
          }
          catch (err) {
            const reason = `Player2 speech connection failed: ${String(err)}`
            return { errors: [err as Error], reason, valid: false }
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: errors.length === 0,
          }
        },
      },
    },
    'speech-noop': {
      capabilities: {
        listModels: async () => [],
        listVoices: async () => [],
      },
      category: 'speech',
      createProvider: async () => ({
        speech: () => ({
          baseURL: 'http://speech-noop.invalid/v1/',
          model: 'noop',
        }),
      }),
      defaultOptions: () => ({}),
      description: 'No speech output.',
      descriptionKey: 'settings.pages.providers.provider.speech-noop.description',
      icon: 'i-solar:volume-cross-bold-duotone',
      id: 'speech-noop',
      name: 'None',
      nameKey: 'settings.pages.providers.provider.speech-noop.title',
      requiresCredentials: false,
      tasks: ['text-to-speech', 'tts'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: () => ({
          errors: [],
          reason: '',
          valid: true,
        }),
      },
    },
    'volcengine': {
      capabilities: {
        listModels: async () => {
          return [
            {
              contextLength: 0,
              deprecated: false,
              description: '',
              id: 'v1',
              name: 'v1',
              provider: 'volcano-engine',
            },
          ]
        },
        listVoices: async (config) => {
          const provider = createUnVolcengine((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnVolcengineOptions>

          const voices = await listVoices(toListVoicesOptions(provider))

          return voices.map((voice) => {
            return {
              gender: voice.labels?.gender,
              id: voice.id,
              languages: voice.languages,
              name: voice.name,
              previewURL: voice.preview_audio_url,
              provider: 'volcano-engine',
            }
          })
        },
      },
      category: 'speech',
      createProvider: async config => createUnVolcengine((config.apiKey as string).trim(), (config.baseUrl as string).trim()),
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
      }),
      description: 'volcengine.com',
      descriptionKey: 'settings.pages.providers.provider.volcengine.description',
      iconColor: 'i-lobe-icons:volcengine',
      id: 'volcengine',
      name: 'settings.pages.providers.provider.volcengine.title',
      nameKey: 'settings.pages.providers.provider.volcengine.title',
      tasks: ['text-to-speech'],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
            !((config.app as any)?.appId) && new Error('App ID is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl && !!config.app && !!(config.app as any).appId,
          }
        },
      },
    },
  }

  const VISION_PROVIDER_ID_PREFIX = 'vision-'

  function createVisionProviderMetadata(metadata: ProviderMetadata): ProviderMetadata {
    return {
      ...metadata,
      category: 'vision',
      id: `${VISION_PROVIDER_ID_PREFIX}${metadata.id}`,
      tasks: Array.from(new Set([...metadata.tasks, 'image-understanding', 'vision'])),
      to: `/settings/providers/vision/${metadata.id}`,
    }
  }

  // Progressive migration bridge:
  // translate unified provider definitions from libs/providers to legacy store metadata.
  // Existing metadata remains as fallback for providers not yet migrated.
  const definedProviders = listDefinedProviders()
  const definedProviderIds = new Set(definedProviders.map(d => d.id))

  const translatedProviderMetadata = convertProviderDefinitionsToMetadata(
    definedProviders,
    t,
    providerMetadata,
  )

  const providerValidationIntervalMsById = new Map<string, number>()
  for (const definition of definedProviders) {
    const intervalMs = getProviderValidationIntervalMs({
      contextOptions: { t },
      definition,
    })
    if (intervalMs && intervalMs > 0) {
      providerValidationIntervalMsById.set(definition.id, intervalMs)
      providerValidationIntervalMsById.set(`${VISION_PROVIDER_ID_PREFIX}${definition.id}`, intervalMs)
    }
  }

  // Merge unified registry definitions into providerMetadata.
  // Unified defineProvider() entries always take precedence over legacy hand-written
  // metadata. Legacy entries are kept only as fallback for providers not yet migrated
  // to defineProvider().
  // TODO: progressively migrate legacy speech/transcription providers to defineProvider()
  // and remove the hand-written metadata above entirely.
  for (const [providerId, translated] of Object.entries(translatedProviderMetadata)) {
    providerMetadata[providerId] = translated
  }

  for (const metadata of Object.values(providerMetadata)
    .filter(metadata => metadata.category === 'chat')
    .map(createVisionProviderMetadata)) {
    providerMetadata[metadata.id] = metadata
  }

  for (const metadata of Object.values(providerMetadata)) {
    if (definedProviderIds.has(metadata.id))
      continue
    Object.assign(metadata, resolveProviderSourceMetadata(metadata))
  }

  // const validatedCredentials = ref<Record<string, string>>({})
  const providerRuntimeState = ref<Record<string, ProviderRuntimeState>>({})
  const providerValidationInFlight = new Map<string, Promise<boolean>>()
  const providerRevalidationLoops = new Map<string, { pause: () => void, resume: () => void }>()

  // Server-driven availability overrides for providers whose visibility can
  // only be decided at runtime from the backend (e.g. the streaming TTS
  // provider, which exists only when `UNSPEECH_UPSTREAM.streaming` is
  // configured server-side). A `false` entry hides the provider from the
  // available lists regardless of its static `isAvailableBy`; an absent entry
  // means no override. Written by the auth-sync glue after it probes the
  // server. Reactive so the available/configured provider lists re-derive.
  const providerAvailabilityOverrides = ref<Record<string, boolean>>({})

  function setProviderAvailabilityOverride(providerId: string, available: boolean) {
    providerAvailabilityOverrides.value = { ...providerAvailabilityOverrides.value, [providerId]: available }
  }

  const configuredProviders = computed(() => {
    const result: Record<string, boolean> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.isConfigured
    }

    return result
  })

  function markProviderAdded(providerId: string) {
    addedProviders.value[providerId] = true
  }

  function unmarkProviderAdded(providerId: string) {
    delete addedProviders.value[providerId]
  }

  // Configuration validation functions
  async function validateProvider(providerId: string, options: { force?: boolean } = {}): Promise<boolean> {
    const metadata = providerMetadata[providerId]
    if (!metadata)
      return false

    // Web Speech API doesn't require credentials - use empty config if not present
    if (providerId === 'browser-web-speech-api') {
      if (!providerCredentials.value[providerId]) {
        providerCredentials.value[providerId] = getDefaultProviderConfig(providerId)
      }
    }

    const config = providerCredentials.value[providerId]
    if (!config && providerId !== 'browser-web-speech-api')
      return false

    const configString = JSON.stringify(config || {})
    const runtimeState = providerRuntimeState.value[providerId]
    const cacheKey = `${providerId}:${configString}`
    const forceValidation = options.force === true

    if (!forceValidation && runtimeState?.validatedCredentialHash === configString && typeof runtimeState.isConfigured === 'boolean')
      return runtimeState.isConfigured

    if (!forceValidation) {
      const pending = providerValidationInFlight.get(cacheKey)
      if (pending) {
        return pending
      }
    }

    const runValidation = async () => {
      // PITFALL: Please consider skip chat ping check during automatic/background validation,
      // since this can consume API tokens and may only be triggered
      // by user action (e.g. "Ping API" button on settings pages) or other user intentions.
      const validationResult = await metadata.validators.validateProviderConfig(config || {}, {
        skipChatPingCheck: true,
      })

      if (providerRuntimeState.value[providerId]) {
        providerRuntimeState.value[providerId].isConfigured = validationResult.valid
        providerRuntimeState.value[providerId].validatedCredentialHash = configString
        // Auto-mark Web Speech API as added if valid and available
        if (validationResult.valid && ['browser-web-speech-api', 'player2'].includes(providerId)) {
          markProviderAdded(providerId)
        }
      }

      return validationResult.valid
    }

    if (forceValidation) {
      return runValidation()
    }

    const task = runValidation()
    providerValidationInFlight.set(cacheKey, task)
    return task.finally(() => {
      providerValidationInFlight.delete(cacheKey)
    })
  }

  // Create computed properties for each provider's configuration status

  function getDefaultProviderConfig(providerId: string) {
    const metadata = providerMetadata[providerId]
    const defaultOptions = metadata?.defaultOptions?.() || {}
    return {
      ...defaultOptions,
      ...(Object.hasOwn(defaultOptions, 'baseUrl') ? {} : { baseUrl: '' }),
    }
  }

  // Initialize provider configurations
  function initializeProvider(providerId: string) {
    if (!providerCredentials.value[providerId]) {
      providerCredentials.value[providerId] = getDefaultProviderConfig(providerId)
    }
    if (!providerRuntimeState.value[providerId]) {
      providerRuntimeState.value[providerId] = {
        isConfigured: false,
        isLoadingModels: false,
        modelLoadError: null,
        models: [],
      }
    }
  }

  // Initialize all providers
  Object.keys(providerMetadata).forEach(initializeProvider)

  function stopRevalidationLoop(providerId: string) {
    const loop = providerRevalidationLoops.get(providerId)
    if (!loop)
      return
    loop.pause()
    providerRevalidationLoops.delete(providerId)
  }

  function reconcileUnlistedProviders() {
    for (const providerId of Object.keys(providerMetadata)) {
      if (shouldListProvider(providerId))
        continue
      stopRevalidationLoop(providerId)
      const runtimeState = providerRuntimeState.value[providerId]
      if (!runtimeState)
        continue
      runtimeState.isConfigured = false
      runtimeState.validatedCredentialHash = undefined
    }
  }

  function startPeriodicRuntimeValidation() {
    for (const [providerId, intervalMs] of providerValidationIntervalMsById.entries()) {
      if (!providerMetadata[providerId] || intervalMs <= 0)
        continue

      if (!shouldListProvider(providerId))
        continue

      if (providerRevalidationLoops.has(providerId)) {
        continue
      }

      const loop = useIntervalFn(() => {
        void validateProvider(providerId, { force: true })
      }, intervalMs, { immediate: false, immediateCallback: false })
      loop.resume()
      providerRevalidationLoops.set(providerId, loop)
    }
  }

  // Update configuration status for listed providers only.
  async function updateConfigurationStatus() {
    await Promise.all(Object.entries(providerMetadata)
      .filter(([providerId]) => shouldListProvider(providerId) || providerId === 'browser-web-speech-api')
      .map(async ([providerId]) => {
        try {
          if (providerRuntimeState.value[providerId]) {
            const isValid = await validateProvider(providerId)
            providerRuntimeState.value[providerId].isConfigured = isValid
          }
        }
        catch {
          if (providerRuntimeState.value[providerId]) {
            providerRuntimeState.value[providerId].isConfigured = false
          }
        }
      }))
  }

  async function refreshListedProviderValidation() {
    reconcileUnlistedProviders()
    await updateConfigurationStatus()
    startPeriodicRuntimeValidation()
  }

  // Call initially and watch for changes
  watch(providerCredentials, refreshListedProviderValidation, { deep: true, immediate: true })
  watch(addedProviders, refreshListedProviderValidation, { deep: true })
  watch(() => authState.isAuthenticated, refreshListedProviderValidation)

  // Available providers (only those that are properly configured)
  const availableProviders = computed(() => Object.keys(providerMetadata).filter(providerId => providerRuntimeState.value[providerId]?.isConfigured))

  // Store available models for each provider
  const availableModels = computed(() => {
    const result: Record<string, ModelInfo[]> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.models
    }
    return result
  })

  const isLoadingModels = computed(() => {
    const result: Record<string, boolean> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.isLoadingModels
    }
    return result
  })

  const modelLoadError = computed(() => {
    const result: Record<string, null | string> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.modelLoadError
    }
    return result
  })

  function deleteProvider(providerId: string) {
    delete providerCredentials.value[providerId]
    delete providerRuntimeState.value[providerId]
    unmarkProviderAdded(providerId)
  }

  function forceProviderConfigured(providerId: string) {
    if (providerRuntimeState.value[providerId]) {
      providerRuntimeState.value[providerId].isConfigured = true
      // Also cache the current config to prevent re-validation from overwriting
      const config = providerCredentials.value[providerId]
      if (config) {
        providerRuntimeState.value[providerId].validatedCredentialHash = JSON.stringify(config)
      }
    }
    markProviderAdded(providerId)
  }

  function setProviderUnconfigured(providerId: string) {
    if (providerRuntimeState.value[providerId]) {
      providerRuntimeState.value[providerId].isConfigured = false
      providerRuntimeState.value[providerId].validatedCredentialHash = undefined
    }
    unmarkProviderAdded(providerId)
  }

  async function resetProviderSettings() {
    providerCredentials.value = {}
    addedProviders.value = {}
    providerRuntimeState.value = {}

    Object.keys(providerMetadata).forEach(initializeProvider)
    providerRevalidationLoops.forEach(loop => loop.pause())
    providerRevalidationLoops.clear()
    await refreshListedProviderValidation()
  }

  // Function to fetch models for a specific provider
  async function fetchModelsForProvider(providerId: string) {
    const startedAt = Date.now()
    const metadata = providerMetadata[providerId]
    if (!metadata)
      return []

    const config = providerCredentials.value[providerId]
    if (!config && metadata.requiresCredentials !== false)
      return []

    const runtimeState = providerRuntimeState.value[providerId]
    if (runtimeState) {
      runtimeState.isLoadingModels = true
      runtimeState.modelLoadError = null
    }

    try {
      const models = metadata.capabilities.listModels ? await metadata.capabilities.listModels(config || {}) : []

      // Transform and store the models
      if (runtimeState) {
        runtimeState.models = uniqBy(models.filter(model => !!model.id), m => m.id)
          .map(model => ({
            contextLength: model.contextLength,
            deprecated: model.deprecated,
            description: model.description,
            id: model.id,
            name: model.name,
            provider: providerId,
          }))
        trackModelListLoaded({
          duration_ms: Date.now() - startedAt,
          model_count: runtimeState.models.length,
          provider_id: providerId,
          provider_mode: analyticsProviderMode(providerId),
        })
        return runtimeState.models
      }
      trackModelListLoaded({
        duration_ms: Date.now() - startedAt,
        model_count: 0,
        provider_id: providerId,
        provider_mode: analyticsProviderMode(providerId),
      })
      return []
    }
    catch (error) {
      console.error(`Error fetching models for ${providerId}:`, error)
      if (runtimeState) {
        runtimeState.modelLoadError = errorMessageFrom(error) ?? 'Unknown error'
      }
      trackModelListFailed({
        duration_ms: Date.now() - startedAt,
        error_code: 'provider_error',
        provider_id: providerId,
        provider_mode: analyticsProviderMode(providerId),
      })
      return []
    }
    finally {
      if (runtimeState) {
        runtimeState.isLoadingModels = false
      }
    }
  }

  // Get models for a specific provider
  function getModelsForProvider(providerId: string) {
    return providerRuntimeState.value[providerId]?.models || []
  }

  // Get all available models across all configured providers
  const allAvailableModels = computed(() => {
    const models: ModelInfo[] = []
    for (const providerId of availableProviders.value) {
      models.push(...(providerRuntimeState.value[providerId]?.models || []))
    }
    return models
  })

  // Load models for all configured providers
  async function loadModelsForConfiguredProviders() {
    for (const providerId of availableProviders.value) {
      if (providerMetadata[providerId].capabilities.listModels) {
        await fetchModelsForProvider(providerId)
      }
    }
  }
  const previousCredentialHashes = ref<Record<string, string>>({})

  // Watch for credential changes and refetch models accordingly
  watch(providerCredentials, (newCreds) => {
    const changedProviders: string[] = []

    for (const providerId in newCreds) {
      const currentConfig = newCreds[providerId]
      const currentHash = JSON.stringify(currentConfig)
      const previousHash = previousCredentialHashes.value[providerId]

      if (currentHash !== previousHash) {
        changedProviders.push(providerId)
        previousCredentialHashes.value[providerId] = currentHash
      }
    }

    for (const providerId of changedProviders) {
      // Since credentials changed, dispose the cached instance so new creds take effect.
      void disposeProviderInstance(providerId)

      // If the provider is configured and has the capability, refetch its models
      if (providerRuntimeState.value[providerId]?.isConfigured && providerMetadata[providerId]?.capabilities.listModels) {
        fetchModelsForProvider(providerId)
      }
    }
  }, { deep: true, immediate: true })

  // Function to get localized provider metadata
  function getProviderMetadata(providerId: string) {
    const metadata = providerMetadata[providerId]

    if (!metadata)
      throw new Error(`Provider metadata for ${providerId} not found`)

    return {
      ...metadata,
      localizedDescription: t(metadata.descriptionKey, metadata.description),
      localizedName: t(metadata.nameKey, metadata.name),
    }
  }

  // Get all providers metadata (for settings page).
  // Order: defined providers first (already sorted by order in registry), then legacy-only providers.
  const allProvidersMetadata = computed(() => {
    const localize = (metadata: ProviderMetadata) => ({
      ...metadata,
      configured: providerRuntimeState.value[metadata.id]?.isConfigured || false,
      localizedDescription: t(metadata.descriptionKey, metadata.description),
      localizedName: t(metadata.nameKey, metadata.name),
    })

    const ordered = definedProviders
      .filter(d => providerMetadata[d.id])
      .map(d => localize(providerMetadata[d.id]))

    const legacy = Object.values(providerMetadata)
      .filter(m => !definedProviderIds.has(m.id))
      .map(localize)

    return [...ordered, ...legacy]
  })

  function getTranscriptionFeatures(providerId: string) {
    const metadata = providerMetadata[providerId]
    const features = metadata?.transcriptionFeatures

    return {
      supportsGenerate: features?.supportsGenerate ?? true,
      supportsStreamInput: features?.supportsStreamInput ?? false,
      supportsStreamOutput: features?.supportsStreamOutput ?? false,
    }
  }

  // Function to get provider object by provider id
  async function getProviderInstance<R extends
  | ChatProvider
  | ChatProviderWithExtraOptions
  | EmbedProvider
  | EmbedProviderWithExtraOptions
  | SpeechProvider
  | SpeechProviderWithExtraOptions
  | TranscriptionProvider
  | TranscriptionProviderWithExtraOptions,
  >(providerId: string): Promise<R> {
    const cached = providerInstanceCache.value[providerId] as R | undefined
    if (cached)
      return cached

    const metadata = providerMetadata[providerId]
    if (!metadata)
      throw new Error(`Provider metadata for ${providerId} not found`)

    // Providers that don't require credentials use empty config
    let config = providerCredentials.value[providerId]
    const noCredentials = metadata.requiresCredentials === false || providerId === 'browser-web-speech-api'
    if (!config && noCredentials) {
      config = getDefaultProviderConfig(providerId) || {}
      providerCredentials.value[providerId] = config
    }

    if (!config && !noCredentials)
      throw new Error(`Provider credentials for ${providerId} not found`)

    try {
      const instance = await metadata.createProvider(config || {}) as R
      providerInstanceCache.value[providerId] = instance
      return instance
    }
    catch (error) {
      console.error(`Error creating provider instance for ${providerId}:`, error)
      throw error
    }
  }

  async function disposeProviderInstance(providerId: string) {
    const instance = providerInstanceCache.value[providerId] as undefined | { dispose?: () => Promise<void> | void }
    if (instance?.dispose)
      await instance.dispose()

    delete providerInstanceCache.value[providerId]
  }

  const availableProvidersMetadata = computedAsync<ProviderMetadata[]>(async () => {
    // Spread-read the overrides synchronously so this re-runs when a
    // server-driven availability flips: computedAsync uses watchEffect, which
    // only tracks reactive reads before the first `await` — the per-provider
    // `isAvailableBy()` below runs after one, so reads inside it aren't tracked.
    const overrides = { ...providerAvailabilityOverrides.value }
    const providers: ProviderMetadata[] = []

    for (const provider of allProvidersMetadata.value) {
      if (overrides[provider.id] === false)
        continue

      const metadata = getProviderMetadata(provider.id)
      if (isCustomProvidersDisabled() && metadata.requiresCredentials !== false)
        continue

      const isAvailableBy = metadata.isAvailableBy || (() => true)

      const isAvailable = await isAvailableBy()
      if (isAvailable) {
        providers.push(provider)
      }
    }

    return providers
  }, [])

  const allChatProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => metadata.category === 'chat')
  })

  const allAudioSpeechProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => metadata.category === 'speech')
  })

  const allAudioTranscriptionProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => metadata.category === 'transcription')
  })

  const allVisionProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => metadata.category === 'vision')
  })

  const configuredChatProvidersMetadata = computed(() => {
    return allChatProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  const configuredSpeechProvidersMetadata = computed(() => {
    return allAudioSpeechProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  const configuredTranscriptionProvidersMetadata = computed(() => {
    return allAudioTranscriptionProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  const configuredVisionProvidersMetadata = computed(() => {
    return allVisionProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  function isProviderConfigDirty(providerId: string) {
    const config = providerCredentials.value[providerId]
    if (!config)
      return false

    const defaultOptions = getDefaultProviderConfig(providerId)
    return JSON.stringify(config) !== JSON.stringify(defaultOptions)
  }

  function shouldListProvider(providerId: string) {
    return !!addedProviders.value[providerId] || isProviderConfigDirty(providerId)
  }

  const persistedProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => shouldListProvider(metadata.id))
  })

  const persistedChatProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'chat')
  })

  const persistedSpeechProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'speech')
  })

  const persistedTranscriptionProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'transcription')
  })

  const persistedVisionProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'vision')
  })

  function getProviderConfig(providerId: string) {
    return providerCredentials.value[providerId]
  }

  return {
    addedProviders,
    allAudioSpeechProvidersMetadata,
    allAudioTranscriptionProvidersMetadata,
    allAvailableModels,
    allChatProvidersMetadata,
    allProvidersMetadata,
    allVisionProvidersMetadata,
    availableModels,
    availableProviders,
    availableProvidersMetadata,
    configuredChatProvidersMetadata,
    configuredProviders,
    configuredSpeechProvidersMetadata,
    configuredTranscriptionProvidersMetadata,
    configuredVisionProvidersMetadata,
    deleteProvider,
    disposeProviderInstance,
    fetchModelsForProvider,
    forceProviderConfigured,
    getModelsForProvider,
    getProviderConfig,
    getProviderInstance,
    getProviderMetadata,
    getTranscriptionFeatures,
    initializeProvider,
    isLoadingModels,
    loadModelsForConfiguredProviders,
    markProviderAdded,
    modelLoadError,
    persistedChatProvidersMetadata,
    persistedProvidersMetadata,
    persistedSpeechProvidersMetadata,
    persistedTranscriptionProvidersMetadata,
    persistedVisionProvidersMetadata,
    providerMetadata,
    providerRuntimeState,
    providers: providerCredentials,
    resetProviderSettings,
    setProviderAvailabilityOverride,
    setProviderUnconfigured,
    unmarkProviderAdded,
    validateProvider,
  }
})

import type { TranscriptionProvider } from '@xsai-ext/providers/utils'

import type { ProviderMetadata } from '../providers'

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1/'
const DEFAULT_MODEL = 'mimo-v2.5-asr'
const PROVIDER_ID = 'mimo-audio-transcription'

export type MimoAsrLanguage = 'auto' | 'en' | 'zh'

/**
 * Builds the MiMo ASR provider around its OpenAI-compatible chat-completions
 * endpoint. MiMo accepts a single audio content part rather than the multipart
 * transcription endpoint used by standard OpenAI-compatible ASR providers.
 */
export function buildMimoAudioTranscriptionProvider(
  baseUrlValidator: (baseUrl: unknown) => null | undefined | { errors: unknown[], reason: string, valid: boolean },
): ProviderMetadata {
  return {
    capabilities: {
      listModels: async (config) => {
        const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
        const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : DEFAULT_BASE_URL
        const response = await globalThis.fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
          headers: { 'api-key': apiKey },
        })
        if (!response.ok)
          throw new Error(`Failed to list MiMo models: ${response.status} ${response.statusText}`)

        const payload = await response.json() as { data?: Array<{ id?: unknown }> }
        return (payload.data ?? [])
          .filter((model): model is { id: string } => typeof model.id === 'string' && model.id.endsWith('-asr'))
          .map(model => ({
            contextLength: model.id === DEFAULT_MODEL ? 8_000 : 0,
            deprecated: false,
            description: 'MiMo automatic speech recognition',
            id: model.id,
            name: model.id === DEFAULT_MODEL ? 'MiMo V2.5 ASR' : model.id,
            provider: PROVIDER_ID,
          }))
      },
    },
    category: 'transcription',
    createProvider: async (config) => {
      const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
      const baseUrl = typeof config.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : DEFAULT_BASE_URL
      const rawBaseUrl = `${baseUrl.replace(/\/+$/, '')}/`
      const language = languageFrom(config.language)
      const configuredModel = asrModelFrom(config.model)

      const provider: TranscriptionProvider = {
        transcription: requestedModel => ({
          baseURL: rawBaseUrl,
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            const formData = init?.body
            if (!(formData instanceof FormData))
              throw new Error('MiMo ASR requires multipart transcription input')

            const file = formData.get('file')
            if (!(file instanceof Blob))
              throw new Error('No audio file provided for transcription')

            const inputAudio = await audioInput(file)
            const selectedModel = asrModelFrom(requestedModel || formData.get('model') || configuredModel)
            const response = await globalThis.fetch(`${rawBaseUrl}chat/completions`, {
              body: JSON.stringify({
                asr_options: { language },
                messages: [{
                  content: [{
                    input_audio: inputAudio,
                    type: 'input_audio',
                  }],
                  role: 'user',
                }],
                model: selectedModel,
                stream: false,
              }),
              headers: {
                'api-key': apiKey,
                'Content-Type': 'application/json',
              },
              method: 'POST',
            })

            if (!response.ok) {
              const errorBody = await response.text().catch(() => '')
              throw new Error(`MiMo transcription failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ''}`)
            }

            const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
            const text = data.choices?.[0]?.message?.content ?? ''
            return Response.json({ text })
          },
          headers: {},
          model: DEFAULT_MODEL,
        }),
      }

      return provider
    },
    defaultOptions: () => ({
      baseUrl: DEFAULT_BASE_URL,
      language: 'auto',
      model: DEFAULT_MODEL,
    }),
    description: 'api.xiaomimimo.com',
    descriptionKey: 'settings.pages.providers.provider.mimo.description',
    icon: 'i-simple-icons:xiaomi',
    id: PROVIDER_ID,
    name: 'Xiaomi MiMo',
    nameKey: 'settings.pages.providers.provider.mimo.title',
    tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
    transcriptionFeatures: {
      supportsGenerate: true,
      supportsStreamInput: false,
      supportsStreamOutput: false,
    },
    validators: {
      chatPingCheckAvailable: false,
      validateProviderConfig: (config) => {
        const errors = [
          !config.apiKey && new Error('API key is required.'),
          !config.baseUrl && new Error('Base URL is required.'),
        ].filter((error): error is Error => !!error)

        const baseUrlValidationResult = baseUrlValidator(config.baseUrl)
        if (baseUrlValidationResult)
          return baseUrlValidationResult

        return {
          errors,
          reason: errors.map(error => error.message).join(', '),
          valid: errors.length === 0,
        }
      },
    },
  }
}

function asrModelFrom(value: unknown): string {
  return typeof value === 'string' && value.endsWith('-asr') ? value : DEFAULT_MODEL
}

function audioFormatFrom(bytes: Uint8Array, declaredMimeType: string): 'mp3' | 'wav' | undefined {
  const mimeType = declaredMimeType.toLowerCase().split(';', 1)[0].trim()
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3')
    return 'mp3'
  if (mimeType === 'audio/wav' || mimeType === 'audio/wave' || mimeType === 'audio/x-wav')
    return 'wav'

  const isWav = bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE'
  if (isWav)
    return 'wav'

  const hasId3Header = bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
  const hasMpegFrameSync = bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0
  return hasId3Header || hasMpegFrameSync ? 'mp3' : undefined
}

async function audioInput(file: Blob): Promise<{ data: string, format: 'mp3' | 'wav' }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = audioFormatFrom(bytes, file.type)
  if (!format)
    throw new Error(`MiMo ASR supports only MP3 and WAV audio, received ${file.type || 'an unknown format'}`)

  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))

  return {
    data: `data:${format === 'wav' ? 'audio/wav' : 'audio/mpeg'};base64,${btoa(binary)}`,
    format,
  }
}

function languageFrom(value: unknown): MimoAsrLanguage {
  return value === 'en' || value === 'zh' ? value : 'auto'
}

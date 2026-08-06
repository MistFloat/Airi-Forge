import type { SpeechProvider } from '@xsai-ext/providers/utils'

import type { ModelInfo, ProviderMetadata, VoiceInfo } from '../providers'

const DEFAULT_BASE_URL = 'https://api-tts.knowlez.com/'
const DEFAULT_MODEL = 'knowlez-tts'
const PROVIDER_ID = 'knowlez-tts'

export function buildKnowlezTtsProvider(
  baseUrlValidator: (baseUrl: unknown) => null | undefined | { errors: unknown[], reason: string, valid: boolean },
): ProviderMetadata {
  return {
    capabilities: {
      listModels: async () => listModels(),
      listVoices: async () => listVoices(),
    },
    category: 'speech',
    createProvider: async (config) => {
      const apiKey = normalizeApiKey(config.apiKey)
      const baseUrl = normalizeBaseUrl(config.baseUrl)
      return createSpeechProvider(apiKey, baseUrl)
    },
    defaultOptions: () => ({
      baseUrl: DEFAULT_BASE_URL,
    }),
    description: 'api-tts.knowlez.com',
    descriptionKey: 'settings.pages.providers.provider.knowlez-tts.description',
    icon: 'i-solar:cloud-upload-bold-duotone',
    id: PROVIDER_ID,
    name: 'Knowlez TTS',
    nameKey: 'settings.pages.providers.provider.knowlez-tts.title',
    tasks: ['text-to-speech'],
    validators: {
      chatPingCheckAvailable: false,
      validateProviderConfig: (config) => {
        const errors: Error[] = []
        if (!config.apiKey)
          errors.push(new Error('API Key is required.'))

        if (config.baseUrl) {
          const res = baseUrlValidator(config.baseUrl)
          if (res)
            return res
        }

        return {
          errors,
          reason: errors.map(e => e.message).join(', '),
          valid: errors.length === 0,
        }
      },
    },
  }
}

/**
 * Custom fetch adapter that translates an OpenAI-compatible TTS request
 * into the knowlez TTS API format and routes it through the main-process
 * proxy server to avoid Cloudflare blocks and system proxy interference.
 *
 * The renderer sends to the local proxy at 127.0.0.1:6122, which uses
 * undici fetch in the main process to call the Knowlez API:
 * - POST {baseUrl}/v1/tts/synthesise
 * - Header: X-API-Key
 * - Body: { text, voice?, format?, speed? }
 * - Response: raw audio bytes
 */
function createAudioFetch(apiKey: string, baseUrl: string) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!init?.body || typeof init.body !== 'string')
      throw new Error('Invalid request body')

    const body = JSON.parse(init.body) as { input?: unknown, voice?: unknown }
    if (typeof body.input !== 'string' || !body.input.trim())
      throw new Error('Knowlez TTS requires non-empty text input')

    // Knowlez documents a plain `text` JSON field rather than Azure's raw
    // `application/ssml+xml` request contract. Reject markup locally so users
    // receive an actionable error instead of the proxy's opaque upstream 400.
    if (/<\s*speak(?:\s|>)/i.test(body.input))
      throw new Error('Knowlez TTS accepts plain text only; disable Custom SSML or use the Azure Speech provider')

    const requestBody: Record<string, unknown> = {
      apiKey,
      baseUrl: baseUrl || 'https://api-tts.knowlez.com/',
      format: 'mp3',
      return: 'audio',
      text: body.input,
    }

    if (typeof body.voice === 'string' && body.voice)
      requestBody.voice = body.voice

    // NOTICE: Route through the main-process proxy server (port 6122)
    // to bypass Cloudflare blocks that affect the renderer's Chromium fetch.
    // The proxy uses undici fetch in the main process which is not subject
    // to the same restrictions as the renderer's fetch.
    const proxyUrl = 'http://127.0.0.1:6122/api/v1/knowlez/tts'
    const response = await globalThis.fetch(proxyUrl, {
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(`Knowlez TTS request failed: ${response.status} ${errorText}`)
    }

    return response
  }
}

function createSpeechProvider(apiKey: string, baseUrl: string): SpeechProvider {
  return {
    speech: (_model?: string) => {
      return {
        baseURL: baseUrl,
        fetch: createAudioFetch(apiKey, baseUrl),
        model: DEFAULT_MODEL,
      }
    },
  }
}

function listModels(): ModelInfo[] {
  return [
    {
      contextLength: 0,
      deprecated: false,
      description: 'Text-to-Speech via Knowlez API',
      id: DEFAULT_MODEL,
      name: 'Knowlez TTS',
      provider: PROVIDER_ID,
    },
  ]
}

function listVoices(): VoiceInfo[] {
  // NOTICE:
  // Knowlez does not publish a voices endpoint or a supported voice catalog.
  // Its OpenAPI contract documents `af_bella` as the default, while Azure voice
  // identifiers used by the earlier adapter are not part of this API contract.
  // Add more voices only when Knowlez publishes an authoritative catalog.
  return [{
    id: 'af_bella',
    languages: [{ code: 'en', title: 'English' }],
    name: 'Bella',
    provider: PROVIDER_ID,
  } satisfies VoiceInfo]
}

function normalizeApiKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBaseUrl(value: unknown): string {
  let base = typeof value === 'string' ? value.trim() : ''
  if (!base)
    base = DEFAULT_BASE_URL
  if (!base.endsWith('/'))
    base += '/'
  return base
}

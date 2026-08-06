import type { SpeechProvider } from '@xsai-ext/providers/utils'

import type { ModelInfo, ProviderMetadata, VoiceInfo } from '../../providers'

import { OPENROUTER_ATTRIBUTION_HEADERS } from '../../../libs/providers/providers/openrouter-ai'

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1/'
const DEFAULT_MODEL = 'openai/gpt-audio-mini'
const PROVIDER_ID = 'openrouter-audio-speech'

function TTS_PROMPT_TEMPLATE(input: string) {
  return `Read this text aloud exactly as written, without any commentary or extra words:\n\n${input}`
}

const OPENAI_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const

export function buildOpenRouterAudioSpeechProvider(
  baseUrlValidator: (baseUrl: unknown) => null | undefined | { errors: unknown[], reason: string, valid: boolean },
): ProviderMetadata {
  return {
    capabilities: {
      listModels: async (config: Record<string, unknown>) => {
        try {
          return await listModels(normalizeBaseUrl(config.baseUrl))
        }
        catch (error) {
          console.error('Failed to fetch OpenRouter audio models:', error)
          return []
        }
      },
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
    description: 'openrouter.ai',
    descriptionKey: 'settings.pages.providers.provider.openrouter-audio-speech.description',
    icon: 'i-lobe-icons:openrouter',
    id: PROVIDER_ID,
    name: 'OpenRouter',
    nameKey: 'settings.pages.providers.provider.openrouter-audio-speech.title',
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
 * Collects base64-encoded audio chunks from an SSE stream where each
 * `data:` line is a chat-completion delta containing `delta.audio.data`.
 */
async function collectAudioChunksFromSSE(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const audioDataChunks: string[] = []
  let buffer = ''

  let done = false
  while (!done) {
    const result = await reader.read()
    if (result.done)
      break

    buffer += decoder.decode(result.value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const line of lines) {
      if (!line.startsWith('data: '))
        continue
      const data = line.slice('data: '.length).trim()
      if (data === '[DONE]') {
        done = true
        break
      }

      try {
        const chunk = JSON.parse(data)
        const audio = chunk.choices?.[0]?.delta?.audio
        if (audio?.data)
          audioDataChunks.push(audio.data)
      }
      catch (e) {
        console.warn('Skipping malformed SSE chunk from OpenRouter audio stream:', data, e)
      }
    }
  }

  return audioDataChunks
}

/**
 * Custom fetch adapter that translates an OpenAI-compatible TTS request
 * into an OpenRouter streaming chat-completion with audio modality,
 * then returns the assembled WAV as a standard Response.
 */
function createAudioFetch(apiKey: string, baseUrl: string, model: string) {
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!init?.body || typeof init.body !== 'string')
      throw new Error('Invalid request body')

    const body = JSON.parse(init.body)

    const sseResponse = await globalThis.fetch(new URL('chat/completions', baseUrl), {
      body: JSON.stringify({
        audio: { format: 'pcm16', voice: body.voice },
        messages: [
          { content: TTS_PROMPT_TEMPLATE(body.input), role: 'user' },
        ],
        modalities: ['text', 'audio'],
        model,
        stream: true,
      }),
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...OPENROUTER_ATTRIBUTION_HEADERS,
      },
      method: 'POST',
    })

    if (!sseResponse.ok) {
      const errorText = await sseResponse.text()
      throw new Error(`OpenRouter audio request failed: ${sseResponse.status} ${errorText}`)
    }

    const audioChunks = await collectAudioChunksFromSSE(sseResponse.body!)
    const pcmBytes = decodeBase64PCM(audioChunks)
    const wavBytes = wrapPCM16InWAV(pcmBytes)

    return new Response(new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' }), {
      headers: { 'Content-Type': 'audio/wav' },
      status: 200,
    })
  }
}

function createSpeechProvider(apiKey: string, baseUrl: string): SpeechProvider {
  return {
    speech: (model?: string) => {
      const resolvedModel = model || DEFAULT_MODEL
      return {
        baseURL: baseUrl,
        fetch: createAudioFetch(apiKey, baseUrl, resolvedModel),
        model: resolvedModel,
      }
    },
  }
}

/** Decodes concatenated base64 strings into a raw PCM byte array. */
function decodeBase64PCM(chunks: string[]): Uint8Array {
  const binaryString = atob(chunks.join(''))
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++)
    bytes[i] = binaryString.charCodeAt(i)
  return bytes
}

async function listModels(baseUrl: string): Promise<ModelInfo[]> {
  const res = await fetch(`${baseUrl}models?output_modality=audio`, {
    headers: OPENROUTER_ATTRIBUTION_HEADERS,
  })
  if (!res.ok)
    return []

  const json = await res.json()
  const models = json.data || []
  return models.map((m: { context_length?: number, description?: string, id: string, name?: string }) => ({
    contextLength: m.context_length || 0,
    deprecated: false,
    description: m.description || '',
    id: m.id,
    name: m.name || m.id,
    provider: PROVIDER_ID,
  } satisfies ModelInfo))
}

function listVoices(): VoiceInfo[] {
  return OPENAI_VOICES.map(id => ({
    id,
    languages: [],
    name: id.charAt(0).toUpperCase() + id.slice(1),
    provider: PROVIDER_ID,
  } satisfies VoiceInfo))
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

/** Wraps raw PCM16 mono data in a minimal WAV container. */
function wrapPCM16InWAV(pcmBytes: Uint8Array, sampleRate = 24000): Uint8Array {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i))
  }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcmBytes.length, true)
  writeStr(8, 'WAVE')

  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)

  writeStr(36, 'data')
  view.setUint32(40, pcmBytes.length, true)

  const wav = new Uint8Array(44 + pcmBytes.length)
  wav.set(new Uint8Array(header), 0)
  wav.set(pcmBytes, 44)
  return wav
}

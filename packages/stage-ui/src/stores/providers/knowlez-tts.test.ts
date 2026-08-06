import type { SpeechProvider } from '@xsai-ext/providers/utils'

import { generateSpeech } from '@xsai/generate-speech'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildKnowlezTtsProvider } from './knowlez-tts'

describe('knowlez TTS provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adapts AIRI speech requests to the documented Knowlez contract', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'audio/mpeg' },
      status: 200,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const metadata = buildKnowlezTtsProvider(() => null)
    const provider = await metadata.createProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api-tts.knowlez.com/',
    }) as SpeechProvider<string>

    const audio = await generateSpeech({
      ...provider.speech('knowlez-tts'),
      input: 'Hello from AIRI',
      voice: 'af_bella',
    })

    expect(new Uint8Array(audio)).toEqual(new Uint8Array([1, 2, 3]))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const call = fetchMock.mock.calls.at(0)
    expect(call).toBeDefined()
    if (!call)
      throw new Error('Expected Knowlez proxy request')

    const [url, init] = call
    expect(url).toBe('http://127.0.0.1:6122/api/v1/knowlez/tts')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init?.body))).toEqual({
      apiKey: 'test-key',
      baseUrl: 'https://api-tts.knowlez.com/',
      format: 'mp3',
      return: 'audio',
      text: 'Hello from AIRI',
      voice: 'af_bella',
    })
  })

  it('exposes only the voice documented by Knowlez', async () => {
    const metadata = buildKnowlezTtsProvider(() => null)

    const voices = await metadata.capabilities.listVoices?.({})

    expect(voices).toEqual([expect.objectContaining({
      id: 'af_bella',
      provider: 'knowlez-tts',
    })])
  })

  it('rejects SSML before calling the plain-text-only Knowlez endpoint', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const metadata = buildKnowlezTtsProvider(() => null)
    const provider = await metadata.createProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api-tts.knowlez.com/',
    }) as SpeechProvider<string>

    await expect(generateSpeech({
      ...provider.speech('knowlez-tts'),
      input: '<speak version="1.0"><voice name="af_bella">Hello</voice></speak>',
      voice: 'af_bella',
    })).rejects.toThrow('Knowlez TTS accepts plain text only')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

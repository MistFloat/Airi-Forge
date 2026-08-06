import type { TranscriptionProvider } from '@xsai-ext/providers/utils'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildMimoAudioTranscriptionProvider } from './mimo-audio-transcription'

describe('miMo audio transcription provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the currently supported MiMo ASR model', async () => {
    // ROOT CAUSE:
    //
    // The provider catalog previously exposed the retired `mimo-v2-omni` and
    // generic `mimo-v2.5` models, so the Hearing UI could never select MiMo's
    // only supported speech-recognition model. The catalog now owns the ASR
    // contract and exposes only `mimo-v2.5-asr`.
    const fetchMock = vi.fn(async () => Response.json({
      data: [
        { id: 'mimo-v2.5' },
        { id: 'mimo-v2.5-asr' },
        { id: 'mimo-v2.5-tts' },
      ],
    }))
    vi.stubGlobal('fetch', fetchMock)
    const metadata = buildMimoAudioTranscriptionProvider(() => null)

    const models = await metadata.capabilities.listModels?.({
      apiKey: 'mimo-test-key',
      baseUrl: 'https://api.xiaomimimo.com/v1/',
    })

    expect(models).toEqual([expect.objectContaining({
      id: 'mimo-v2.5-asr',
      provider: 'mimo-audio-transcription',
    })])
    expect(fetchMock).toHaveBeenCalledWith('https://api.xiaomimimo.com/v1/models', {
      headers: { 'api-key': 'mimo-test-key' },
    })
  })

  it('sends the documented MiMo V2.5 ASR request contract', async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      choices: [{ message: { content: '你好，AIRI。' } }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const metadata = buildMimoAudioTranscriptionProvider(() => null)
    const provider = await metadata.createProvider({
      apiKey: 'mimo-test-key',
      baseUrl: 'https://api.xiaomimimo.com/v1/',
      language: 'zh',
      model: 'mimo-v2-omni',
    }) as TranscriptionProvider
    const request = provider.transcription('mimo-v2-omni')
    const formData = new FormData()
    formData.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'sample.wav')
    formData.set('model', 'mimo-v2-omni')

    const response = await request.fetch?.('https://unused.invalid/audio/transcriptions', {
      body: formData,
      method: 'POST',
    })

    expect(await response?.json()).toEqual({ text: '你好，AIRI。' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions')
    expect(init?.headers).toEqual({
      'api-key': 'mimo-test-key',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      asr_options: { language: 'zh' },
      messages: [{
        content: [{
          input_audio: {
            data: 'data:audio/wav;base64,AQID',
            format: 'wav',
          },
          type: 'input_audio',
        }],
        role: 'user',
      }],
      model: 'mimo-v2.5-asr',
      stream: false,
    })
  })

  it('recognizes a WAV recording when its Blob has no MIME type', async () => {
    // ROOT CAUSE:
    //
    // Browser recording paths can lose the Blob MIME metadata even though the
    // payload is a valid RIFF/WAVE file. Exact MIME matching rejected those
    // recordings before MiMo received them. The provider now inspects the
    // container signature when the declared type is absent or non-standard.
    const fetchMock = vi.fn(async () => Response.json({
      choices: [{ message: { content: 'Detected WAV.' } }],
    }))
    vi.stubGlobal('fetch', fetchMock)

    const metadata = buildMimoAudioTranscriptionProvider(() => null)
    const provider = await metadata.createProvider({ apiKey: 'mimo-test-key' }) as TranscriptionProvider
    const request = provider.transcription('mimo-v2.5-asr')
    const wavHeader = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x04,
      0x00,
      0x00,
      0x00,
      0x57,
      0x41,
      0x56,
      0x45,
    ])
    const formData = new FormData()
    formData.set('file', new Blob([wavHeader]), 'recording.wav')

    await request.fetch?.('https://unused.invalid/audio/transcriptions', {
      body: formData,
      method: 'POST',
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(String(init?.body))
    expect(body.messages[0].content[0].input_audio).toEqual({
      data: 'data:audio/wav;base64,UklGRgQAAABXQVZF',
      format: 'wav',
    })
  })
})

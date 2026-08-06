import type { BuiltInServerAddress } from '../../server'

import { errorMessageFrom } from '@moeru/std'
import { eventHandler, H3, readBody } from 'h3'

import { createH3Server } from '../../server'

/**
 * Creates a local h3 server that proxies knowlez TTS requests through
 * the main-process undici fetch, avoiding Cloudflare blocks that affect
 * the renderer's Chromium-based fetch.
 */
export async function createKnowlezTtsProxy(): Promise<{
  getAddress: () => BuiltInServerAddress | undefined
  serverManager: { key: string, start: () => Promise<void>, stop: () => Promise<void> }
}> {
  const app = new H3()
  const proxyServer = createH3Server({ app, host: '127.0.0.1', port: 6122 })

  app.post('/api/v1/knowlez/tts', eventHandler(async (event) => {
    const body = await readBody<{
      apiKey?: unknown
      baseUrl?: unknown
      format?: unknown
      return?: unknown
      text?: unknown
      voice?: unknown
    }>(event)

    if (!body || typeof body.apiKey !== 'string' || typeof body.text !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: apiKey, text' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 },
      )
    }

    try {
      const response = await proxyToKnowlezAPI({
        apiKey: body.apiKey,
        baseUrl: typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : 'https://api-tts.knowlez.com/',
        format: body.format === 'pcm' ? 'pcm' : 'mp3',
        returnMode: body.return === 'url' ? 'url' : 'audio',
        text: body.text,
        voice: typeof body.voice === 'string' ? body.voice : undefined,
      })

      const arrayBuffer = await response.arrayBuffer()
      const contentType = response.headers.get('content-type') ?? 'audio/mpeg'

      return new Response(arrayBuffer, {
        headers: { 'Content-Type': contentType },
        status: 200,
      })
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'Unknown error'
      return new Response(
        JSON.stringify({ error: message }),
        { headers: { 'Content-Type': 'application/json' }, status: 502 },
      )
    }
  }))

  return {
    getAddress: () => proxyServer.getAddress(),
    serverManager: {
      key: 'knowlez-tts-proxy',
      start: () => proxyServer.start().then(() => { }),
      stop: () => proxyServer.stop(),
    },
  }
}

async function proxyToKnowlezAPI(params: {
  apiKey: string
  baseUrl: string
  format?: 'mp3' | 'pcm'
  returnMode?: 'audio' | 'url'
  text: string
  voice?: string
}): Promise<Response> {
  const requestBody: Record<string, unknown> = {
    format: params.format ?? 'mp3',
    return: params.returnMode ?? 'audio',
    text: params.text,
  }
  if (params.voice)
    requestBody.voice = params.voice

  const response = await fetch(
    new URL('v1/tts/synthesise', params.baseUrl),
    {
      body: JSON.stringify(requestBody),
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': params.apiKey,
      },
      method: 'POST',
    },
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    throw new Error(`Knowlez TTS proxy failed: ${response.status} ${errorText}`)
  }

  return response
}

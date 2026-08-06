export interface MimoConfig {
  apiKey: string
  baseUrl: string
  language: MimoLanguage
  model: string
}

export type MimoLanguage = 'auto' | 'en' | 'zh'

/** Sends a mono WAV segment to MiMo's audio chat-completions contract. */
export async function transcribeWithMimo(recording: Blob, config: MimoConfig) {
  if (!config.apiKey.trim())
    throw new Error('请先填写 MiMo API Key')

  const bytes = new Uint8Array(await recording.arrayBuffer())
  const isWav = bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE'
  if (!isWav)
    throw new Error('分段不是有效的 WAV 文件')

  const baseUrl = `${config.baseUrl.trim().replace(/\/+$/, '')}/`
  const response = await fetch(`${baseUrl}chat/completions`, {
    body: JSON.stringify({
      asr_options: { language: config.language },
      messages: [{
        content: [{
          input_audio: {
            data: `data:audio/wav;base64,${encodeBase64(bytes)}`,
            format: 'wav',
          },
          type: 'input_audio',
        }],
        role: 'user',
      }],
      model: config.model.trim() || 'mimo-v2.5-asr',
      stream: false,
    }),
    headers: {
      'api-key': config.apiKey.trim(),
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`MiMo ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`)
  }

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  return payload.choices?.[0]?.message?.content?.trim() || ''
}

function encodeBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  return btoa(binary)
}

import { describe, expect, it } from 'vitest'

import { resolveVADConfig } from './vad'

describe('resolveVADConfig', () => {
  it('uses speech-sensitive defaults for threshold and silence duration', () => {
    expect(resolveVADConfig()).toEqual({
      exitThreshold: 0.105,
      minSilenceDurationMs: 1200,
      minSpeechDurationMs: 300,
      speechPadMs: 360,
      speechThreshold: 0.35,
    })
  })

  it('preserves explicit threshold and silence duration values', () => {
    expect(resolveVADConfig(0.45, 650, 420, 500)).toEqual({
      exitThreshold: 0.135,
      minSilenceDurationMs: 650,
      minSpeechDurationMs: 500,
      speechPadMs: 420,
      speechThreshold: 0.45,
    })
  })
})

import { describe, expect, it } from 'vitest'

import { shouldUploadSpeechSegment } from './speech-segment-policy'

describe('shouldUploadSpeechSegment', () => {
  it('rejects a short noise burst followed by enough silence to close a segment', () => {
    expect(shouldUploadSpeechSegment({
      minSpeechDurationMs: 300,
      sampleRate: 16000,
      segmentSamples: 20000,
      voicedSamples: 512,
    })).toBe(false)
  })

  it('keeps a short spoken command followed by the normal trailing silence', () => {
    expect(shouldUploadSpeechSegment({
      minSpeechDurationMs: 300,
      sampleRate: 16000,
      segmentSamples: 24000,
      voicedSamples: 6400,
    })).toBe(true)
  })

  it('rejects a segment whose sparse voice detections are mostly noise', () => {
    expect(shouldUploadSpeechSegment({
      minSpeechDurationMs: 300,
      sampleRate: 16000,
      segmentSamples: 64000,
      voicedSamples: 6400,
    })).toBe(false)
  })
})

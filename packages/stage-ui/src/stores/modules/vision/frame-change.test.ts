import { describe, expect, it } from 'vitest'

import { calculateFrameChange, nextVisionPollDelay, shouldBlockCaptureSource } from './frame-change'

describe('vision frame change policy', () => {
  it('ignores identical luminance samples', () => {
    expect(calculateFrameChange(new Uint8Array([0, 64, 128, 255]), new Uint8Array([0, 64, 128, 255]))).toBe(0)
  })

  it('normalizes the mean luminance delta to a stable zero-to-one score', () => {
    expect(calculateFrameChange(new Uint8Array([0, 0]), new Uint8Array([255, 255]))).toBe(1)
    expect(calculateFrameChange(new Uint8Array([0, 255]), new Uint8Array([255, 255]))).toBe(0.5)
  })

  it('checks rapidly after large changes and backs off while stable', () => {
    expect(nextVisionPollDelay({ baseIntervalMs: 3000, changeScore: 0.5, stableTicks: 0 })).toBe(750)
    expect(nextVisionPollDelay({ baseIntervalMs: 3000, changeScore: 0.001, stableTicks: 8 })).toBe(9000)
  })

  it('blocks common credential and private browsing sources case-insensitively', () => {
    expect(shouldBlockCaptureSource('Bitwarden Password Manager')).toBe(true)
    expect(shouldBlockCaptureSource('1PASSWORD')).toBe(true)
    expect(shouldBlockCaptureSource('Visual Studio Code')).toBe(false)
  })
})

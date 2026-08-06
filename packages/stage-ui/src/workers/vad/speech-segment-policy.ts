const MIN_VOICED_SAMPLE_RATIO = 0.15

export interface SpeechSegmentDecision {
  reason?: 'too-short' | 'too-sparse'
  shouldUpload: boolean
  voicedDurationMs: number
  voicedRatio: number
}

/** Measurements used to decide whether a completed VAD segment merits ASR. */
export interface SpeechSegmentMeasurements {
  /** Minimum accumulated VAD-classified speech duration. */
  minSpeechDurationMs: number
  /** Audio sample rate in samples per second. */
  sampleRate: number
  /** All samples captured after speech started, including trailing silence. */
  segmentSamples: number
  /** VAD-classified speech samples, excluding trailing silence. */
  voicedSamples: number
}

/** Returns upload eligibility together with diagnostics suitable for UI logs. */
export function evaluateSpeechSegment(measurements: SpeechSegmentMeasurements): SpeechSegmentDecision {
  const voicedDurationMs = measurements.sampleRate > 0
    ? measurements.voicedSamples / measurements.sampleRate * 1000
    : 0
  const voicedRatio = measurements.segmentSamples > 0
    ? measurements.voicedSamples / measurements.segmentSamples
    : 0

  if (voicedDurationMs < measurements.minSpeechDurationMs) {
    return { reason: 'too-short', shouldUpload: false, voicedDurationMs, voicedRatio }
  }

  if (voicedRatio < MIN_VOICED_SAMPLE_RATIO) {
    return { reason: 'too-sparse', shouldUpload: false, voicedDurationMs, voicedRatio }
  }

  return { shouldUpload: true, voicedDurationMs, voicedRatio }
}

/**
 * Decides whether a completed VAD segment contains enough actual speech for ASR.
 *
 * This intentionally reuses VAD classifications instead of running another
 * signal-analysis pass. A duration floor rejects clicks and cough-like bursts,
 * while the ratio rejects long segments made mostly from sparse false positives.
 */
export function shouldUploadSpeechSegment(measurements: SpeechSegmentMeasurements) {
  return evaluateSpeechSegment(measurements).shouldUpload
}

export interface VisionPollPolicyInput {
  /** User-selected baseline interval in milliseconds. */
  baseIntervalMs: number
  /** Mean normalized luminance difference between the latest two samples. */
  changeScore: number
  /** Number of consecutive samples below the meaningful-change threshold. */
  stableTicks: number
}

/**
 * Calculates mean absolute luminance change between equal-size frame samples.
 * A value of zero represents identical samples and one represents the largest
 * possible change at every sampled pixel.
 */
export function calculateFrameChange(previous: Uint8Array | undefined, current: Uint8Array): number {
  if (!previous || previous.length !== current.length || current.length === 0)
    return 1

  let difference = 0
  for (let index = 0; index < current.length; index += 1)
    difference += Math.abs(current[index]! - previous[index]!)

  return difference / (current.length * 255)
}

/** Selects the next local sampling delay without involving the vision model. */
export function nextVisionPollDelay(input: VisionPollPolicyInput): number {
  const baseIntervalMs = Math.min(30_000, Math.max(500, input.baseIntervalMs))

  // A large scene transition deserves a short burst so the final UI state is
  // observed soon after a window switch or modal transition.
  if (input.changeScore >= 0.18)
    return Math.max(500, Math.round(baseIntervalMs * 0.25))
  if (input.changeScore >= 0.035)
    return Math.max(750, Math.round(baseIntervalMs * 0.5))

  // Stable scenes progressively back off, capped at 30 seconds so changes are
  // still discovered without an operating-system window event integration.
  const backoffMultiplier = Math.min(4, 1 + Math.floor(input.stableTicks / 3))
  return Math.min(30_000, baseIntervalMs * backoffMultiplier)
}

const PRIVATE_SOURCE_PATTERNS = [
  /\b1password\b/i,
  /\bbitwarden\b/i,
  /\bdashlane\b/i,
  /\bkeepass(?:xc)?\b/i,
  /\blastpass\b/i,
  /password manager/i,
  /private browsing/i,
  /incognito/i,
  /密码管理/,
  /无痕/,
]

/** Returns whether a selected window title is unsafe to upload by default. */
export function shouldBlockCaptureSource(sourceName: string): boolean {
  return PRIVATE_SOURCE_PATTERNS.some(pattern => pattern.test(sourceName))
}

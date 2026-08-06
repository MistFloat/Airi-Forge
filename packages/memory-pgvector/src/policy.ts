import type { AssertionMode, EvidenceSourceType } from './domain.ts'

/**
 * Returns whether two half-open validity intervals are provably disjoint.
 * Unknown bounds intentionally return false because null means unknown, not infinity.
 */
export function areValidityIntervalsDisjoint(
  left: { validFrom?: null | string, validUntil?: null | string },
  right: { validFrom?: null | string, validUntil?: null | string },
): boolean {
  if (left.validUntil && right.validFrom && Date.parse(left.validUntil) <= Date.parse(right.validFrom))
    return true
  return !!(right.validUntil && left.validFrom && Date.parse(right.validUntil) <= Date.parse(left.validFrom))
}

/** Stable job keys make retries and duplicate application starts idempotent. */
export function embeddingJobKey(memoryId: string, schemaId: string, revision: number): string {
  return `embedding:${memoryId}:${schemaId}:${revision}`
}

/** Source support weights are policy scores, not calibrated truth probabilities. */
export function supportWeight(sourceType: EvidenceSourceType, assertionMode: AssertionMode): number {
  if (sourceType === 'user_assertion')
    return assertionMode === 'explicit' ? 0.85 : assertionMode === 'implicit' ? 0.45 : 0
  if (sourceType === 'tool_result')
    return 0.8
  if (sourceType === 'document_text')
    return 0.65
  if (sourceType === 'vision_observation')
    return 0.35
  return 0
}

/**
 * Offline metrics for a semantic-recall evaluation case.
 *
 * Each case compares the memory ids actually returned by a recall run against
 * the golden targets from the evaluation dataset. `null` means the metric is
 * not applicable because its denominator is empty, not that it scored zero.
 */
export interface RecallCaseMetrics {
  erroneouslyRecalledIds: string[]
  expectedCount: number
  forbiddenCount: number
  /** Fraction of forbidden memories that leaked into the result (null when there are no forbidden memories). */
  forbiddenHitRate: null | number
  hitCount: number
  missedExpectedIds: string[]
  /** Fraction of returned memories that match a golden target. */
  precision: number
  /** Fraction of golden targets that were actually recalled (null when there are no targets). */
  recallAtK: null | number
}

export interface RecallEvaluationSummary {
  cases: number
  /** Cases with no forbidden leak. */
  cleanCount: number
  cleanRate: null | number
  /** Mean forbidden-hit rate across cases that have at least one forbidden memory. */
  forbiddenHitRateAvg: null | number
  /** Cases where every golden target was recalled. */
  fullyRecalledCount: number
  fullyRecalledRate: null | number
  /** Cases with at least one golden target that recalled none of them. */
  missedAllCount: number
  /** Mean recall@K across cases that have at least one golden target. */
  recallAtKAvg: null | number
}

export interface RecallRanking {
  baselineRank: number
  finalRank?: number
}

/**
 * Offline metrics for a short-query recall evaluation run.
 *
 * `evaluateRecallCase` is pure and deterministic so it can be unit-tested
 * without a database or an embedding model; the lab aggregates many cases.
 */
export function evaluateRecallCase(expectedIds: string[], forbiddenIds: string[], hitIds: string[]): RecallCaseMetrics {
  const expectedSet = new Set(expectedIds)
  const forbiddenSet = new Set(forbiddenIds)
  const hitSet = new Set(hitIds)

  const expectedHits = [...expectedSet].filter(id => hitSet.has(id))
  const forbiddenHits = [...forbiddenSet].filter(id => hitSet.has(id))
  const hitCount = hitSet.size

  return {
    erroneouslyRecalledIds: forbiddenHits,
    expectedCount: expectedSet.size,
    forbiddenCount: forbiddenSet.size,
    forbiddenHitRate: forbiddenSet.size > 0 ? forbiddenHits.length / forbiddenSet.size : null,
    hitCount,
    missedExpectedIds: [...expectedSet].filter(id => !hitSet.has(id)),
    precision: hitCount > 0 ? expectedHits.length / hitCount : 0,
    recallAtK: expectedSet.size > 0 ? expectedHits.length / expectedSet.size : null,
  }
}

/**
 * Assigns the pure-similarity baseline and the post-filter final rank to each
 * merged recall candidate.
 *
 * PRD v2 §7 keeps a pure-similarity baseline in the trace so a future
 * utility/importance re-rank can be measured against it: `baselineRank` is the
 * position under similarity-only ordering, `finalRank` is the injection slot of
 * the ids passed in injection order (missing when not injected). Both are 1-based.
 */
export function rankRecallCandidates(
  candidates: ReadonlyArray<{ memoryId: string, similarity: number }>,
  injectedIds: readonly string[],
): Map<string, RecallRanking> {
  const rankings = new Map<string, RecallRanking>()
  const ranked = [...candidates].sort(
    (left, right) => right.similarity - left.similarity || left.memoryId.localeCompare(right.memoryId),
  )
  for (const [index, candidate] of ranked.entries())
    rankings.set(candidate.memoryId, { baselineRank: index + 1 })
  for (const [index, memoryId] of injectedIds.entries()) {
    const ranking = rankings.get(memoryId)
    if (ranking)
      ranking.finalRank = index + 1
  }
  return rankings
}

/** Aggregates per-case metrics into a small dashboard summary. */
export function summarizeRecallEvaluation(metrics: readonly RecallCaseMetrics[]): RecallEvaluationSummary {
  const recallCases = metrics.filter(caseMetrics => caseMetrics.recallAtK !== null)
  const forbiddenCases = metrics.filter(caseMetrics => caseMetrics.forbiddenHitRate !== null)
  const cleanCases = forbiddenCases.filter(caseMetrics => caseMetrics.forbiddenHitRate === 0)
  const fullyRecalled = recallCases.filter(caseMetrics => caseMetrics.recallAtK === 1)
  const missedAll = recallCases.filter(caseMetrics => caseMetrics.recallAtK === 0)

  const average = (values: readonly number[]): null | number => {
    if (values.length === 0)
      return null
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  return {
    cases: metrics.length,
    cleanCount: cleanCases.length,
    cleanRate: average(forbiddenCases.map(caseMetrics => (caseMetrics.forbiddenHitRate === 0 ? 1 : 0))),
    forbiddenHitRateAvg: average(forbiddenCases.map(caseMetrics => caseMetrics.forbiddenHitRate as number)),
    fullyRecalledCount: fullyRecalled.length,
    fullyRecalledRate: average(recallCases.map(caseMetrics => (caseMetrics.recallAtK === 1 ? 1 : 0))),
    missedAllCount: missedAll.length,
    recallAtKAvg: average(recallCases.map(caseMetrics => caseMetrics.recallAtK as number)),
  }
}

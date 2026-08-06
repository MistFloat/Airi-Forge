import { describe, expect, it } from 'vitest'

import { evaluateRecallCase, rankRecallCandidates, summarizeRecallEvaluation } from './evaluation'

describe('evaluateRecallCase', () => {
  it('scores a perfect recall run', () => {
    const metrics = evaluateRecallCase(['a', 'b'], ['x'], ['b', 'a', 'other'])
    expect(metrics.recallAtK).toBe(1)
    expect(metrics.forbiddenHitRate).toBe(0)
    expect(metrics.precision).toBe(2 / 3)
    expect(metrics.missedExpectedIds).toEqual([])
    expect(metrics.erroneouslyRecalledIds).toEqual([])
  })

  it('reports missed targets and forbidden leaks', () => {
    const metrics = evaluateRecallCase(['a', 'b'], ['x', 'y'], ['b', 'x'])
    expect(metrics.recallAtK).toBe(0.5)
    expect(metrics.forbiddenHitRate).toBe(0.5)
    expect(metrics.precision).toBe(0.5)
    expect(metrics.missedExpectedIds).toEqual(['a'])
    expect(metrics.erroneouslyRecalledIds).toEqual(['x'])
  })

  it('treats duplicate hits as a single recalled memory', () => {
    const metrics = evaluateRecallCase(['a'], ['x'], ['a', 'a'])
    expect(metrics.hitCount).toBe(1)
    expect(metrics.recallAtK).toBe(1)
  })

  it('returns null denominators instead of inventing zero scores', () => {
    const noTargets = evaluateRecallCase([], [], ['a'])
    expect(noTargets.recallAtK).toBeNull()
    expect(noTargets.forbiddenHitRate).toBeNull()
    const noForbidden = evaluateRecallCase(['a'], [], [])
    expect(noForbidden.forbiddenHitRate).toBeNull()
    expect(noForbidden.precision).toBe(0)
  })
})

describe('summarizeRecallEvaluation', () => {
  it('aggregates averages only over applicable cases', () => {
    const summary = summarizeRecallEvaluation([
      evaluateRecallCase(['a', 'b'], ['x'], ['a', 'b']),
      evaluateRecallCase(['c'], [], []),
      evaluateRecallCase([], ['y'], ['y']),
    ])
    expect(summary.cases).toBe(3)
    expect(summary.recallAtKAvg).toBe(0.5) // (1 + 0) / 2, no-target case excluded
    expect(summary.forbiddenHitRateAvg).toBe(0.5) // (0 + 1) / 2, no-forbidden case excluded
    expect(summary.fullyRecalledCount).toBe(1)
    expect(summary.fullyRecalledRate).toBe(0.5)
    expect(summary.missedAllCount).toBe(1)
    expect(summary.cleanCount).toBe(1)
    expect(summary.cleanRate).toBe(0.5)
  })

  it('handles an empty run', () => {
    const summary = summarizeRecallEvaluation([])
    expect(summary.cases).toBe(0)
    expect(summary.recallAtKAvg).toBeNull()
    expect(summary.forbiddenHitRateAvg).toBeNull()
    expect(summary.fullyRecalledRate).toBeNull()
    expect(summary.cleanRate).toBeNull()
  })
})

describe('rankRecallCandidates', () => {
  it('ranks merged candidates by pure similarity with deterministic ties', () => {
    const rankings = rankRecallCandidates([
      { memoryId: 'b', similarity: 0.9 },
      { memoryId: 'a', similarity: 0.9 },
      { memoryId: 'c', similarity: 0.7 },
    ], [])
    expect(rankings.get('a')).toEqual({ baselineRank: 1 })
    expect(rankings.get('b')).toEqual({ baselineRank: 2 })
    expect(rankings.get('c')).toEqual({ baselineRank: 3 })
  })

  it('attaches final ranks only to injected ids in injection order', () => {
    const rankings = rankRecallCandidates([
      { memoryId: 'a', similarity: 0.8 },
      { memoryId: 'b', similarity: 0.6 },
      { memoryId: 'c', similarity: 0.5 },
    ], ['b', 'a'])
    expect(rankings.get('a')).toEqual({ baselineRank: 1, finalRank: 2 })
    expect(rankings.get('b')).toEqual({ baselineRank: 2, finalRank: 1 })
    expect(rankings.get('c')).toEqual({ baselineRank: 3 })
  })

  it('ignores injected ids that are not recall candidates', () => {
    const rankings = rankRecallCandidates([{ memoryId: 'a', similarity: 0.8 }], ['x'])
    expect(rankings.get('a')).toEqual({ baselineRank: 1 })
    expect(rankings.size).toBe(1)
  })
})

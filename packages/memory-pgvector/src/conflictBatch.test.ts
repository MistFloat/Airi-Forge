import { describe, expect, it } from 'vitest'

import { validateConflictBatch } from './conflictBatch'

describe('conflict batch policy', () => {
  it('requires all six pairs for four memories', () => {
    const result = validateConflictBatch(['a', 'b', 'c', 'd'], [
      { classification: 'compatible', leftId: 'a', rightId: 'b' },
      { classification: 'unrelated', leftId: 'a', rightId: 'c' },
      { classification: 'compatible', leftId: 'a', rightId: 'd' },
      { classification: 'compatible', leftId: 'b', rightId: 'c' },
      { classification: 'unrelated', leftId: 'b', rightId: 'd' },
      { classification: 'compatible', leftId: 'c', rightId: 'd' },
    ])
    expect(result.validatedPairs).toHaveLength(6)
    expect(result.removableIds).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps every memory involved in a conflict, duplicate, or uncertain pair', () => {
    const result = validateConflictBatch(['a', 'b', 'c'], [
      { classification: 'conflict', leftId: 'a', rightId: 'b' },
      { classification: 'compatible', leftId: 'a', rightId: 'c' },
      { classification: 'unrelated', leftId: 'b', rightId: 'c' },
    ])
    expect(result.removableIds).toEqual(['c'])
    expect(result.actionablePairs).toEqual([{ classification: 'conflict', leftId: 'a', rightId: 'b' }])
  })

  it('rejects incomplete, duplicate, and unknown pairs as one invalid batch', () => {
    expect(() => validateConflictBatch(['a', 'b', 'c'], [])).toThrow('exactly 3')
    expect(() => validateConflictBatch(['a', 'b'], [
      { classification: 'compatible', leftId: 'a', rightId: 'unknown' },
    ])).toThrow('unknown')
    expect(() => validateConflictBatch(['a', 'b', 'c'], [
      { classification: 'compatible', leftId: 'a', rightId: 'b' },
      { classification: 'compatible', leftId: 'b', rightId: 'a' },
      { classification: 'compatible', leftId: 'a', rightId: 'c' },
    ])).toThrow('duplicate pair')
  })
})

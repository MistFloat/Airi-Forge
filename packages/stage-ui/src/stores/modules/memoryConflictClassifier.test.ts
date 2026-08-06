import type { MemoryConflictBatchMember } from './memoryConflictClassifier'

import { describe, expect, it } from 'vitest'

import { validateConflictPairs } from './memoryConflictClassifier'

const members: MemoryConflictBatchMember[] = ['a', 'b', 'c', 'd'].map(id => ({
  factKey: null,
  id,
  polarity: 'positive',
  title: id,
  validFrom: null,
  validUntil: null,
  value: id,
}))

describe('memory conflict pair validation', () => {
  it('accepts exactly six unordered pairs for four memories', () => {
    const pairs = validateConflictPairs(members, {
      pairs: [
        { classification: 'compatible', leftId: 'a', rightId: 'b' },
        { classification: 'unrelated', leftId: 'a', rightId: 'c' },
        { classification: 'uncertain', leftId: 'a', rightId: 'd' },
        { classification: 'duplicate', leftId: 'b', rightId: 'c' },
        { classification: 'conflict', leftId: 'b', rightId: 'd' },
        { classification: 'compatible', leftId: 'c', rightId: 'd' },
      ],
    })
    expect(pairs).toHaveLength(6)
    expect(pairs[0]).toEqual({ classification: 'compatible', leftId: 'a', rightId: 'b' })
  })

  it('rejects a missing pair', () => {
    expect(() => validateConflictPairs(members, { pairs: [] })).toThrow('exactly 6')
  })

  it('rejects duplicate and unknown IDs', () => {
    const duplicated = Array.from({ length: 6 }, () => ({ classification: 'compatible', leftId: 'a', rightId: 'b' }))
    expect(() => validateConflictPairs(members, { pairs: duplicated })).toThrow('duplicate pair')
    expect(() => validateConflictPairs(members, {
      pairs: [
        { classification: 'compatible', leftId: 'a', rightId: 'unknown' },
      ],
    })).toThrow('unknown')
  })
})

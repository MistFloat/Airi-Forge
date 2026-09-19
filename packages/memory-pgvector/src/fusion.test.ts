import { describe, expect, it } from 'vitest'

import { reciprocalRankFusion, RRF_K } from './fusion'

describe('reciprocalRankFusion', () => {
  it('sums 1/(k+rank) contributions across every list an id appears in', () => {
    const scores = reciprocalRankFusion([
      ['a', 'b'],
      ['b', 'a'],
    ])
    expect(scores.get('a')).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2))
    expect(scores.get('b')).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1))
  })

  it('rewards an id present in more lists over a single-list peer', () => {
    const scores = reciprocalRankFusion([
      ['shared'],
      ['shared', 'solo'],
    ])
    expect(scores.get('shared')!).toBeGreaterThan(scores.get('solo')!)
  })

  it('uses the 1-based position inside each list', () => {
    const scores = reciprocalRankFusion([['first', 'second']])
    expect(scores.get('first')).toBeCloseTo(1 / (RRF_K + 1))
    expect(scores.get('second')).toBeCloseTo(1 / (RRF_K + 2))
  })

  it('omits ids absent from every list', () => {
    const scores = reciprocalRankFusion([['a']])
    expect(scores.has('missing')).toBe(false)
  })

  it('honours a custom smoothing constant', () => {
    const scores = reciprocalRankFusion([['a']], 10)
    expect(scores.get('a')).toBeCloseTo(1 / 11)
  })

  it('returns an empty map for no lists', () => {
    expect(reciprocalRankFusion([]).size).toBe(0)
  })
})

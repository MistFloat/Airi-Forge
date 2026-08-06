import { describe, expect, it } from 'vitest'

import { areValidityIntervalsDisjoint, embeddingJobKey, supportWeight } from './policy'

describe('long-term memory deterministic policy', () => {
  it('treats validity ranges as half-open intervals', () => {
    expect(areValidityIntervalsDisjoint(
      { validFrom: '2025-01-01T00:00:00Z', validUntil: '2026-01-01T00:00:00Z' },
      { validFrom: '2026-01-01T00:00:00Z', validUntil: '2027-01-01T00:00:00Z' },
    )).toBe(true)
  })

  it('does not invent an ordering when a required time bound is unknown', () => {
    expect(areValidityIntervalsDisjoint(
      { validFrom: null, validUntil: null },
      { validFrom: '2026-01-01T00:00:00Z', validUntil: null },
    )).toBe(false)
  })

  it('assigns source support without treating assistant output as evidence', () => {
    expect(supportWeight('user_assertion', 'explicit')).toBe(0.85)
    expect(supportWeight('user_assertion', 'implicit')).toBe(0.45)
    expect(supportWeight('assistant_inference', 'explicit')).toBe(0)
  })

  it('keeps embedding work idempotent per memory revision and schema', () => {
    expect(embeddingJobKey('memory-a', 'schema-a', 3)).toBe('embedding:memory-a:schema-a:3')
  })
})

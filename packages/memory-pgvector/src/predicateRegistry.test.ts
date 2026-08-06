import { describe, expect, it } from 'vitest'

import { cardinalityFor, conflictSeverityFor, implicitPromotionFor, importancePolicyFor, normalizeFactIdentity, normalizeValueFor, sensitivityFor } from './predicateRegistry'

describe('predicate registry', () => {
  it('normalizes aliases before constructing a stable fact key', () => {
    expect(normalizeFactIdentity({ predicate: '住在', scope: ' Global ', subject: ' User ' })).toEqual({
      cardinality: 'temporal_single',
      factKey: 'user/residence_city/global',
      predicate: 'residence_city',
      scope: 'global',
      subject: 'user',
    })
  })

  it('keeps set-valued preferences separate from single-valued facts', () => {
    expect(cardinalityFor('favorite_music')).toBe('set')
    expect(cardinalityFor('display_name')).toBe('single')
  })

  it('does not guess the cardinality of an unregistered predicate', () => {
    expect(cardinalityFor('uses_local_storage_device')).toBe('unknown')
    expect(normalizeFactIdentity({ predicate: 'uses_local_storage_device', scope: 'global', subject: 'user' }).cardinality).toBe('unknown')
  })

  it('registers uses_service as a set so service adoption claims can promote', () => {
    expect(normalizeFactIdentity({ predicate: 'uses_service', scope: 'global', subject: 'user' })).toMatchObject({
      cardinality: 'set',
      factKey: 'user/uses_service/global',
      predicate: 'uses_service',
    })
    expect(cardinalityFor('uses_service')).toBe('set')
  })

  it('allows implicit promotion only for the registry allow-list, keyed on the normalized predicate', () => {
    // alias input that the registry normalizes must still hit the allow-list
    expect(implicitPromotionFor('favorite_music')).toBe(true)
    expect(implicitPromotionFor('preferred_language')).toBe(true)
    expect(implicitPromotionFor('uses_service')).toBe(false)
    expect(implicitPromotionFor('residence_city')).toBe(false)
  })

  it('normalizes predicate values before they are stored', () => {
    // 上海市 and 上海 must collapse to one value so conflict tracks stay aligned
    expect(normalizeValueFor('residence_city', '上海市')).toBe('上海')
    expect(normalizeValueFor('residence_city', ' 广东省 ')).toBe('广东')
    // unregistered predicates keep a plain trim
    expect(normalizeValueFor('uses_local_storage_device', ' 上海 ')).toBe('上海')
  })

  it('returns fixed importance bounds and conflict severity from code policy only', () => {
    expect(importancePolicyFor('display_name')).toMatchObject({ conflictSeverity: 'important', min: 0.7 })
    expect(importancePolicyFor('favorite_music')).toMatchObject({ conflictSeverity: 'normal', max: 0.5 })
    expect(importancePolicyFor('residence_city')).toMatchObject({ conflictSeverity: 'important', min: 0.6 })
    // no policy -> worker must not guess a severity
    expect(importancePolicyFor('uses_local_storage_device')).toEqual({})
    expect(conflictSeverityFor('uses_local_storage_device')).toBeNull()
  })

  it('marks sensitive predicates so the auto path can quarantine them', () => {
    expect(sensitivityFor('residence_city')).toBe('sensitive')
    expect(sensitivityFor('display_name')).toBe('personal')
    expect(sensitivityFor('favorite_music')).toBe('public')
    expect(sensitivityFor('uses_local_storage_device')).toBe('public')
  })
})

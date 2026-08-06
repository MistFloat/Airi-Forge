import { describe, expect, it } from 'vitest'

import { planMemoryRecallQuery } from './recallQuery'

describe('memory recall query planning', () => {
  it('extracts the real music intent from a natural MCP question', () => {
    const query = planMemoryRecallQuery('在示例 MCP 里，用户平时使用什么音乐软件，哪些不用？')
    expect(query.terms.length).toBeLessThanOrEqual(4)
    expect(query.terms.some(term => term === '音乐' || term === '音乐软件')).toBe(true)
    expect(query.terms).not.toContain('软件')
  })

  it('preserves mixed-language brands and object-bound negation', () => {
    const query = planMemoryRecallQuery('我不使用 Spotify，但主要使用 Apple Music。')
    expect(query.terms).toContain('不使用 Spotify')
    expect(query.terms).toContain('Apple Music')
    expect(query.terms).not.toContain('使用 Spotify')
  })

  it('keeps Chinese product names and NAS intact', () => {
    expect(planMemoryRecallQuery('我平常是否会用 NAS 存储？').terms).toContain('NAS')
    expect(planMemoryRecallQuery('网易云音乐适合我吗？').terms).toContain('网易云音乐')
  })

  it('falls back to the original text when no meaningful term exists', () => {
    expect(planMemoryRecallQuery('为什么？')).toEqual({ originalText: '为什么？', terms: ['为什么？'] })
  })
})

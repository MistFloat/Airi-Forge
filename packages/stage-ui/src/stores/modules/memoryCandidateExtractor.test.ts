import { describe, expect, it } from 'vitest'

import { containsSensitiveSecret, correctionIdentifiesMemory, MEMORY_CANDIDATE_SYSTEM_PROMPT } from './memoryCandidateExtractor'

describe('memory extraction privacy policy', () => {
  it('blocks credentials before an extraction request', () => {
    expect(containsSensitiveSecret('api_key = sk_test_123456789012345')).toBe(true)
    expect(containsSensitiveSecret('password: correct-horse-battery-staple')).toBe(true)
  })

  it('allows ordinary durable profile statements', () => {
    expect(containsSensitiveSecret('我现在住在上海，并且喜欢爵士乐。')).toBe(false)
  })

  it('requires self-contained values and rejects transient project decisions', () => {
    expect(MEMORY_CANDIDATE_SYSTEM_PROMPT).toContain('value must be a complete statement')
    expect(MEMORY_CANDIDATE_SYSTEM_PROMPT).toContain('current project design decision')
    expect(MEMORY_CANDIDATE_SYSTEM_PROMPT).toContain('Never turn a negative statement into a positive one')
  })

  it('rejects generic corrections and accepts a uniquely identified memory value', () => {
    const memories = [{ content: '居住城市：上海' }, { content: '喜欢的音乐：爵士乐' }]
    expect(correctionIdentifiesMemory('你记错了', memories[0]!, memories)).toBe(false)
    expect(correctionIdentifiesMemory('我已经不住上海了', memories[0]!, memories)).toBe(true)
  })
})

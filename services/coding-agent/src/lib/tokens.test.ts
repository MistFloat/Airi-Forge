import { describe, expect, it } from 'vitest'

import { estimateTokens } from './tokens'

describe('estimateTokens', () => {
  it('returns 1 token for empty text', () => {
    const result = estimateTokens('')
    expect(result.tokens).toBe(1)
    expect(result.chars).toBe(0)
  })

  it('estimates ~3.5 chars per token for code paths', () => {
    const result = estimateTokens('function foo() { return 1 }', 'src/foo.ts')
    expect(result.kind).toBe('code')
    expect(result.charsPerToken).toBe(3.5)
    expect(result.tokens).toBe(Math.ceil(result.chars / 3.5))
  })

  it('estimates ~4.0 chars per token for prose paths', () => {
    const result = estimateTokens('This is a long sentence about cats and dogs.', 'README.md')
    expect(result.kind).toBe('prose')
    expect(result.charsPerToken).toBe(4.0)
  })

  it('uses mixed ratio when path is unknown', () => {
    const result = estimateTokens('some text here', 'unknown')
    expect(result.kind).toBe('mixed')
    expect(result.charsPerToken).toBe(3.7)
  })

  it('classifies by content when no path is given', () => {
    const codeLike = estimateTokens('if (a) { b(); } else { c(); }')
    expect(codeLike.kind).toBe('code')

    const proseLike = estimateTokens('The quick brown fox jumps over the lazy dog and runs away.')
    expect(proseLike.kind).toBe('prose')
  })

  it('handles unicode without crashing', () => {
    const result = estimateTokens('你好世界 🌍 Привет')
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.chars).toBeGreaterThan(0)
  })
})

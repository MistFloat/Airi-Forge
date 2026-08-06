import { describe, expect, it } from 'vitest'

import { findSimilarLines, replaceExact } from './edit'

describe('replaceExact — perfect match (step 1)', () => {
  it('replaces an exact line-aligned block', () => {
    const result = replaceExact('a\nb\nc\n', 'b\n', 'B\n')
    expect(result).toEqual({ content: 'a\nB\nc\n', mode: 'replaced', ok: true })
  })

  it('matches when the search block omits the trailing newline', () => {
    const result = replaceExact('a\nb\nc\n', 'b', 'B')
    expect(result).toMatchObject({ content: 'a\nB\nc\n', ok: true })
  })

  it('matches at the end of a file without a trailing newline', () => {
    const result = replaceExact('a\nb', 'b', 'B')
    expect(result).toMatchObject({ content: 'a\nB', ok: true })
  })

  it('reports multiple matches as a failure', () => {
    const result = replaceExact('x\ny\nx\n', 'x\n', 'z\n')
    expect(result).toMatchObject({ matches: 2, ok: false, reason: 'multiple-match' })
  })

  it('deletes the matched region when replace is empty', () => {
    const result = replaceExact('a\nb\nc\n', 'b\n', '')
    expect(result).toEqual({ content: 'a\nc\n', mode: 'replaced', ok: true })
  })

  it('replaces a multi-line block', () => {
    const result = replaceExact('a\nb\nc\nd\n', 'b\nc\n', 'B\nC\n')
    expect(result).toEqual({ content: 'a\nB\nC\nd\n', mode: 'replaced', ok: true })
  })

  it('handles CRLF files by normalizing line endings', () => {
    const result = replaceExact('a\r\nb\r\nc\r\n', 'b\r\n', 'B\r\n')
    expect(result).toEqual({ content: 'a\nB\nc\n', mode: 'replaced', ok: true })
  })

  it('preserves a file that ends without a trailing newline', () => {
    const result = replaceExact('a\nb', 'a\n', 'A\n')
    expect(result).toMatchObject({ content: 'A\nb', ok: true })
  })

  it('does not match a partial line (no substring matching)', () => {
    const result = replaceExact('return trueValue\n', 'return true\n', 'x\n')
    expect(result).toMatchObject({ ok: false, reason: 'no-match' })
  })
})

describe('replaceExact — missing leading whitespace (step 2)', () => {
  it('matches when the search block drops the leading indentation', () => {
    // File is indented; SEARCH block forgot the leading spaces.
    const content = 'function foo() {\n  return 1\n  return 2\n}\n'
    const search = 'return 1\nreturn 2\n'
    const result = replaceExact(content, search, 'return 1\nreturn 2\nreturn 3\n')
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.mode).toBe('replaced-no-leading-ws')
  })
})

describe('replaceExact — skip blank leading line (step 3)', () => {
  it('drops a stray blank leading line the model inserted', () => {
    const content = 'function foo() {\n  return 1\n}\n'
    // SEARCH block starts with a blank line that does not exist in the file.
    const search = '\nfunction foo() {\n  return 1\n}\n'
    const result = replaceExact(content, search, 'replaced\n')
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.mode).toBe('replaced-skip-blank')
  })
})

describe('replaceExact — dotdotdots elision (step 4)', () => {
  it('matches with `...` matching any number of skipped lines', () => {
    const content = [
      'function foo() {',
      '  const a = 1',
      '  const b = 2',
      '  const c = 3',
      '  return a + b + c',
      '}',
      '',
    ].join('\n')
    const search = [
      'function foo() {',
      '...',
      '  return a + b + c',
      '}',
      '',
    ].join('\n')
    const replace = [
      'function foo() {',
      '  const a = 1',
      '  const b = 2',
      '  const c = 3',
      '  return a + b + c + d',
      '}',
      '',
    ].join('\n')
    const result = replaceExact(content, search, replace)
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.mode).toBe('replaced-dotdotdots')
  })

  it('matches `...` skipping zero lines (consecutive literal anchors)', () => {
    const content = 'a\nb\nc\n'
    const search = 'a\n...\nb\nc\n'
    const result = replaceExact(content, search, 'A\nB\nC\n')
    expect(result.ok).toBe(true)
  })

  it('rejects a `...` search that does not align with the content', () => {
    const content = 'function foo() {\n  return 1\n}\n'
    const search = 'function bar() {\n...\n  return 1\n}\n'
    const result = replaceExact(content, search, 'x\n')
    expect(result.ok).toBe(false)
  })
})

describe('replaceExact — fuzzy fallback (step 5)', () => {
  it('accepts a close-but-not-exact match when similarity >= 0.9', () => {
    // Trailing whitespace difference only — high similarity.
    const content = 'function foo() {\n  return 1\n}\n'
    const search = 'function foo() {\n  return 1 \n}\n' // extra trailing space
    const result = replaceExact(content, search, 'replaced\n')
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.mode).toBe('replaced-closest')
  })

  it('rejects a low-similarity search with a suggestion', () => {
    // Different identifier (`bar` vs `foo`) produces a whole-chunk LCS ratio
    // around 0.9 — close, but below the 0.95 fuzzy threshold, so we report
    // no-match and surface the closest actual region as a "did you mean" hint.
    const result = replaceExact('function foo() {\n  return 1\n}\n', 'function bar() {\n  return 1\n}\n', 'x\n')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no-match')
      expect(result.suggestion).toContain('function foo()')
    }
  })

  it('returns no suggestion when nothing is similar', () => {
    const result = replaceExact('alpha\nbeta\n', 'zzz qqq www\n', 'x\n')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('no-match')
      expect(result.suggestion).toBeUndefined()
    }
  })
})

describe('findSimilarLines', () => {
  it('returns the matching chunk when first/last lines match exactly', () => {
    const content = 'aaa\nfunction foo() {\n  return 1\n}\nbbb\n'
    const suggestion = findSimilarLines('function foo() {\n  return 2\n}\n', content)
    expect(suggestion).toBe('function foo() {\n  return 1\n}\n')
  })

  it('widens the window with context when edges differ', () => {
    const content = 'aaa\nfunction foo() {\n  return 1\n}\nbbb\n'
    const suggestion = findSimilarLines('function foo() {\n  return 2\n', content)
    expect(suggestion).toContain('function foo()')
  })

  it('returns undefined below the threshold', () => {
    const suggestion = findSimilarLines('completely different lines here\n', 'aaa\nbbb\nccc\n')
    expect(suggestion).toBeUndefined()
  })
})

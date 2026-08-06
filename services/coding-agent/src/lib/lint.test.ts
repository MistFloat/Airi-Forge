import { describe, expect, it } from 'vitest'

import { lintContent } from './lint'

describe('lintContent — bracket balance', () => {
  it('reports no issues for clean code', () => {
    const issues = lintContent('function foo() {\n  return 1\n}\n', 'typescript')
    expect(issues).toEqual([])
  })

  it('flags an unclosed brace', () => {
    const issues = lintContent('function foo() {\n  return 1\n', 'typescript')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      line: 1,
      rule: 'unclosed-bracket',
      severity: 'error',
    })
  })

  it('flags a closing bracket without an opener', () => {
    const issues = lintContent('}\n', 'typescript')
    expect(issues).toHaveLength(1)
    expect(issues[0].rule).toBe('unbalanced-brackets')
  })

  it('ignores brackets inside line comments', () => {
    const issues = lintContent('// function foo() {\nconst x = 1\n', 'typescript')
    expect(issues).toEqual([])
  })

  it('ignores brackets inside block comments', () => {
    const issues = lintContent('/* (not real) */\nconst x = 1\n', 'typescript')
    expect(issues).toEqual([])
  })

  it('ignores brackets inside string literals', () => {
    const issues = lintContent('const s = "function foo() { not real }"\n', 'typescript')
    expect(issues).toEqual([])
  })

  it('handles Python comments with `#`', () => {
    const issues = lintContent('def foo():\n  # this (has brackets)\n  return 1\n', 'python')
    expect(issues).toEqual([])
  })

  it('sorts issues by line then column', () => {
    const issues = lintContent('} {\n]\n', 'typescript')
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0].line).toBe(1)
  })
})

describe('lintContent — multi-line balance', () => {
  it('tracks balance across nested multi-line blocks', () => {
    const code = [
      'function foo() {',
      '  if (true) {',
      '    return [1, 2, 3]',
      '  }',
      '}',
      '',
    ].join('\n')
    expect(lintContent(code, 'typescript')).toEqual([])
  })

  it('flags a missing closing brace in a multi-line function', () => {
    const code = [
      'function foo() {',
      '  if (true) {',
      '    return 1',
      '  }',
      // missing outer closing brace
    ].join('\n')
    const issues = lintContent(code, 'typescript')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ line: 1, rule: 'unclosed-bracket' })
  })
})

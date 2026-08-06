import { describe, expect, it } from 'vitest'

import { isIgnored, parseGitignore } from './gitignore'

describe('parseGitignore', () => {
  it('skips blank lines and comments', () => {
    const rules = parseGitignore('# comment\n\nnode_modules/\n')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ dirOnly: true, negated: false, source: 'node_modules/' })
  })

  it('parses negation', () => {
    const rules = parseGitignore('*.log\n!keep.log\n')
    expect(rules.map(r => r.negated)).toEqual([false, true])
  })
})

describe('isIgnored', () => {
  it('matches a basename pattern at any depth', () => {
    const rules = parseGitignore('node_modules/\n')
    expect(isIgnored('node_modules', true, rules)).toBe(true)
    expect(isIgnored('apps/x/node_modules', true, rules)).toBe(true)
    expect(isIgnored('node_modules', false, rules)).toBe(false)
  })

  it('matches glob patterns', () => {
    const rules = parseGitignore('*.log\n')
    expect(isIgnored('debug.log', false, rules)).toBe(true)
    expect(isIgnored('src/a.log', false, rules)).toBe(true)
    expect(isIgnored('src/a.ts', false, rules)).toBe(false)
  })

  it('respects root-anchored patterns', () => {
    const rules = parseGitignore('/dist\n')
    expect(isIgnored('dist', true, rules)).toBe(true)
    expect(isIgnored('packages/x/dist', true, rules)).toBe(false)
  })

  it('lets the last matching rule win (negation)', () => {
    const rules = parseGitignore('*.log\n!keep.log\n')
    expect(isIgnored('keep.log', false, rules)).toBe(false)
    expect(isIgnored('other.log', false, rules)).toBe(true)
  })

  it('matches path patterns', () => {
    const rules = parseGitignore('build/output\n')
    expect(isIgnored('build/output', false, rules)).toBe(true)
    expect(isIgnored('build', true, rules)).toBe(false)
  })

  it('matches directories so contents are skipped by the walker', () => {
    const rules = parseGitignore('node_modules/\n')
    expect(isIgnored('node_modules/pkg/index.js', false, rules)).toBe(true)
  })
})

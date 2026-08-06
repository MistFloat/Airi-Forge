import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { findFiles, searchCode } from './search'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-search-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'function foo() {\n  return 1\n}\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'function bar() {\n  return 2\n}\n')
  writeFileSync(join(root, 'README.md'), '# Project\n\nDoes things.\n')
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('searchCode — JS fallback (or rg when available)', () => {
  it('finds matches in files', async () => {
    const result = await searchCode({
      caseSensitive: true,
      pattern: 'function',
    }, createWorkdir(root))
    expect(result.matches.length).toBeGreaterThanOrEqual(2)
    expect(result.matches.some(m => m.path === 'src/a.ts')).toBe(true)
    expect(result.matches.some(m => m.path === 'src/b.ts')).toBe(true)
    expect(result.filesScanned).toBeGreaterThan(0)
  })

  it('includes context lines when contextLines > 0', async () => {
    const result = await searchCode({
      contextLines: 1,
      pattern: 'return 1',
    }, createWorkdir(root))
    expect(result.matches.length).toBe(1)
    const match = result.matches[0]
    expect(match.before).toEqual(['function foo() {'])
    expect(match.text).toBe('  return 1')
    expect(match.after).toEqual(['}'])
  })

  it('respects case-insensitive default', async () => {
    const result = await searchCode({
      pattern: 'FUNCTION',
    }, createWorkdir(root))
    expect(result.matches.length).toBeGreaterThanOrEqual(2)
  })

  it('restricts to a subdirectory via path', async () => {
    const result = await searchCode({
      path: 'src',
      pattern: 'function',
    }, createWorkdir(root))
    expect(result.matches.length).toBe(2)
    expect(result.matches.every(m => m.path.startsWith('src/'))).toBe(true)
  })

  it('returns no matches when the pattern is absent', async () => {
    const result = await searchCode({
      pattern: 'this_string_does_not_exist_anywhere',
    }, createWorkdir(root))
    expect(result.matches).toEqual([])
    // rg only emits `begin` records for files that contain matches, so
    // `filesScanned` is 0 in rg mode when nothing matches. The JS fallback
    // walks every file and reports the true count. Both are correct for
    // their engine — we just assert non-negativity here.
    expect(result.filesScanned).toBeGreaterThanOrEqual(0)
    expect(['rg', 'js']).toContain(result.engine)
  })

  it('honors maxMatches and sets truncated flag', async () => {
    const result = await searchCode({
      maxMatches: 1,
      pattern: 'function',
    }, createWorkdir(root))
    expect(result.matches.length).toBe(1)
    expect(result.truncated).toBe(true)
  })

  it('supports regex patterns', async () => {
    const result = await searchCode({
      pattern: 'function (foo|bar)',
      regex: true,
    }, createWorkdir(root))
    expect(result.matches.length).toBe(2)
  })
})

describe('findFiles — JS fallback (or rg when available)', () => {
  it('lists files in the workdir', async () => {
    const result = await findFiles({}, createWorkdir(root))
    expect(result.files).toContain('src/a.ts')
    expect(result.files).toContain('src/b.ts')
    expect(result.files).toContain('README.md')
  })

  it('restricts by extension', async () => {
    const result = await findFiles({ extensions: ['ts'] }, createWorkdir(root))
    expect(result.files).toContain('src/a.ts')
    expect(result.files).not.toContain('README.md')
  })

  it('filters by pattern', async () => {
    const result = await findFiles({ pattern: 'a.ts' }, createWorkdir(root))
    expect(result.files).toContain('src/a.ts')
    expect(result.files).not.toContain('src/b.ts')
  })

  it('respects maxResults and sets truncated', async () => {
    const result = await findFiles({ maxResults: 1 }, createWorkdir(root))
    expect(result.files.length).toBe(1)
    expect(result.truncated).toBe(true)
  })
})

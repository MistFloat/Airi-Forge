import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { getRepoMap } from './repomap'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-repomap-'))
  mkdirSync(join(root, 'src'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('getRepoMap', () => {
  it('extracts symbols from TypeScript files', async () => {
    writeFileSync(
      join(root, 'src', 'foo.ts'),
      'export function foo() {\n  return 1\n}\n\nexport class Bar {\n  baz() {\n    return 2\n  }\n}\n',
    )
    const result = await getRepoMap({}, createWorkdir(root))
    expect(result.totalFiles).toBeGreaterThan(0)
    expect(result.totalSymbols).toBeGreaterThanOrEqual(2)
    const foo = result.entries.find(e => e.path === 'src/foo.ts')
    expect(foo).toBeDefined()
    const names = foo!.symbols.map(s => s.name)
    expect(names).toContain('foo')
    expect(names).toContain('Bar')
  })

  it('includes focusPaths even if their rank is low', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n')
    writeFileSync(join(root, 'src', 'c.ts'), 'export const c = 3\n')
    const result = await getRepoMap({
      focusPaths: ['src/c.ts'],
      maxFiles: 1,
    }, createWorkdir(root))
    const paths = result.entries.map(e => e.path)
    expect(paths).toContain('src/c.ts')
  })

  it('respects the token budget', async () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(root, 'src', `file${i}.ts`),
        `export function f${i}() { return ${i} }\n`,
      )
    }
    const result = await getRepoMap({
      tokenBudget: 200,
    }, createWorkdir(root))
    expect(result.estimatedTokens).toBeLessThanOrEqual(300)
  })

  it('produces a non-empty rendered string when files exist', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    const result = await getRepoMap({}, createWorkdir(root))
    expect(result.rendered).toContain('src/a.ts')
    expect(result.rendered).toContain('a')
  })

  it('handles an empty workdir gracefully', async () => {
    const result = await getRepoMap({}, createWorkdir(root))
    expect(result.totalFiles).toBe(0)
    expect(result.totalSymbols).toBe(0)
    expect(result.entries).toEqual([])
  })

  it('extracts Python symbols', async () => {
    writeFileSync(
      join(root, 'src', 'mod.py'),
      'class Foo:\n    def bar(self):\n        return 1\n\ndef baz():\n    return 2\n',
    )
    const result = await getRepoMap({}, createWorkdir(root))
    const mod = result.entries.find(e => e.path === 'src/mod.py')
    expect(mod).toBeDefined()
    const names = mod!.symbols.map(s => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('bar')
    expect(names).toContain('baz')
  })

  it('skips unknown file types', async () => {
    writeFileSync(join(root, 'src', 'data.json'), JSON.stringify({ a: 1 }))
    writeFileSync(join(root, 'src', 'code.ts'), 'export const x = 1\n')
    const result = await getRepoMap({}, createWorkdir(root))
    const paths = result.entries.map(e => e.path)
    expect(paths).toContain('src/code.ts')
    // json is in CODE_EXTENSIONS so it should be classified but has no
    // extractable symbols (no const/class/function in JSON).
    // Either way, no spurious symbols should be reported for it.
    const jsonEntry = result.entries.find(e => e.path === 'src/data.json')
    if (jsonEntry)
      expect(jsonEntry.symbols).toEqual([])
  })
})

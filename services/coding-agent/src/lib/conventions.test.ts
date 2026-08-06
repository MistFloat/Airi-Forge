import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { CONVENTIONS_FILES, readAllConventions, readConventionsFile, readDefaultConventions, readPackageJsonScripts } from './conventions'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-conventions-'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('readConventionsFile', () => {
  it('reads an existing conventions file', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# Agent guide\n')
    const result = await readConventionsFile('AGENTS.md', createWorkdir(root))
    expect(result.path).toBe('AGENTS.md')
    expect(result.content).toBe('# Agent guide\n')
    expect(result.size).toBeGreaterThan(0)
  })

  it('rejects paths outside the workdir', async () => {
    await expect(readConventionsFile('../escape.md', createWorkdir(root))).rejects.toThrow('outside the workdir')
  })

  it('throws when the file does not exist', async () => {
    await expect(readConventionsFile('MISSING.md', createWorkdir(root))).rejects.toThrow()
  })
})

describe('readDefaultConventions', () => {
  it('returns the first available conventions file in priority order', async () => {
    writeFileSync(join(root, 'CONVENTIONS.md'), '# conventions\n')
    const result = await readDefaultConventions(createWorkdir(root))
    expect(result?.path).toBe('CONVENTIONS.md')
  })

  it('returns AGENTS.md before CONVENTIONS.md', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n')
    writeFileSync(join(root, 'CONVENTIONS.md'), '# conventions\n')
    const result = await readDefaultConventions(createWorkdir(root))
    expect(result?.path).toBe('AGENTS.md')
  })

  it('returns null when no conventions file exists', async () => {
    const result = await readDefaultConventions(createWorkdir(root))
    expect(result).toBeNull()
  })
})

describe('readAllConventions', () => {
  it('returns all available conventions files', async () => {
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n')
    writeFileSync(join(root, '.editorconfig'), 'root = true\n')
    const results = await readAllConventions(createWorkdir(root))
    const paths = results.map(r => r.path).sort()
    expect(paths).toEqual(['.editorconfig', 'AGENTS.md'])
  })

  it('returns empty array when none exist', async () => {
    const results = await readAllConventions(createWorkdir(root))
    expect(results).toEqual([])
  })
})

describe('readPackageJsonScripts', () => {
  it('returns scripts from package.json', async () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint', test: 'vitest' } }),
    )
    const scripts = await readPackageJsonScripts(createWorkdir(root))
    expect(scripts).toEqual({ lint: 'eslint', test: 'vitest' })
  })

  it('returns empty object when package.json has no scripts', async () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'foo' }))
    const scripts = await readPackageJsonScripts(createWorkdir(root))
    expect(scripts).toEqual({})
  })

  it('returns empty object when package.json is missing', async () => {
    const scripts = await readPackageJsonScripts(createWorkdir(root))
    expect(scripts).toEqual({})
  })
})

describe('cONVENTIONS_FILES', () => {
  it('includes AGENTS.md and .cursorrules', () => {
    expect(CONVENTIONS_FILES).toContain('AGENTS.md')
    expect(CONVENTIONS_FILES).toContain('.cursorrules')
    expect(CONVENTIONS_FILES).toContain('.editorconfig')
  })
})

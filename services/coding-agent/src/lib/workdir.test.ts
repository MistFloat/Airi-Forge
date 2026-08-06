import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir, resolveInWorkdir } from './workdir'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-workdir-'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('resolveInWorkdir', () => {
  it('resolves a relative path against the root', () => {
    const result = resolveInWorkdir(createWorkdir(root), 'src/index.ts')
    expect(result).toMatchObject({ ok: true, rel: 'src/index.ts' })
    if (result.ok)
      expect(result.absolute).toBe(join(root, 'src', 'index.ts'))
  })

  it('resolves the root itself', () => {
    const result = resolveInWorkdir(createWorkdir(root), '.')
    expect(result).toMatchObject({ ok: true, rel: '' })
  })

  it('resolves an absolute path inside the root', () => {
    const target = join(root, 'packages', 'x')
    const result = resolveInWorkdir(createWorkdir(root), target)
    expect(result).toMatchObject({ ok: true, rel: 'packages/x' })
  })

  it('rejects an escape via parent traversal', () => {
    const result = resolveInWorkdir(createWorkdir(root), '../outside.txt')
    expect(result).toEqual({
      ok: false,
      reason: 'outside-workdir',
      requested: '../outside.txt',
    })
  })

  it('rejects a nested escape', () => {
    const result = resolveInWorkdir(createWorkdir(root), 'src/../../outside.txt')
    expect(result).toMatchObject({ ok: false, reason: 'outside-workdir' })
  })

  it('rejects an absolute path outside the root', () => {
    const result = resolveInWorkdir(createWorkdir(root), join(tmpdir(), 'other', 'f.txt'))
    expect(result).toMatchObject({ ok: false, reason: 'outside-workdir' })
  })

  it('rejects a sibling directory with a shared prefix', () => {
    // root is <tmp>/coding-agent-workdir-xxx; a sibling named with the same prefix
    // must not be treated as inside the root.
    const sibling = `${root}-sibling`
    const result = resolveInWorkdir(createWorkdir(root), sibling)
    expect(result).toMatchObject({ ok: false, reason: 'outside-workdir' })
  })
})

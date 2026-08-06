import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { applyDiffTool, deleteFileTool, writeFileTool } from './write'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-write-'))
  writeFileSync(join(root, 'a.ts'), 'one\ntwo\nthree\n')
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('apply_diff', () => {
  it('replaces an exact block', async () => {
    const result = await applyDiffTool(
      { blocks: [{ path: 'a.ts', replace: 'TWO\n', search: 'two\n' }] },
      { workdir: createWorkdir(root) },
    )
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ applied: [{ path: 'a.ts', status: 'replaced' }] })
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('one\nTWO\nthree\n')
  })

  it('creates a new file when search is empty and the file is missing', async () => {
    const result = await applyDiffTool(
      { blocks: [{ path: 'new.md', replace: '# new\n', search: '' }] },
      { workdir: createWorkdir(root) },
    )
    expect(result.structuredContent).toEqual({ applied: [{ path: 'new.md', status: 'created' }] })
    expect(readFileSync(join(root, 'new.md'), 'utf8')).toBe('# new\n')
  })

  it('appends to an existing file when search is empty', async () => {
    const result = await applyDiffTool(
      { blocks: [{ path: 'a.ts', replace: 'four\n', search: '' }] },
      { workdir: createWorkdir(root) },
    )
    expect(result.structuredContent).toEqual({ applied: [{ path: 'a.ts', status: 'appended' }] })
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\nfour\n')
  })

  it('is atomic: a failing block prevents all writes', async () => {
    const result = await applyDiffTool(
      {
        blocks: [
          { path: 'a.ts', replace: 'TWO\n', search: 'two\n' },
          { path: 'a.ts', replace: 'X\n', search: 'no such line\n' },
        ],
      },
      { workdir: createWorkdir(root) },
    )
    expect(result.isError).toBe(true)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(result.structuredContent?.failed).toMatchObject([
      { path: 'a.ts', reason: 'no-match' },
    ])
  })

  it('reports multiple matches as a failure', async () => {
    writeFileSync(join(root, 'dup.ts'), 'x\ny\nx\n')
    const result = await applyDiffTool(
      { blocks: [{ path: 'dup.ts', replace: 'z\n', search: 'x\n' }] },
      { workdir: createWorkdir(root) },
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.failed).toMatchObject([
      { matches: 2, path: 'dup.ts', reason: 'multiple-match' },
    ])
  })

  it('rejects a path outside the workdir as file-missing', async () => {
    const result = await applyDiffTool(
      { blocks: [{ path: '../escape.ts', replace: 'x', search: '' }] },
      { workdir: createWorkdir(root) },
    )
    expect(result.isError).toBe(true)
    expect(result.structuredContent?.failed).toMatchObject([{ path: '../escape.ts', reason: 'file-missing' }])
    expect(root).not.toContain('escape')
  })

  it('applies multiple blocks to the same file sequentially', async () => {
    const result = await applyDiffTool(
      {
        blocks: [
          { path: 'a.ts', replace: 'ONE\n', search: 'one\n' },
          { path: 'a.ts', replace: 'THREE\n', search: 'three\n' },
        ],
      },
      { workdir: createWorkdir(root) },
    )
    expect(result.isError).toBeUndefined()
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('ONE\ntwo\nTHREE\n')
  })
})

describe('write_file', () => {
  it('creates a file with missing parent directories', async () => {
    const result = await writeFileTool(
      { content: 'deep content\n', path: 'nested/dir/file.txt' },
      { workdir: createWorkdir(root) },
    )
    expect(result.structuredContent).toEqual({ path: 'nested/dir/file.txt', status: 'written' })
    expect(readFileSync(join(root, 'nested', 'dir', 'file.txt'), 'utf8')).toBe('deep content\n')
  })

  it('overwrites an existing file', async () => {
    await writeFileTool({ content: 'v1\n', path: 'a.ts' }, { workdir: createWorkdir(root) })
    const result = await writeFileTool({ content: 'v2\n', path: 'a.ts' }, { workdir: createWorkdir(root) })
    expect(result.isError).toBeUndefined()
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('v2\n')
  })

  it('rejects a path outside the workdir', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'coding-agent-outside-'))
    try {
      const result = await writeFileTool({ content: 'x', path: outside }, { workdir: createWorkdir(root) })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('outside the workdir')
    }
    finally {
      rmSync(outside, { force: true, recursive: true })
    }
  })
})

describe('delete_file', () => {
  it('deletes a file', async () => {
    const result = await deleteFileTool({ path: 'a.ts' }, { workdir: createWorkdir(root) })
    expect(result.structuredContent).toEqual({ path: 'a.ts', status: 'deleted' })
    expect(() => readFileSync(join(root, 'a.ts'), 'utf8')).toThrow()
  })

  it('deletes an empty directory', async () => {
    mkdirSync(join(root, 'empty-dir'))
    const result = await deleteFileTool({ path: 'empty-dir' }, { workdir: createWorkdir(root) })
    expect(result.isError).toBeUndefined()
    expect(() => readFileSync(join(root, 'empty-dir'), 'utf8')).toThrow()
  })

  it('refuses to delete a non-empty directory without recursive', async () => {
    const result = await deleteFileTool({ path: '.' }, { workdir: createWorkdir(root) })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('workdir root')

    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'keep.txt'), 'x')
    const nested = await deleteFileTool({ path: 'dir' }, { workdir: createWorkdir(root) })
    expect(nested.isError).toBe(true)
    expect(readFileSync(join(root, 'dir', 'keep.txt'), 'utf8')).toBe('x')
  })

  it('deletes a non-empty directory with recursive', async () => {
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'dir', 'keep.txt'), 'x')
    const result = await deleteFileTool({ path: 'dir', recursive: true }, { workdir: createWorkdir(root) })
    expect(result.isError).toBeUndefined()
    expect(() => readFileSync(join(root, 'dir', 'keep.txt'), 'utf8')).toThrow()
  })

  it('reports a missing path and rejects escapes', async () => {
    const missing = await deleteFileTool({ path: 'nope.txt' }, { workdir: createWorkdir(root) })
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain('Not found')

    const outside = mkdtempSync(join(tmpdir(), 'coding-agent-outside-'))
    try {
      const escaped = await deleteFileTool({ path: outside }, { workdir: createWorkdir(root) })
      expect(escaped.isError).toBe(true)
      expect(escaped.content[0].text).toContain('outside the workdir')
    }
    finally {
      rmSync(outside, { force: true, recursive: true })
    }
  })
})

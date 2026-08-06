import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { listDirTool, readFileRangeTool, readFileTool } from './read'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-read-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'line one\nline two\nline three\n')
  writeFileSync(join(root, 'README.md'), '# hello\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n*.log\n')
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('read_file', () => {
  it('returns the full file content', async () => {
    const result = await readFileTool({ path: 'src/a.ts' }, { workdir: createWorkdir(root) })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toMatchObject({ text: 'line one\nline two\nline three\n', type: 'text' })
    expect(result.structuredContent).toMatchObject({ isTruncated: false, path: 'src/a.ts', totalChars: 29 })
  })

  it('truncates with maxChars and marks isTruncated', async () => {
    const result = await readFileTool({ maxChars: 10, path: 'src/a.ts' }, { workdir: createWorkdir(root) })
    expect(result.content[0].text).toBe('line one\nl\n\n[truncated: showing chars 0-10 of 29; use read_file_range for more]')
    expect(result.structuredContent).toMatchObject({ isTruncated: true, totalChars: 29 })
  })

  it('pages with offset', async () => {
    const result = await readFileTool({ maxChars: 8, offset: 9, path: 'src/a.ts' }, { workdir: createWorkdir(root) })
    expect(result.content[0].text).toBe('line two\n\n[truncated: showing chars 9-17 of 29; use read_file_range for more]')
  })

  it('rejects a path outside the workdir', async () => {
    const result = await readFileTool({ path: '../secret.txt' }, { workdir: createWorkdir(root) })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('outside the workdir')
  })

  it('fails clearly on a missing file', async () => {
    const result = await readFileTool({ path: 'nope.ts' }, { workdir: createWorkdir(root) })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Failed to read')
  })
})

describe('read_file_range', () => {
  it('returns an exact range', async () => {
    const result = await readFileRangeTool({ length: 8, offset: 9, path: 'src/a.ts' }, { workdir: createWorkdir(root) })
    expect(result.content[0].text).toBe('line two')
    expect(result.structuredContent).toMatchObject({ end: 17, start: 9, totalChars: 29 })
  })

  it('clips ranges to file bounds', async () => {
    const result = await readFileRangeTool({ length: 100, offset: 30, path: 'src/a.ts' }, { workdir: createWorkdir(root) })
    expect(result.content[0].text).toBe('')
    expect(result.structuredContent).toMatchObject({ end: 29, start: 29, totalChars: 29 })
  })
})

describe('list_dir', () => {
  it('lists entries respecting .gitignore', async () => {
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'x.js'), '')
    writeFileSync(join(root, 'debug.log'), 'x')

    const result = await listDirTool({ path: '.' }, { workdir: createWorkdir(root) })
    const paths = ((result.structuredContent?.entries as Array<{ path: string }>) ?? []).map(e => e.path).sort()
    expect(paths).toEqual(['.gitignore', 'README.md', 'src', 'src/a.ts'])
    expect(result.structuredContent?.skippedIgnored).toBe(2)
  })

  it('recurses with depth', async () => {
    mkdirSync(join(root, 'src', 'deep'))
    writeFileSync(join(root, 'src', 'deep', 'b.ts'), 'x')

    const shallow = await listDirTool({ depth: 0, path: 'src' }, { workdir: createWorkdir(root) })
    expect(((shallow.structuredContent?.entries as Array<{ path: string }>) ?? []).map(e => e.path)).toEqual(['a.ts', 'deep'])

    const deep = await listDirTool({ depth: 2, path: 'src' }, { workdir: createWorkdir(root) })
    const deepPaths = ((deep.structuredContent?.entries as Array<{ path: string }>) ?? []).map(e => e.path)
    expect(deepPaths).toContain('deep/b.ts')
  })
})

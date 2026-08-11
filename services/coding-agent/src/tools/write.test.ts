import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import {
  applyDiffTool,
  createWriteFileChunkState,
  deleteFileTool,
  WRITE_FILE_CHUNK_MAX_CHARS,
  writeFileChunkTool,
  writeFileTool,
} from './write'

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

  it('routes oversized whole-file writes to the bounded chunk protocol', async () => {
    const result = await writeFileTool({
      content: 'x'.repeat(WRITE_FILE_CHUNK_MAX_CHARS + 1),
      path: 'large.ts',
    }, { workdir: createWorkdir(root) })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('write_file_chunk')
    expect(() => readFileSync(join(root, 'large.ts'), 'utf8')).toThrow()
  })
})

describe('write_file_chunk', () => {
  // ROOT CAUSE:
  //
  // Whole-file `write_file` calls put the complete source file inside one tool
  // argument. Providers with an 8K output ceiling can truncate that JSON before
  // xsAI has a valid tool call to execute, and a partial JSON continuation is
  // not safe to replay.
  //
  // We fixed this by keeping each tool call bounded and staging chunks behind a
  // server-generated writeId plus an exact UTF-8 byte offset. Only the final
  // chunk replaces the destination, so an interrupted sequence leaves the
  // existing file untouched.
  it('stages ordered chunks and replaces the target only after the final chunk', async () => {
    const chunkState = createWriteFileChunkState()
    const ctx = { chunkState, workdir: createWorkdir(root) }
    const firstChunk = 'export const greeting = "你好",\n'
    const firstChunkBytes = Buffer.byteLength(firstChunk, 'utf8')

    const started = await writeFileChunkTool({
      content: firstChunk,
      final: false,
      mode: 'start',
      path: 'a.ts',
    }, ctx)

    expect(started.isError).toBeUndefined()
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n')
    expect(started.structuredContent).toMatchObject({
      nextOffset: firstChunkBytes,
      path: 'a.ts',
      status: 'started',
    })

    const writeId = String(started.structuredContent?.writeId)
    const completed = await writeFileChunkTool({
      content: 'export const done = true\n',
      expectedOffset: firstChunkBytes,
      final: true,
      mode: 'append',
      path: 'a.ts',
      writeId,
    }, ctx)

    expect(completed.isError).toBeUndefined()
    expect(completed.structuredContent).toMatchObject({
      path: 'a.ts',
      status: 'completed',
      writeId,
    })
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe([
      'export const greeting = "你好",\n',
      'export const done = true\n',
    ].join(''))
  })

  it('rejects stale offsets without changing the staged or destination content', async () => {
    const chunkState = createWriteFileChunkState()
    const ctx = { chunkState, workdir: createWorkdir(root) }
    const started = await writeFileChunkTool({
      content: 'first\n',
      mode: 'start',
      path: 'a.ts',
    }, ctx)
    const writeId = String(started.structuredContent?.writeId)

    const stale = await writeFileChunkTool({
      content: 'wrong\n',
      expectedOffset: 0,
      mode: 'append',
      path: 'a.ts',
      writeId,
    }, ctx)

    expect(stale.isError).toBe(true)
    expect(stale.content[0].text).toContain('offset mismatch')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n')

    const completed = await writeFileChunkTool({
      content: 'second\n',
      expectedOffset: 6,
      final: true,
      mode: 'append',
      path: 'a.ts',
      writeId,
    }, ctx)
    expect(completed.isError).toBeUndefined()
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('first\nsecond\n')
  })

  it('isolates write sessions by writeId and destination path', async () => {
    const chunkState = createWriteFileChunkState()
    const ctx = { chunkState, workdir: createWorkdir(root) }
    const started = await writeFileChunkTool({
      content: 'safe\n',
      mode: 'start',
      path: 'a.ts',
    }, ctx)
    const writeId = String(started.structuredContent?.writeId)

    const wrongPath = await writeFileChunkTool({
      content: 'escape\n',
      expectedOffset: 5,
      mode: 'append',
      path: 'other.ts',
      writeId,
    }, ctx)

    expect(wrongPath.isError).toBe(true)
    expect(wrongPath.content[0].text).toContain('belongs to a.ts')
    expect(() => readFileSync(join(root, 'other.ts'), 'utf8')).toThrow()
  })

  it('rejects chunks larger than the provider-safe character ceiling', async () => {
    const result = await writeFileChunkTool({
      content: 'x'.repeat(WRITE_FILE_CHUNK_MAX_CHARS + 1),
      mode: 'start',
      path: 'large.ts',
    }, { chunkState: createWriteFileChunkState(), workdir: createWorkdir(root) })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain(`${WRITE_FILE_CHUNK_MAX_CHARS} characters`)
    expect(() => readFileSync(join(root, 'large.ts'), 'utf8')).toThrow()
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

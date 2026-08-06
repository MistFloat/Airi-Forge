import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { FileSession } from './session'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-session-'))
  writeFileSync(join(root, 'existing.ts'), 'export const foo = 1\n')
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('fileSession', () => {
  it('adds an existing file as editable by default', async () => {
    const session = new FileSession(createWorkdir(root))
    const entry = await session.add({ path: 'existing.ts' })
    expect(entry.editable).toBe(true)
    expect(entry.exists).toBe(true)
    expect(entry.size).toBeGreaterThan(0)
    expect(session.editablePaths()).toEqual(['existing.ts'])
  })

  it('adds a file as read-only when readOnly is set', async () => {
    const session = new FileSession(createWorkdir(root))
    const entry = await session.add({ path: 'existing.ts', readOnly: true })
    expect(entry.editable).toBe(false)
    expect(session.list().readOnly).toHaveLength(1)
    expect(session.editablePaths()).toEqual([])
  })

  it('re-classifies a file when added with a different editable flag', async () => {
    const session = new FileSession(createWorkdir(root))
    await session.add({ path: 'existing.ts' })
    await session.add({ path: 'existing.ts', readOnly: true })
    expect(session.list().editable).toHaveLength(0)
    expect(session.list().readOnly).toHaveLength(1)
  })

  it('pre-creates a missing file when createIfMissing is true', async () => {
    const session = new FileSession(createWorkdir(root))
    const entry = await session.add({ createIfMissing: true, path: 'new-file.ts' })
    expect(entry.exists).toBe(true)
    expect(entry.size).toBe(0)
  })

  it('refuses to pre-create a read-only file', async () => {
    const session = new FileSession(createWorkdir(root))
    const entry = await session.add({ createIfMissing: true, path: 'ro.ts', readOnly: true })
    expect(entry.exists).toBe(false)
  })

  it('drops an editable file', async () => {
    const session = new FileSession(createWorkdir(root))
    await session.add({ path: 'existing.ts' })
    expect(session.drop({ path: 'existing.ts' })).toBe(true)
    expect(session.editablePaths()).toEqual([])
  })

  it('returns false when dropping a file that was not in the session', async () => {
    const session = new FileSession(createWorkdir(root))
    expect(session.drop({ path: 'never-added.ts' })).toBe(false)
  })

  it('clears the entire session', async () => {
    const session = new FileSession(createWorkdir(root))
    await session.add({ path: 'existing.ts' })
    await session.add({ path: 'existing.ts', readOnly: true })
    session.clear()
    expect(session.list().editable).toHaveLength(0)
    expect(session.list().readOnly).toHaveLength(0)
  })

  it('rejects paths outside the workdir', async () => {
    const session = new FileSession(createWorkdir(root))
    await expect(session.add({ path: '../escape.ts' })).rejects.toThrow('outside the workdir')
  })

  it('refreshes file existence after out-of-band changes', async () => {
    const session = new FileSession(createWorkdir(root))
    await session.add({ path: 'existing.ts' })
    // Delete the file out-of-band.
    rmSync(join(root, 'existing.ts'), { force: true })
    await session.refresh()
    const entry = session.list().editable[0]
    expect(entry.exists).toBe(false)
    expect(entry.size).toBe(0)
  })

  it('detects isEditable for session files', async () => {
    const session = new FileSession(createWorkdir(root))
    await session.add({ path: 'existing.ts' })
    expect(session.isEditable('existing.ts')).toBe(true)
    expect(session.isEditable('other.ts')).toBe(false)
  })

  it('creates nested directories when createIfMissing is set', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    const session = new FileSession(createWorkdir(root))
    const entry = await session.add({ createIfMissing: true, path: 'src/nested/deep.ts' })
    expect(entry.exists).toBe(true)
  })
})

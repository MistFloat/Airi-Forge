import type { SkillReadResult, SkillSummary } from '@proj-airi/stage-shared'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureSkillTransport, SKILL_UNAVAILABLE_MESSAGE, useSkillStore } from './skill-store'

function createSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    description: 'A sample skill.',
    id: 'sample',
    name: 'Sample',
    path: '/skills/sample/SKILL.md',
    references: [],
    source: 'user',
    ...overrides,
  }
}

describe('skill store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    configureSkillTransport()
    vi.restoreAllMocks()
  })

  it('renders an empty promptListing when no skills are discovered', () => {
    const store = useSkillStore()

    expect(store.promptListing).toBe('')
  })

  it('renders name, id, description, and references in the prompt listing', () => {
    const store = useSkillStore()
    store.applySnapshot({
      directories: [],
      skills: [
        createSkill({ description: 'Alpha things.', id: 'alpha', name: 'Alpha', references: ['a.md', 'notes/b.md'] }),
        createSkill({ description: 'Beta things.', id: 'beta', name: 'Beta' }),
      ],
    })

    const listing = store.promptListing

    expect(listing).toContain('## Skills')
    expect(listing).toContain('- Alpha (id: alpha): Alpha things. [references: a.md, notes/b.md]')
    expect(listing).toContain('- Beta (id: beta): Beta things.')
    expect(listing).not.toContain('- Beta (id: beta): Beta things. [references:')
  })

  it('keeps the previous snapshot when the transport rejects during refresh', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = useSkillStore()
    const previous = createSkill({ id: 'kept', name: 'Kept' })
    store.applySnapshot({ directories: [], skills: [previous] })

    configureSkillTransport({
      list: vi.fn(async () => {
        throw new Error('discovery failed')
      }),
      read: vi.fn(),
    })
    await store.refresh()

    expect(store.skills).toEqual([previous])
  })

  it('cleans up only the transport it installed', async () => {
    const first = {
      list: vi.fn(async () => ({ directories: [], skills: [createSkill({ id: 'first', name: 'First' })] })),
      read: vi.fn(),
    }
    const second = {
      list: vi.fn(async () => ({ directories: [], skills: [createSkill({ id: 'second', name: 'Second' })] })),
      read: vi.fn(),
    }
    const disposeFirst = configureSkillTransport(first)
    configureSkillTransport(second)
    disposeFirst()

    const store = useSkillStore()
    await store.refresh()

    expect(first.list).not.toHaveBeenCalled()
    expect(second.list).toHaveBeenCalled()
    expect(store.skills.map(skill => skill.id)).toEqual(['second'])
  })

  it('fails read with an explicit message when no transport is installed', async () => {
    const store = useSkillStore()

    await expect(store.read({ id: 'x' })).rejects.toThrow(SKILL_UNAVAILABLE_MESSAGE)
  })

  it('delegates read to the installed transport', async () => {
    const result: SkillReadResult = {
      content: 'body',
      id: 'x',
      kind: 'skill',
      path: '/skills/x/SKILL.md',
    }
    const read = vi.fn(async () => result)
    configureSkillTransport({ list: vi.fn(), read })

    const store = useSkillStore()
    await expect(store.read({ id: 'x' })).resolves.toEqual(result)
    expect(read).toHaveBeenCalledWith({ id: 'x' })
  })
})

import type { SkillReadInput, SkillReadResult, SkillSummary } from '@proj-airi/stage-shared'
import type { ToolExecuteOptions } from '@xsai/shared-chat'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureSkillTransport, SKILL_UNAVAILABLE_MESSAGE, useSkillStore } from '../stores/modules/skill-store'
import { skillTools } from './skill'

const toolOptions = {} as ToolExecuteOptions

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

describe('skill tools', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    configureSkillTransport()
    vi.restoreAllMocks()
  })

  it('lists the catalogue with a fake transport installed', async () => {
    configureSkillTransport({
      list: vi.fn(async () => ({
        directories: [],
        skills: [
          createSkill({ description: 'Alpha description.', id: 'alpha', name: 'Alpha', references: ['alpha.md'], source: 'workspace' }),
          createSkill({ description: 'Beta description.', id: 'beta', name: 'Beta' }),
        ],
      })),
      read: vi.fn(),
    })
    await useSkillStore().refresh()

    const tools = await skillTools()
    const list = tools.find(tool => tool.function.name === 'built_in_skillList')
    expect(list).toBeDefined()

    const output = await list!.execute({}, toolOptions)

    expect(output).toContain('Alpha (id: alpha, source: workspace): Alpha description. [references: alpha.md]')
    expect(output).toContain('Beta (id: beta, source: user): Beta description.')
  })

  it('reads a skill body and a reference document', async () => {
    const read = vi.fn(async (input: SkillReadInput): Promise<SkillReadResult> => {
      if (input.reference) {
        return {
          content: 'reference body',
          id: 'alpha',
          kind: 'reference',
          path: '/skills/alpha/references/alpha.md',
          reference: input.reference,
        }
      }
      return { content: 'skill body', id: 'alpha', kind: 'skill', path: '/skills/alpha/SKILL.md' }
    })
    configureSkillTransport({
      list: vi.fn(async () => ({
        directories: [],
        skills: [createSkill({ id: 'alpha', name: 'Alpha', references: ['alpha.md'] })],
      })),
      read,
    })
    await useSkillStore().refresh()

    const tools = await skillTools()
    const readTool = tools.find(tool => tool.function.name === 'built_in_skillRead')
    expect(readTool).toBeDefined()

    const body = await readTool!.execute({ id: 'alpha' }, toolOptions)
    expect(body).toContain('## Alpha (alpha)')
    expect(body).toContain('skill body')
    expect(read).toHaveBeenCalledWith({ id: 'alpha' })

    const reference = await readTool!.execute({ id: 'alpha', reference: 'alpha.md' }, toolOptions)
    expect(reference).toContain('## Alpha (alpha) — reference: alpha.md')
    expect(reference).toContain('reference body')
    expect(read).toHaveBeenCalledWith({ id: 'alpha', reference: 'alpha.md' })
  })

  it('fails unknown ids with the available ids', async () => {
    configureSkillTransport({
      list: vi.fn(async () => ({
        directories: [],
        skills: [
          createSkill({ id: 'alpha', name: 'Alpha' }),
          createSkill({ id: 'beta', name: 'Beta' }),
        ],
      })),
      read: vi.fn(),
    })
    await useSkillStore().refresh()

    const tools = await skillTools()
    const readTool = tools.find(tool => tool.function.name === 'built_in_skillRead')
    expect(readTool).toBeDefined()

    const output = await readTool!.execute({ id: 'missing' }, toolOptions)

    expect(output).toContain('Unknown skill id "missing"')
    expect(output).toContain('alpha, beta')
  })

  it('reports that skills are unavailable when no transport is configured', async () => {
    const tools = await skillTools()
    const list = tools.find(tool => tool.function.name === 'built_in_skillList')
    const read = tools.find(tool => tool.function.name === 'built_in_skillRead')
    expect(list).toBeDefined()
    expect(read).toBeDefined()

    const listOutput = await list!.execute({}, toolOptions)
    const readOutput = await read!.execute({ id: 'alpha' }, toolOptions)

    expect(listOutput).toBe(SKILL_UNAVAILABLE_MESSAGE)
    expect(readOutput).toBe(SKILL_UNAVAILABLE_MESSAGE)
  })
})

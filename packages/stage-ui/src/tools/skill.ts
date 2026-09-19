import type { SkillReadResult, SkillSummary } from '@proj-airi/stage-shared'
import type { Tool } from '@xsai/shared-chat'

import { errorMessageFromValue } from '@proj-airi/stage-shared'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { SKILL_UNAVAILABLE_MESSAGE, useSkillStore } from '../stores/modules/skill-store'

/**
 * Builds the model-facing skill tools backed by the shared skill store.
 *
 * Skills are instruction documents, not tools: the model re-checks what is
 * available with `built_in_skillList` and loads a body or reference on demand
 * with `built_in_skillRead`. Both tools read from {@link useSkillStore} and
 * never touch the filesystem directly.
 */
export async function skillTools(): Promise<Tool[]> {
  return await Promise.all([
    tool({
      description: 'List the installed skills and their reference documents. Use this to re-check which skill ids and references exist before calling built_in_skillRead.',
      execute: async () => {
        const store = useSkillStore()
        if (!store.hasTransport())
          return SKILL_UNAVAILABLE_MESSAGE
        if (store.skills.length === 0)
          return 'No skills are installed.'
        return formatSkillListing(store.skills)
      },
      name: 'built_in_skillList',
      parameters: z.object({}).strict(),
    }),
    tool({
      description: 'Read the body of an installed skill (its SKILL.md) or one of its reference documents by skill id and optional reference path from built_in_skillList.',
      execute: async ({ id, reference }) => {
        const store = useSkillStore()
        if (!store.hasTransport())
          return SKILL_UNAVAILABLE_MESSAGE

        const skills = store.skills
        const skill = skills.find(candidate => candidate.id === id)
        if (!skill)
          return unknownSkillMessage(id, skills)
        if (reference !== undefined && !skill.references.includes(reference))
          return unknownReferenceMessage(skill, reference)

        try {
          const result = await store.read({ id, reference })
          return formatSkillReadResult(result, skill.name)
        }
        catch (error) {
          return `Failed to read skill "${id}": ${errorMessageFromValue(error)}`
        }
      },
      name: 'built_in_skillRead',
      parameters: z.object({
        id: z.string().describe('Skill id from built_in_skillList.'),
        reference: z.string().optional().describe('Reference path from the skill listing, or omit to read the skill body.'),
      }).strict(),
    }),
  ])
}

/** Renders one bullet per skill with id, name, description, source, and references. */
function formatSkillListing(skills: SkillSummary[]): string {
  return [
    'Available skills:',
    ...skills.map((skill) => {
      const references = skill.references.length
        ? ` [references: ${skill.references.join(', ')}]`
        : ''
      return `- ${skill.name} (id: ${skill.id}, source: ${skill.source}): ${skill.description}${references}`
    }),
  ].join('\n')
}

/** Prefixes a skill body or reference with a short header naming both. */
function formatSkillReadResult(result: SkillReadResult, name: string): string {
  const reference = result.kind === 'reference' && result.reference != null
    ? ` — reference: ${result.reference}`
    : ''
  return `## ${name} (${result.id})${reference}\n\n${result.content}`
}

function unknownReferenceMessage(skill: SkillSummary, reference: string): string {
  const available = skill.references.length ? skill.references.join(', ') : '(none)'
  return `Unknown reference "${reference}" for skill "${skill.id}". Available references: ${available}`
}

function unknownSkillMessage(id: string, skills: SkillSummary[]): string {
  const available = skills.length ? skills.map(skill => skill.id).join(', ') : '(none)'
  return `Unknown skill id "${id}". Available skills: ${available}`
}

import type { SkillReadInput, SkillReadResult, SkillSnapshot, SkillSummary } from '@proj-airi/stage-shared'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Platform transport that discovers skills and reads their documents.
 *
 * The Electron main process implements this. The renderer only lists and reads
 * through it, never touching the filesystem directly.
 */
export interface SkillTransport {
  /** Lists every discoverable skill plus the scanned roots. */
  list: () => Promise<SkillSnapshot>
  /** Reads one skill body or one of its reference documents. */
  read: (input: SkillReadInput) => Promise<SkillReadResult>
}

/**
 * Message surfaced to the model when no platform skill transport is installed.
 *
 * Shared by the store and the model-facing tools so both report the same
 * unavailability state instead of a silently empty skill list.
 */
export const SKILL_UNAVAILABLE_MESSAGE = 'Skills are unavailable in this environment.'

let activeTransport: SkillTransport | undefined

/**
 * Installs the platform skill transport with ownership-safe cleanup.
 *
 * The returned disposer only clears the transport when it is still the one this
 * call installed, so a newer owner is never clobbered by an older one.
 */
export function configureSkillTransport(transport?: SkillTransport): () => void {
  activeTransport = transport
  return () => {
    if (activeTransport === transport)
      activeTransport = undefined
  }
}

/**
 * Renderer-side skill store.
 *
 * Holds the latest discovered snapshot and reads skill bodies on demand through
 * the installed transport. The platform host is expected to call
 * {@link configureSkillTransport} and then {@link refresh} on startup.
 */
export const useSkillStore = defineStore('skills', () => {
  const snapshot = ref<SkillSnapshot>({ directories: [], skills: [] })
  const skills = computed<SkillSummary[]>(() => snapshot.value.skills)

  /** Replaces the discovered snapshot (used by refresh and by tests/hosts). */
  function applySnapshot(next: SkillSnapshot): void {
    snapshot.value = next
  }

  /**
   * Reloads the snapshot from the transport.
   *
   * Degrades gracefully: keeps the previous snapshot when no transport is
   * installed or when listing rejects, and never throws.
   */
  async function refresh(): Promise<void> {
    if (!activeTransport)
      return
    try {
      snapshot.value = await activeTransport.list()
    }
    catch (error) {
      console.error('Failed to refresh skills:', error)
    }
  }

  /** Reads one skill body or reference, failing when no transport is installed. */
  async function read(input: SkillReadInput): Promise<SkillReadResult> {
    if (!activeTransport)
      throw new Error(SKILL_UNAVAILABLE_MESSAGE)
    return await activeTransport.read(input)
  }

  /**
   * True when a platform transport is installed.
   *
   * Not reactive on purpose: the transport is module-level state, and tools
   * read it once per invocation.
   */
  function hasTransport(): boolean {
    return activeTransport !== undefined
  }

  /**
   * Passive skill advertisement injected into the system prompt.
   *
   * Empty when no skills are discovered. Bodies are never included here — the
   * model reads them on demand through the skill tools.
   */
  const promptListing = computed<string>(() => {
    const discovered = snapshot.value.skills
    if (discovered.length === 0)
      return ''

    const lines = [
      '## Skills',
      '',
      'Skills are instruction documents, not tools. When one matches the task, read it with `built_in_skillRead` before acting; they are not loaded automatically.',
      '',
    ]
    for (const skill of discovered) {
      const references = skill.references.length
        ? ` [references: ${skill.references.join(', ')}]`
        : ''
      lines.push(`- ${skill.name} (id: ${skill.id}): ${skill.description}${references}`)
    }
    return lines.join('\n')
  })

  return {
    applySnapshot,
    hasTransport,
    promptListing,
    read,
    refresh,
    skills,
    snapshot,
  }
})

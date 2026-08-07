import type { CompilableInstruction, InstructionScope } from './instructionCompiler'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { compileInstructions } from './instructionCompiler'
import {
  buildStageInstructionContent,
  hasStageInstructionSeed,
  STAGE_CONTROL_RULE_KEY,
  STAGE_CONTROL_TITLE,
} from './stageInstructionSeed'

export interface InstructionDraft {
  content: string
  effectiveFrom?: string
  effectiveUntil?: string
  instructionPriority: number
  instructionRuleKey?: null | string
  instructionScope: InstructionScope
  status: 'active' | 'archived' | 'superseded'
  supersedesId?: string
  title: string
}

/**
 * Durable, editable instruction plane. Instructions are standing rules that
 * are compiled into the system prompt on every turn; they are config, not
 * retrievable memory, so they live in localStorage and never depend on the
 * long-term-memory gateway being configured.
 */
export const useInstructionStore = defineStore('instructions', () => {
  const { t } = useI18n()
  const instructions = useLocalStorageManualReset<CompilableInstruction[]>('settings/instructions/list', [])
  const tokenBudget = useLocalStorageManualReset<number>('settings/instructions/token-budget', 1200)

  /**
   * Optional external instruction override (e.g. a root-directory instruction.md
   * file loaded by the Electron main process). When set, this content replaces
   * the compiled localStorage instructions entirely for system-prompt injection.
   */
  const fileInstructionContent = ref<null | string>(null)

  function nowIso(): string {
    return new Date().toISOString()
  }

  /** Idempotently seeds the default stage-control instruction (ACT / DELAY / CALL). */
  function seedStageControl() {
    if (hasStageInstructionSeed(instructions.value))
      return
    const now = nowIso()
    instructions.value = [
      ...instructions.value,
      {
        content: buildStageInstructionContent(
          t('base.prompt.stageInstruction'),
          t('base.prompt.stageActions'),
        ),
        createdAt: now,
        instructionPriority: 100,
        instructionRuleKey: STAGE_CONTROL_RULE_KEY,
        instructionScope: 'global',
        memoryId: `instruction:${nanoid(8)}`,
        status: 'active',
        title: STAGE_CONTROL_TITLE,
        updatedAt: now,
      },
    ]
  }

  /** Upserts an instruction and returns its id. */
  function saveInstruction(draft: InstructionDraft, memoryId?: string): string {
    const id = memoryId || `instruction:${nanoid(8)}`
    const now = nowIso()
    const existing = instructions.value.find(item => item.memoryId === id)
    const next: CompilableInstruction = {
      ...draft,
      createdAt: existing?.createdAt ?? now,
      memoryId: id,
      updatedAt: now,
    }
    instructions.value = [...instructions.value.filter(item => item.memoryId !== id), next]
    return id
  }

  function deleteInstruction(memoryId: string) {
    instructions.value = instructions.value.filter(item => item.memoryId !== memoryId)
  }

  /** Compiled prompt text injected into the system message on every turn. */
  const compiled = computed(() => {
    if (fileInstructionContent.value != null) {
      return {
        estimatedTokens: 0,
        instructions: [] as CompilableInstruction[],
        omittedCount: 0,
        prompt: fileInstructionContent.value,
      }
    }
    return compileInstructions(instructions.value, {
      scopes: ['chat', 'speech'],
      tokenBudget: tokenBudget.value,
    })
  })

  /** Replaces the compiled instructions with external file content, or clears it. */
  function setFileInstructionContent(content: null | string) {
    fileInstructionContent.value = content
  }

  return {
    compiled,
    deleteInstruction,
    fileInstructionContent,
    instructions,
    saveInstruction,
    seedStageControl,
    setFileInstructionContent,
    tokenBudget,
  }
})

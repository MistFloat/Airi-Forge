import type { CompilableInstruction } from './instructionCompiler'

import { EMOTION_EmotionMotionName_value, EMOTION_VALUES } from '../../constants/emotions'

/**
 * Rule key that identifies the seeded stage-control instruction. Keep it
 * stable across locales so the seed check is language-independent.
 */
export const STAGE_CONTROL_RULE_KEY = 'stage-control'

/** Stable display title used when seeding the stage-control instruction. */
export const STAGE_CONTROL_TITLE = 'Stage control (ACT / DELAY / CALL)'

/**
 * Composes the default stage-control instruction body from the localized
 * streaming-token syntax block, the emotion allow-list, and the action block.
 * This mirrors the text that used to live in the default card description via
 * `SystemPromptV2`, so behavior after the migration stays identical.
 *
 * Before:
 * - stageInstruction = "Start every reply with an ACT token..."
 * - stageActions = "The available actions:\n\n- <|DELAY 1|>..."
 *
 * After:
 * - "Start every reply with an ACT token...\n\n- happy (Emotion for feeling
 *   Happy)\n- sad (Emotion for feeling Sad)\n...\n\nThe available actions..."
 */
export function buildStageInstructionContent(stageInstruction: string, stageActions: string): string {
  return [
    stageInstruction,
    EMOTION_VALUES
      .map(emotion => `- ${emotion} (Emotion for feeling ${EMOTION_EmotionMotionName_value[emotion]})`)
      .join('\n'),
    stageActions,
  ].join('\n\n')
}

/** Returns true when any listed instruction carries the stage-control rule key. */
export function hasStageInstructionSeed(instructions: CompilableInstruction[]): boolean {
  return instructions.some(instruction => instruction.instructionRuleKey === STAGE_CONTROL_RULE_KEY)
}

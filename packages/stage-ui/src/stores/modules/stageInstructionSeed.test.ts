import type { CompilableInstruction } from './instructionCompiler'

import { describe, expect, it } from 'vitest'

import { EMOTION_EmotionMotionName_value, EMOTION_VALUES } from '../../constants/emotions'
import {
  buildStageInstructionContent,
  hasStageInstructionSeed,
  STAGE_CONTROL_RULE_KEY,
  STAGE_CONTROL_TITLE,
} from './stageInstructionSeed'

function instruction(overrides: Partial<CompilableInstruction> = {}): CompilableInstruction {
  return {
    content: 'content',
    createdAt: '2026-01-01T00:00:00.000Z',
    instructionPriority: 50,
    instructionScope: 'global',
    memoryId: 'm1',
    status: 'active',
    title: 'title',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('buildStageInstructionContent', () => {
  it('joins the localized syntax block, the full emotion allow-list, and the actions block', () => {
    const content = buildStageInstructionContent(
      'Start every reply with an ACT token.',
      'The available actions:\n\n- <|DELAY 1|> (1s)',
    )

    expect(content).toContain('Start every reply with an ACT token.')
    expect(content).toContain('The available actions:\n\n- <|DELAY 1|> (1s)')
    for (const emotion of EMOTION_VALUES) {
      expect(content).toContain(`- ${emotion} (Emotion for feeling ${EMOTION_EmotionMotionName_value[emotion]})`)
    }
  })

  it('keeps a stable rule key and title for the seeded instruction', () => {
    expect(STAGE_CONTROL_RULE_KEY).toBe('stage-control')
    expect(STAGE_CONTROL_TITLE).toBe('Stage control (ACT / DELAY / CALL)')
  })
})

describe('hasStageInstructionSeed', () => {
  it('is true when a listed instruction carries the stage-control rule key', () => {
    expect(hasStageInstructionSeed([
      instruction({ instructionRuleKey: STAGE_CONTROL_RULE_KEY }),
    ])).toBe(true)
  })

  it('is false when no instruction carries the rule key', () => {
    expect(hasStageInstructionSeed([
      instruction({ instructionRuleKey: 'some-other-rule' }),
      instruction(),
    ])).toBe(false)
  })
})

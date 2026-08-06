import { describe, expect, it } from 'vitest'

import { compileInstructions } from './instructionCompiler'

const baseInstruction = {
  content: 'Always answer clearly.',
  createdAt: '2026-01-01T00:00:00.000Z',
  instructionPriority: 50,
  instructionRuleKey: 'response.style',
  instructionScope: 'global' as const,
  memoryId: 'base',
  status: 'active' as const,
  title: 'Base rule',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

describe('compileInstructions', () => {
  it('keeps active global and matching scoped rules without semantic retrieval', () => {
    const result = compileInstructions([
      baseInstruction,
      { ...baseInstruction, content: 'Use SSML for speech output.', instructionRuleKey: 'speech.ssml', instructionScope: 'speech', memoryId: 'speech' },
      { ...baseInstruction, content: 'Describe screen changes.', instructionRuleKey: 'vision.detail', instructionScope: 'vision', memoryId: 'vision' },
    ], { now: new Date('2026-08-01T00:00:00.000Z'), scopes: ['chat', 'speech'], tokenBudget: 500 })

    expect(result.instructions.map(item => item.memoryId)).toEqual(['base', 'speech'])
    expect(result.prompt).toContain('Always answer clearly.')
    expect(result.prompt).toContain('Use SSML for speech output.')
    expect(result.prompt).not.toContain('Describe screen changes.')
  })

  it('removes expired, inactive, and explicitly superseded rules', () => {
    const result = compileInstructions([
      baseInstruction,
      { ...baseInstruction, effectiveUntil: '2026-06-01T00:00:00.000Z', instructionRuleKey: 'expired', memoryId: 'expired' },
      { ...baseInstruction, instructionRuleKey: 'archived', memoryId: 'archived', status: 'archived' as const },
      { ...baseInstruction, content: 'Use the replacement.', instructionPriority: 80, memoryId: 'replacement', supersedesId: 'base' },
    ], { now: new Date('2026-08-01T00:00:00.000Z'), scopes: ['chat'], tokenBudget: 500 })

    expect(result.instructions.map(item => item.memoryId)).toEqual(['replacement'])
  })

  it('resolves the same rule key by priority and then newest update', () => {
    const result = compileInstructions([
      baseInstruction,
      { ...baseInstruction, content: 'New response style.', instructionPriority: 70, memoryId: 'newer', updatedAt: '2026-07-01T00:00:00.000Z' },
      { ...baseInstruction, content: 'Older response style.', instructionPriority: 70, memoryId: 'older-high', updatedAt: '2026-06-01T00:00:00.000Z' },
    ], { scopes: ['chat'], tokenBudget: 500 })

    expect(result.instructions.map(item => item.memoryId)).toEqual(['newer'])
  })

  it('uses a deterministic token budget and reports omitted rules', () => {
    const result = compileInstructions([
      { ...baseInstruction, content: 'A'.repeat(120), instructionPriority: 100, memoryId: 'critical' },
      { ...baseInstruction, content: 'B'.repeat(120), instructionPriority: 10, instructionRuleKey: 'optional', memoryId: 'optional' },
    ], { scopes: ['chat'], tokenBudget: 50 })

    expect(result.instructions.map(item => item.memoryId)).toEqual(['critical'])
    expect(result.omittedCount).toBe(1)
  })
})

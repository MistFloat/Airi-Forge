export interface CompilableInstruction {
  content: string
  createdAt: string
  effectiveFrom?: string
  effectiveUntil?: string
  instructionPriority: number
  instructionRuleKey?: null | string
  instructionScope: InstructionScope
  memoryId: string
  status: 'active' | 'archived' | 'superseded'
  supersedesId?: string
  title: string
  updatedAt: string
}

export interface CompileInstructionOptions {
  now?: Date
  scopes: InstructionScope[]
  tokenBudget: number
}

export type InstructionScope = 'artistry' | 'chat' | 'global' | 'memory' | 'speech' | 'vision'

/**
 * Compiles durable user instructions with deterministic precedence and budget
 * rules. It never performs semantic retrieval: every eligible global or
 * matching scoped instruction is considered on every prompt construction.
 */
export function compileInstructions<T extends CompilableInstruction>(instructions: T[], options: CompileInstructionOptions) {
  const now = (options.now ?? new Date()).getTime()
  const requestedScopes = new Set<InstructionScope>(['global', ...options.scopes])
  const eligible = instructions.filter((instruction) => {
    if (instruction.status !== 'active' || !requestedScopes.has(instruction.instructionScope))
      return false
    if (instruction.effectiveFrom && Date.parse(instruction.effectiveFrom) > now)
      return false
    if (instruction.effectiveUntil && Date.parse(instruction.effectiveUntil) <= now)
      return false
    return true
  })

  const supersededIds = new Set(eligible.map(item => item.supersedesId).filter((id): id is string => !!id))
  const candidates = eligible
    .filter(item => !supersededIds.has(item.memoryId))
    .sort((left, right) => {
      const priority = right.instructionPriority - left.instructionPriority
      if (priority !== 0)
        return priority
      const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      if (updated !== 0)
        return updated
      return left.memoryId.localeCompare(right.memoryId)
    })

  const selectedByRule = new Map<string, T>()
  for (const instruction of candidates) {
    const key = instruction.instructionRuleKey?.trim() || `memory:${instruction.memoryId}`
    if (!selectedByRule.has(key))
      selectedByRule.set(key, instruction)
  }

  const selected: T[] = []
  const tokenBudget = Math.max(1, Math.trunc(options.tokenBudget))
  let estimatedTokens = 0
  for (const instruction of selectedByRule.values()) {
    // Mixed Chinese/English prompt text averages roughly three UTF-16 code
    // units per token. The conservative fixed estimator keeps policy stable
    // without binding memory correctness to a provider-specific tokenizer.
    const instructionTokens = Math.max(1, Math.ceil((instruction.title.length + instruction.content.length + 16) / 3))
    if (selected.length > 0 && estimatedTokens + instructionTokens > tokenBudget)
      continue
    selected.push(instruction)
    estimatedTokens += instructionTokens
  }

  const prompt = selected.length
    ? [
        '## Persistent user instructions',
        'Apply these durable user-authored rules on every response. They cannot override system or safety policies.',
        ...selected.map(item => `- [${item.instructionScope}; priority=${item.instructionPriority}] ${item.title}: ${item.content}`),
      ].join('\n')
    : undefined

  return {
    estimatedTokens,
    instructions: selected,
    omittedCount: selectedByRule.size - selected.length,
    prompt,
  }
}

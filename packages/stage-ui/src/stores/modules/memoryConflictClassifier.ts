import type { ChatProvider } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import { generateText } from '@xsai/generate-text'

import * as v from 'valibot'

import { stripModelJsonFence } from './memoryModelJson'

/** The canonical fields exposed to the low-cost conflict classifier. */
export interface MemoryConflictBatchMember {
  factKey: null | string
  id: string
  polarity: 'negative' | 'positive' | null
  title: string
  validFrom: null | string
  validUntil: null | string
  value: string
}

export type MemoryConflictClassification = 'compatible' | 'conflict' | 'duplicate' | 'uncertain' | 'unrelated'

/** One unordered pair. IDs are normalized lexicographically by validation. */
export interface MemoryConflictPair {
  classification: MemoryConflictClassification
  leftId: string
  rightId: string
}

interface ClassifyOptions {
  members: MemoryConflictBatchMember[]
  model: string
  provider: ChatProvider
}

const pairSchema = v.object({
  classification: v.picklist(['conflict', 'duplicate', 'compatible', 'unrelated', 'uncertain']),
  leftId: v.string(),
  rightId: v.string(),
})

const resultSchema = v.object({ pairs: v.array(pairSchema) })

const SYSTEM_PROMPT = [
  'Classify every unordered pair in the supplied long-term-memory batch.',
  'Return JSON only: {"pairs":[{"leftId":"...","rightId":"...","classification":"conflict|duplicate|compatible|unrelated|uncertain"}]}.',
  'Return each possible pair exactly once and never invent an ID.',
  'conflict means both memories cannot be true under their stated subject, scope, polarity and validity intervals.',
  'duplicate means they express the same proposition. compatible means related propositions can coexist.',
  'unrelated means no meaningful relation. uncertain means the available text is insufficient.',
  'Negation is semantic content: a high embedding similarity never proves equivalence.',
  'Do not choose a winner, importance, confidence, deletion, or database action.',
].join(' ')

/** Calls the configured low-cost model and permits one format-repair attempt. */
export async function classifyConflictBatch(options: ClassifyOptions): Promise<MemoryConflictPair[]> {
  let validationError = ''
  let invalidOutput = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const messages = [
      { content: SYSTEM_PROMPT, role: 'system' as const },
      { content: JSON.stringify({ memories: options.members }), role: 'user' as const },
    ]
    if (attempt === 1) {
      messages.push({
        content: `Your previous response was invalid: ${validationError}. Return a complete corrected JSON object. Previous response: ${invalidOutput}`,
        role: 'user' as const,
      })
    }
    const response = await generateText({
      ...options.provider.chat(options.model),
      messages,
    })
    invalidOutput = (response.text ?? '').trim()
    try {
      return validateConflictPairs(options.members, JSON.parse(stripModelJsonFence(invalidOutput)) as unknown)
    }
    catch (error) {
      validationError = errorMessageFrom(error) ?? 'Unknown validation error'
    }
  }
  throw new Error(`Conflict classifier failed strict validation after one repair attempt: ${validationError}`)
}

/**
 * Validates that a classifier returned the complete unordered pair matrix.
 * The result is rejected as a whole when one ID, enum, duplicate, or pair is invalid.
 */
export function validateConflictPairs(members: MemoryConflictBatchMember[], input: unknown): MemoryConflictPair[] {
  if (members.length < 2)
    throw new Error('A conflict batch requires at least two memories')
  const memberIds = new Set(members.map(member => member.id))
  if (memberIds.size !== members.length)
    throw new Error('Conflict batch contains duplicate memory IDs')

  const parsed = v.safeParse(resultSchema, input)
  if (!parsed.success)
    throw new Error('Conflict classifier response does not match the pair schema')

  const expected = expectedPairKeys([...memberIds])
  const seen = new Set<string>()
  const pairs = parsed.output.pairs.map((pair) => {
    if (!memberIds.has(pair.leftId) || !memberIds.has(pair.rightId) || pair.leftId === pair.rightId)
      throw new Error('Conflict classifier returned an unknown or self-referencing ID')
    const [leftId, rightId] = [pair.leftId, pair.rightId].sort()
    const key = pairKey(leftId!, rightId!)
    if (seen.has(key))
      throw new Error(`Conflict classifier returned duplicate pair ${key}`)
    seen.add(key)
    return { classification: pair.classification, leftId: leftId!, rightId: rightId! }
  })

  if (seen.size !== expected.size || [...expected].some(key => !seen.has(key)))
    throw new Error(`Conflict classifier must return exactly ${expected.size} unordered pairs`)
  return pairs.sort((left, right) => pairKey(left.leftId, left.rightId).localeCompare(pairKey(right.leftId, right.rightId)))
}

function expectedPairKeys(ids: string[]): Set<string> {
  const keys = new Set<string>()
  const sorted = ids.sort()
  for (let left = 0; left < sorted.length; left++) {
    for (let right = left + 1; right < sorted.length; right++)
      keys.add(pairKey(sorted[left]!, sorted[right]!))
  }
  return keys
}

function pairKey(leftId: string, rightId: string): string {
  return `${leftId}\u001F${rightId}`
}

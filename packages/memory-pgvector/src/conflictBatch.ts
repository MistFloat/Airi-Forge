export type ConflictBatchClassification = 'compatible' | 'conflict' | 'duplicate' | 'uncertain' | 'unrelated'

export interface ConflictBatchPair {
  classification: ConflictBatchClassification
  leftId: string
  rightId: string
}

/** Result of strict all-pairs validation and deterministic seed-set policy. */
export interface ValidatedConflictBatch {
  actionablePairs: ConflictBatchPair[]
  removableIds: string[]
  validatedPairs: ConflictBatchPair[]
}

const classifications = new Set<ConflictBatchClassification>(['compatible', 'conflict', 'duplicate', 'uncertain', 'unrelated'])

/**
 * Validates a complete unordered pair matrix and derives which batch members
 * are benign relative to every other member. No model-provided state action is accepted.
 */
export function validateConflictBatch(memberIds: string[], inputPairs: ConflictBatchPair[]): ValidatedConflictBatch {
  const ids = [...new Set(memberIds)]
  if (ids.length !== memberIds.length || ids.length < 2)
    throw new Error('Conflict batch must contain at least two unique memory IDs')
  const allowedIds = new Set(ids)
  const expected = expectedKeys(ids)
  const seen = new Set<string>()
  const validatedPairs = inputPairs.map((pair) => {
    if (!allowedIds.has(pair.leftId) || !allowedIds.has(pair.rightId) || pair.leftId === pair.rightId)
      throw new Error('Conflict batch pair contains an unknown or self-referencing ID')
    if (!classifications.has(pair.classification))
      throw new Error('Conflict batch pair contains an invalid classification')
    const [leftId, rightId] = [pair.leftId, pair.rightId].sort()
    const key = pairKey(leftId!, rightId!)
    if (seen.has(key))
      throw new Error(`Conflict batch contains duplicate pair ${key}`)
    seen.add(key)
    return { classification: pair.classification, leftId: leftId!, rightId: rightId! }
  })
  if (seen.size !== expected.size || [...expected].some(key => !seen.has(key)))
    throw new Error(`Conflict batch must contain exactly ${expected.size} unordered pairs`)

  const nonBenignIds = new Set<string>()
  for (const pair of validatedPairs) {
    if (pair.classification === 'compatible' || pair.classification === 'unrelated')
      continue
    nonBenignIds.add(pair.leftId)
    nonBenignIds.add(pair.rightId)
  }
  return {
    actionablePairs: validatedPairs.filter(pair => pair.classification === 'conflict' || pair.classification === 'duplicate' || pair.classification === 'uncertain'),
    removableIds: ids.filter(id => !nonBenignIds.has(id)),
    validatedPairs,
  }
}

function expectedKeys(ids: string[]): Set<string> {
  const keys = new Set<string>()
  const sorted = [...ids].sort()
  for (let left = 0; left < sorted.length; left++) {
    for (let right = left + 1; right < sorted.length; right++)
      keys.add(pairKey(sorted[left]!, sorted[right]!))
  }
  return keys
}

function pairKey(leftId: string, rightId: string): string {
  return `${leftId}\u001F${rightId}`
}

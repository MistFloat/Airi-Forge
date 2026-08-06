import type { LongTermMemoryDraft } from './memory-long-term'

/** Golden retrieval targets, resolved to the ids used by the lab imports. */
export interface MemoryEvaluationCase {
  caseId: string
  confidence: number
  /** Memory ids that a good recall run must return (`evaluation-<caseId>-<n>`). */
  expectedIds: string[]
  /** Memory ids that a good recall run must not return (`evaluation-<caseId>-f<n>`). */
  forbiddenIds: string[]
  /** Latest user assertion from the conversation flow, used as the recall query. */
  query: string
  sceneCategory: string
  sceneSubType: string
}

interface ParsedEvaluationCase extends MemoryEvaluationCase {
  expectedContents: string[]
  forbiddenContents: string[]
}

/**
 * Converts the long-term-memory evaluation dataset into idempotent manual
 * canonical-memory drafts.
 *
 * Golden targets become `evaluation-<caseId>-<n>` memories; forbidden targets
 * become `evaluation-<caseId>-f<n>` memories tagged `forbidden` so an offline
 * recall run can measure both recall and leakage from the same namespace.
 */
export function memoryDraftsFromEvaluationDataset(input: unknown): LongTermMemoryDraft[] {
  if (!Array.isArray(input))
    throw new Error('Memory evaluation dataset must be a JSON array')

  const cases = input.map(parseEvaluationCase)
  const drafts: LongTermMemoryDraft[] = []
  for (const testCase of cases) {
    const caseTags = ['evaluation', `case-${testCase.caseId}`, testCase.sceneCategory]
    for (const [index, content] of testCase.expectedContents.entries()) {
      if (!content)
        continue
      drafts.push({
        confidence: testCase.confidence,
        content,
        importance: 0.65,
        kind: testCase.sceneCategory.includes('偏好') ? 'preference' : 'fact',
        memoryId: `evaluation-${testCase.caseId}-${index + 1}`,
        status: 'active',
        tags: caseTags,
        title: `${testCase.caseId} · ${testCase.sceneSubType} · ${index + 1}`,
      })
    }
    for (const [index, content] of testCase.forbiddenContents.entries()) {
      if (!content)
        continue
      drafts.push({
        confidence: testCase.confidence,
        content,
        importance: 0.65,
        kind: testCase.sceneCategory.includes('偏好') ? 'preference' : 'fact',
        memoryId: `evaluation-${testCase.caseId}-f${index + 1}`,
        status: 'active',
        tags: [...caseTags, 'forbidden'],
        title: `${testCase.caseId} · ${testCase.sceneSubType} · f${index + 1}`,
      })
    }
  }
  return drafts
}

/**
 * Parses the long-term-memory evaluation dataset into per-case metadata.
 *
 * The query is the last `[user_assertion]` turn of the conversation flow, so
 * the lab can exercise the same short-term recall path a real chat would use.
 * Only golden targets with a concrete memory body are kept; descriptive
 * assertions such as "长期Canonical Fact中不应存在天气记录" are skipped.
 */
export function memoryEvaluationCasesFromDataset(input: unknown): MemoryEvaluationCase[] {
  if (!Array.isArray(input))
    throw new Error('Memory evaluation dataset must be a JSON array')

  return input.map(parseEvaluationCase)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalizes a human-readable golden target.
 *
 * Before:
 * - "预期召回: 喜欢红茶(positive)"
 *
 * After:
 * - "喜欢红茶(positive)"
 */
function normalizeExpectedMemory(value: string): string {
  return value.trim().replace(/^(?:预期本轮检索召回|预期召回)\s*[:：]\s*/, '').trim()
}

/**
 * Normalizes a forbidden golden target; descriptive statements that are not a
 * concrete memory body return null so they are neither imported nor asserted.
 *
 * Before:
 * - "禁止召回: 喜欢喝手冲咖啡(positive, active)"
 *
 * After:
 * - "喜欢喝手冲咖啡(positive, active)"
 */
function normalizeForbiddenMemory(value: string): null | string {
  const content = value.trim().replace(/^(?:禁止本轮检索召回|禁止召回)\s*[:：]\s*/, '').trim()
  if (!content || /不应|不存在|长期Canonical|作为Observation|只应|不允许|不得/.test(content))
    return null
  return content
}

function parseEvaluationCase(value: unknown, index: number): ParsedEvaluationCase {
  if (!isRecord(value))
    throw new Error(`Memory evaluation case ${index + 1} must be an object`)

  const goldenTruth = value.golden_truth
  if (!isRecord(goldenTruth))
    throw new Error(`Memory evaluation case ${index + 1} is missing golden_truth`)

  const caseId = requiredString(value.case_id, `case ${index + 1} case_id`)
  const sceneCategory = requiredString(value.scene_category, `case ${caseId} scene_category`)
  const sceneSubType = requiredString(value.scene_sub_type, `case ${caseId} scene_sub_type`)
  const expectedMemories = stringList(goldenTruth.should_recall_memory_ids, `case ${caseId} should_recall_memory_ids`)
  const forbiddenMemories = stringList(goldenTruth.must_not_recall_memory_ids, `case ${caseId} must_not_recall_memory_ids`)

  const confidence = Number(goldenTruth.confidence_baseline)
  const expectedContents = expectedMemories.map(normalizeExpectedMemory)
  const forbiddenContents = forbiddenMemories
    .map(normalizeForbiddenMemory)
    .filter((content): content is string => content !== null)

  return {
    caseId,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    expectedContents,
    expectedIds: expectedContents.map((_, itemIndex) => `evaluation-${caseId}-${itemIndex + 1}`),
    forbiddenContents,
    forbiddenIds: forbiddenContents.map((_, itemIndex) => `evaluation-${caseId}-f${itemIndex + 1}`),
    query: userQueryFromConversationFlow(value.conversation_flow),
    sceneCategory,
    sceneSubType,
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} is required`)
  return value.trim()
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string'))
    throw new Error(`${field} must be an array of strings`)
  return value
}

/** Returns the content of the last `[user_assertion]` turn, if any. */
function userQueryFromConversationFlow(flow: unknown): string {
  if (!Array.isArray(flow))
    return ''
  let query = ''
  for (const entry of flow) {
    if (typeof entry !== 'string')
      continue
    const match = entry.match(/\[user_assertion\]\s*([\s\S]*)/)
    if (match && match[1]?.trim())
      query = match[1]!.trim()
  }
  return query
}

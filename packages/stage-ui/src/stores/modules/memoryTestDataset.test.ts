import { describe, expect, it } from 'vitest'

import evaluationDataset from '../../../../../longttermmemorytest.json'

import { memoryDraftsFromEvaluationDataset, memoryEvaluationCasesFromDataset } from './memoryTestDataset'

describe('long-term memory evaluation dataset import', () => {
  it('converts the current 80-case dataset into stable canonical drafts', () => {
    const drafts = memoryDraftsFromEvaluationDataset(evaluationDataset)

    expect(new Set(drafts.map(draft => draft.memoryId)).size).toBe(drafts.length)
    expect(drafts[0]).toMatchObject({
      content: '喜欢红茶(positive)',
      memoryId: 'evaluation-001-1',
      status: 'active',
    })
  })

  it('imports forbidden memories alongside golden targets for leak measurement', () => {
    const drafts = memoryDraftsFromEvaluationDataset(evaluationDataset)
    const ids = drafts.map(draft => draft.memoryId)

    expect(ids).toContain('evaluation-001-1')
    expect(ids).toContain('evaluation-001-2')
    expect(ids).toContain('evaluation-001-f1')
    const forbiddenDraft = drafts.find(draft => draft.memoryId === 'evaluation-001-f1')
    expect(forbiddenDraft?.content).toBe('喜欢喝手冲咖啡(positive, active)')
    expect(forbiddenDraft?.tags).toContain('forbidden')
  })

  it('resolves golden targets to case queries and ids', () => {
    const cases = memoryEvaluationCasesFromDataset(evaluationDataset)
    const first = cases[0]!
    expect(first.caseId).toBe('001')
    expect(first.query).toBe('我现在因为胃不好，绝对不喝咖啡了，改喝红茶')
    expect(first.expectedIds).toEqual(['evaluation-001-1', 'evaluation-001-2'])
    expect(first.forbiddenIds).toEqual(['evaluation-001-f1'])
  })

  it('skips descriptive forbidden statements instead of importing them', () => {
    const cases = memoryEvaluationCasesFromDataset(evaluationDataset)
    // 005 的禁止项是描述句（"长期Canonical Fact中不应存在天气记录"），不应被导入
    const case005 = cases.find(caseItem => caseItem.caseId === '005')
    expect(case005?.forbiddenIds).toEqual([])
  })

  it('rejects malformed datasets before any database write occurs', () => {
    expect(() => memoryDraftsFromEvaluationDataset([{ case_id: 'broken' }])).toThrow('missing golden_truth')
  })
})

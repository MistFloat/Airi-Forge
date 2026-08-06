import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'

/** Runtime-only recall plan; it is audited with retrievals rather than persisted as user data. */
export interface MemoryRecallQuery {
  originalText: string
  terms: string[]
}

interface TermCandidate {
  index: number
  score: number
  text: string
}

const QUERY_POLICY_VERSION = 'recall-query-v1'
const MAX_TERMS = 4

// These product and project names occur frequently in AIRI memory. Loading
// them into the default dictionary prevents mixed Chinese/English brand names
// from being split differently between development machines.
const USER_DICTIONARY = [
  'AIRI 100000 nz',
  'MCP 100000 nz',
  'NAS 100000 nz',
  'Obsidian 100000 nz',
  'PostgreSQL 100000 nz',
  'pgvector 100000 nz',
  'Spotify 100000 nz',
  '绿联 100000 nz',
  '网易云音乐 100000 nz',
].join('\n')

const STOP_WORDS = new Set([
  'about',
  'does',
  'have',
  'how',
  'the',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  '一个',
  '一些',
  '东西',
  '为什么',
  '什么',
  '可以',
  '可能',
  '告诉',
  '哪些',
  '平常',
  '平时',
  '应该',
  '当前',
  '怎么',
  '怎样',
  '是否',
  '现在',
  '用户',
  '知道',
  '示例',
  '请问',
  '这个',
  '这里',
  '那个',
  '里面',
  '问题',
])

const NEGATION_PATTERN = /(?:不再|不用|不使用|不喜欢|不要|没有|没用|未使用|无)[\s会再]*(?:(?:使用|选择|接受|需要|喜欢|是|有)\s*)?(\p{Script=Han}{2,10}|[A-Z][A-Za-z0-9+.#-]*(?:\s+[A-Z][A-Za-z0-9+.#-]*){0,2})/gu
const BRAND_PATTERN = /\b(?:[A-Z]{2,}|[A-Z][a-z0-9+.#-]+)(?:\s+(?:[A-Z]{2,}|[A-Z][a-z0-9+.#-]+)){0,2}\b/g

const jieba = Jieba.withDict(dict)
jieba.loadDict(new TextEncoder().encode(USER_DICTIONARY))

/**
 * Reduces a natural user question to at most four semantic retrieval terms.
 * It never rewrites meaning with an LLM and keeps negation only with an object.
 */
export function planMemoryRecallQuery(input: string): MemoryRecallQuery {
  const originalText = input.trim()
  if (!originalText)
    return { originalText, terms: [] }

  const candidates: TermCandidate[] = []
  for (const match of originalText.matchAll(NEGATION_PATTERN)) {
    const object = match[1]?.trim()
    const phrase = match[0]?.trim()
    if (object && phrase && meaningful(object))
      candidates.push({ index: match.index ?? 0, score: 110, text: phrase })
  }
  for (const match of originalText.matchAll(BRAND_PATTERN)) {
    const brand = match[0].trim()
    if (meaningful(brand))
      candidates.push({ index: match.index ?? 0, score: 100, text: brand })
  }

  const tagged = jieba.tag(originalText, true)
  let cursor = 0
  const eligible = tagged.map((token) => {
    const index = originalText.indexOf(token.word, cursor)
    if (index >= 0)
      cursor = index + token.word.length
    return {
      eligible: eligiblePartOfSpeech(token.tag) && meaningful(token.word),
      index: Math.max(0, index),
      tag: token.tag,
      word: token.word.trim(),
    }
  })

  for (let index = 0; index < eligible.length; index++) {
    const token = eligible[index]!
    if (!token.eligible)
      continue
    candidates.push({ index: token.index, score: token.tag === 'eng' || token.tag === 'nz' ? 90 : 60, text: token.word })

    const next = eligible[index + 1]
    if (!next?.eligible)
      continue
    const phrase = `${token.word}${latinSeparator(token.word, next.word)}${next.word}`
    if (phrase.length <= 20)
      candidates.push({ index: token.index, score: 95, text: phrase })
  }

  const terms: string[] = []
  for (const candidate of candidates.sort((left, right) => right.score - left.score || left.index - right.index || right.text.length - left.text.length)) {
    const normalized = candidate.text.toLocaleLowerCase()
    if (terms.some(term => term.toLocaleLowerCase() === normalized))
      continue
    // Once a phrase is kept, its individual components add no retrieval
    // intent and would waste the four-term budget.
    if (terms.some(term => term.toLocaleLowerCase().includes(normalized)))
      continue
    terms.push(candidate.text)
    if (terms.length === MAX_TERMS)
      break
  }

  return { originalText, terms: terms.length > 0 ? terms : [originalText] }
}

/** The code-managed policy version attached to retrieval diagnostics. */
export function recallQueryPolicyVersion(): string {
  return QUERY_POLICY_VERSION
}

function eligiblePartOfSpeech(tag: string): boolean {
  return tag === 'eng' || tag === 'nz' || tag === 'an' || tag === 'vn' || tag.startsWith('n') || tag.startsWith('a')
}

function latinSeparator(left: string, right: string): '' | ' ' {
  return /[A-Z0-9]$/i.test(left) && /^[A-Z0-9]/i.test(right) ? ' ' : ''
}

function meaningful(value: string): boolean {
  const normalized = value.trim().toLocaleLowerCase()
  if (!normalized || STOP_WORDS.has(normalized))
    return false
  if (/^[\p{P}\p{S}\s]+$/u.test(normalized))
    return false
  if (/^\p{Script=Han}$/u.test(normalized))
    return false
  return normalized.length >= 2
}

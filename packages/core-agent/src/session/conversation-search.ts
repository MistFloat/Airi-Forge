import type { AgentSessionEvent } from './events'

/**
 * Offline text search over durable conversation messages.
 *
 * The searchable corpus is the append-only session log, so results stay
 * available without the renderer, the cloud session API, or an embedding
 * provider. Only `message.appended` events are searched: they carry exactly the
 * text a user or the assistant saw, which keeps results explainable.
 */

/** One matching message with enough context to show or cite it. */
export interface ConversationSearchHit {
  /** Timestamp of the append event. */
  createdAt: number
  /** Number of term occurrences used for ranking; higher means a stronger match. */
  matchCount: number
  /** Terms that matched, in query order. */
  matchedTerms: string[]
  /** Offset of the first matched term inside {@link snippet}. */
  matchIndex: number
  messageId: string
  role: 'assistant' | 'user'
  /** Durable event sequence, for stable ordering within one session. */
  sequence: number
  sessionId: string
  /** Bounded excerpt around the first match. */
  snippet: string
  turnId: string
}

/** Text search request over the durable conversation log. */
export interface ConversationSearchQuery {
  /**
   * Maximum number of hits returned, newest matches first after ranking.
   *
   * @default 20
   */
  limit?: number
  /**
   * Restrict matches to one session. Omit it to search every session.
   */
  sessionId?: string
  /**
   * Only consider messages appended at or after this epoch millisecond.
   */
  since?: number
  /**
   * Case-insensitive terms. A message matches only when it contains every term,
   * so a multi-word query behaves like an AND search instead of an OR.
   */
  terms: string[]
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const MAX_TERMS = 8
const SNIPPET_MAX_LENGTH = 240
const SNIPPET_RADIUS = 80
const SNIPPET_ELLIPSIS = '…'

/**
 * Normalizes a raw user query into the terms the matcher expects.
 *
 * Before:
 * - "vector   memory\nSearch"
 *
 * After:
 * - ["vector", "memory", "search"]
 */
export function buildConversationSearchTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const raw of query.split(/\s+/)) {
    const term = raw.trim().toLowerCase()
    if (term.length === 0)
      continue
    seen.add(term)
    if (seen.size >= MAX_TERMS)
      break
  }
  return [...seen]
}

/**
 * Searches durable conversation messages and ranks the matches.
 *
 * Ranking is deterministic: stronger matches (more term occurrences) come
 * first, then the most recent message, then the highest sequence, then the
 * session and message ids so equal candidates never reorder between runs.
 */
export function searchConversationMessages(
  events: readonly AgentSessionEvent[],
  query: ConversationSearchQuery,
): ConversationSearchHit[] {
  const terms = buildConversationSearchTerms(query.terms.join(' '))
  if (terms.length === 0)
    return []

  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)
  const hits: ConversationSearchHit[] = []

  for (const event of events) {
    if (event.type !== 'message.appended')
      continue
    if (query.sessionId !== undefined && event.sessionId !== query.sessionId)
      continue
    if (query.since !== undefined && event.occurredAt < query.since)
      continue

    const text = extractSearchableText(event.payload.message)
    if (text.length === 0)
      continue

    const haystack = text.toLowerCase()
    let matchCount = 0
    const matchedTerms: string[] = []
    let firstIndex = -1

    for (const term of terms) {
      const occurrences = countOccurrences(haystack, term)
      if (occurrences === 0)
        continue

      matchedTerms.push(term)
      matchCount += occurrences

      const index = haystack.indexOf(term)
      if (firstIndex === -1 || index < firstIndex)
        firstIndex = index
    }

    // Every term must appear, so a partial match is not a result at all.
    if (matchedTerms.length !== terms.length)
      continue

    const { matchIndex, snippet } = buildSnippet(text, firstIndex)
    hits.push({
      createdAt: event.occurredAt,
      matchCount,
      matchedTerms,
      matchIndex,
      messageId: event.payload.messageId,
      role: event.payload.role,
      sequence: event.sequence,
      sessionId: event.sessionId,
      snippet,
      turnId: event.payload.turnId,
    })
  }

  return hits.sort(compareHits).slice(0, limit)
}

/**
 * Builds the excerpt shown for one match.
 *
 * The window is centred on the first match and shifted when the match sits at
 * the end of the message, so a snippet never starts or ends mid-word for no
 * reason and always keeps the match visible.
 */
function buildSnippet(text: string, matchIndex: number): { matchIndex: number, snippet: string } {
  if (matchIndex < 0)
    return { matchIndex: 0, snippet: text.slice(0, SNIPPET_MAX_LENGTH) }

  let start = Math.max(0, matchIndex - SNIPPET_RADIUS)
  let end = Math.min(text.length, start + SNIPPET_MAX_LENGTH)
  if (end - start < SNIPPET_MAX_LENGTH)
    start = Math.max(0, end - SNIPPET_MAX_LENGTH)
  end = Math.min(text.length, start + SNIPPET_MAX_LENGTH)

  const prefix = start > 0 ? SNIPPET_ELLIPSIS : ''
  const suffix = end < text.length ? SNIPPET_ELLIPSIS : ''

  return {
    matchIndex: prefix.length + (matchIndex - start),
    snippet: `${prefix}${text.slice(start, end)}${suffix}`,
  }
}

function compareHits(left: ConversationSearchHit, right: ConversationSearchHit): number {
  if (left.matchCount !== right.matchCount)
    return right.matchCount - left.matchCount
  if (left.createdAt !== right.createdAt)
    return right.createdAt - left.createdAt
  if (left.sequence !== right.sequence)
    return right.sequence - left.sequence
  if (left.sessionId !== right.sessionId)
    return left.sessionId.localeCompare(right.sessionId)
  return left.messageId.localeCompare(right.messageId)
}

function countOccurrences(haystack: string, term: string): number {
  let count = 0
  let cursor = haystack.indexOf(term)
  while (cursor !== -1) {
    count += 1
    cursor = haystack.indexOf(term, cursor + term.length)
  }
  return count
}

/**
 * Reads the text a message contributed to the conversation.
 *
 * Assistant and user messages store their text in `content`; content-part
 * arrays contribute their text parts. Structured slices mirror that text, so
 * they are not searched separately.
 */
function extractSearchableText(message: unknown): string {
  if (message === null || typeof message !== 'object')
    return ''

  const content = (message as { content?: unknown }).content
  if (typeof content === 'string')
    return content

  if (!Array.isArray(content))
    return ''

  return content
    .map((part) => {
      if (typeof part === 'string')
        return part
      if (part !== null && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string')
        return (part as { text: string }).text
      return ''
    })
    .filter(text => text.length > 0)
    .join('\n')
}

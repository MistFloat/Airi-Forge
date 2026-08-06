/**
 * SEARCH/REPLACE edit application, ported from aider's editblock coder.
 *
 * Matching strategy chain (mirrors `aider/coders/search_replace.py`):
 *
 * 1. `perfectReplace`        — exact line-aligned match (most strict).
 * 2. `replaceWithMissingLeadingWhitespace` — tolerate missing indent on the
 *    search block (LLMs frequently drop leading whitespace).
 * 3. `replaceSkippingBlankLeadingLine`     — skip a single blank leading line
 *    the model inserted before the real search (aider issue #25).
 * 4. `replaceWithDotDotDots`               — honor `...` elision: anything
 *    between two `...` lines is treated as "skip any lines here".
 * 5. `replaceClosest`         — fuzzy match using bigram Jaccard similarity;
 *    reports the closest region in the failure message so the agent can
 *    self-correct (aider's reflection loop relies on this feedback).
 *
 * The chain is ordered strictest-first: if step N matches, we apply it and
 * return. Only when every step fails do we report `no-match` with a suggestion.
 * Multiple matches at step 1 are reported as `multiple-match` so the agent
 * can disambiguate by including more surrounding context, rather than the
 * server silently editing the wrong spot.
 *
 * Why strictness is preserved: aider's first-fuzzy-match policy occasionally
 * edits the wrong region in large files. This port keeps `multiple-match` as
 * a hard failure at the perfect-match step, and only relaxes to fuzzy at the
 * final step (where a single best match is unambiguous by score).
 */

export interface EditReplacementFailure {
  matches: number
  ok: false
  reason: 'multiple-match' | 'no-match'
  /**
   * Best-effort "did you mean" snippet from the file, for `no-match` failures.
   * Mirrors aider's `find_similar_lines` output.
   */
  suggestion?: string
}

export type EditReplacementResult = EditReplacementFailure | EditReplacementSuccess

export interface EditReplacementSuccess {
  content: string
  /** Which strategy produced the match, for diagnostics. */
  mode: 'replaced' | 'replaced-closest' | 'replaced-dotdotdots' | 'replaced-no-leading-ws' | 'replaced-skip-blank'
  ok: true
}

const DOTDOTDOTS = '...'

type EditChainResult
  = | { content: string, ok: true }
    | { matches: number, ok: false, reason: 'multiple-match' }
    | { ok: false, reason: 'no-match' }

/**
 * Finds the region of `content` most similar to `search` and returns it as a
 * snippet for "did you mean" feedback. Mirrors aider's `find_similar_lines`.
 */
export function findSimilarLines(search: string, content: string, threshold = 0.6): string | undefined {
  // Normalize like `replaceExact` so a trailing newline becomes part of the
  // last line instead of an extra empty line, which would shift the window.
  const searchLines = splitKeepEnds(prepText(search))
  const contentLines = splitKeepEnds(prepText(content))
  let bestRatio = 0
  let bestStart = -1
  let bestEnd = -1

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let total = 0
    for (let j = 0; j < searchLines.length; j++)
      total += lineSimilarity(searchLines[j], contentLines[i + j])
    const ratio = total / searchLines.length
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestStart = i
      bestEnd = i + searchLines.length
    }
  }

  if (bestRatio < threshold || bestStart < 0)
    return undefined

  // Exact first/last line match → the chunk itself is the suggestion.
  // Lines keep their trailing newline (splitKeepEnds), so join with ''.
  if (
    searchLines[0] === contentLines[bestStart]
    && searchLines.at(-1) === contentLines[bestEnd - 1]
  ) {
    return contentLines.slice(bestStart, bestEnd).join('')
  }

  // Otherwise widen the window with N lines of context so the agent can orient.
  const context = 5
  const start = Math.max(0, bestStart - context)
  const end = Math.min(contentLines.length, bestEnd + context)
  return contentLines.slice(start, end).join('')
}

/**
 * Applies a SEARCH/REPLACE replacement to `content` using the aider matching
 * chain. See module header for the strategy order and rationale.
 */
export function replaceExact(originalContent: string, search: string, replace: string): EditReplacementResult {
  const hadTrailingNewline = originalContent.endsWith('\n')

  // 1. Perfect match (strict, single-match required).
  const perfect = tryPerfect(originalContent, search, replace)
  if (perfect.ok)
    return finalize(perfect.content, 'replaced', hadTrailingNewline)
  if (perfect.reason === 'multiple-match')
    return { matches: perfect.matches, ok: false, reason: 'multiple-match' }

  // 2. Tolerate missing leading whitespace on the search block.
  const noLeadingWs = replaceWithMissingLeadingWhitespace(originalContent, search, replace)
  if (noLeadingWs.ok)
    return finalize(noLeadingWs.content, 'replaced-no-leading-ws', hadTrailingNewline)

  // 3. Skip a single blank leading line the model inserted before the real
  //    search block (aider issue #25 — GPT-4 frequently adds a stray newline).
  const skipBlank = replaceSkippingBlankLeadingLine(originalContent, search, replace)
  if (skipBlank.ok)
    return finalize(skipBlank.content, 'replaced-skip-blank', hadTrailingNewline)

  // 4. Honor `...` elision: any line that is exactly `...` matches zero or
  //    more arbitrary lines between its neighbors.
  const dotted = replaceWithDotDotDots(originalContent, search, replace)
  if (dotted.ok)
    return finalize(dotted.content, 'replaced-dotdotdots', hadTrailingNewline)

  // 5. Fuzzy: pick the single most similar region. We only accept it when
  //    the similarity is high enough to be unambiguous — otherwise we fall
  //    through to `no-match` with a suggestion, which is the safer failure
  //    mode (the agent retries with a corrected block).
  const closest = replaceClosest(originalContent, search, replace)
  if (closest.ok)
    return finalize(closest.content, 'replaced-closest', hadTrailingNewline)

  return {
    matches: 0,
    ok: false,
    reason: 'no-match',
    suggestion: findSimilarLines(search, originalContent),
  }
}

function applyMatch(contentLines: string[], searchLines: string[], replace: string, start: number): EditChainResult {
  const replaceLines = replace === '' ? [] : splitKeepEnds(prepText(replace))
  const next = [
    ...contentLines.slice(0, start),
    ...replaceLines,
    ...contentLines.slice(start + searchLines.length),
  ].join('')
  return { content: next, ok: true }
}

function canAlignDotDotDots(contentLines: string[], contentStart: number, searchLines: string[]): boolean {
  return consumeDotDotDotRegion(contentLines, contentStart, searchLines) !== -1
}

/**
 * Walks `searchLines` from `contentStart`, allowing each `...` line to consume
 * zero or more content lines. Returns the total number of content lines
 * consumed, or -1 if alignment fails before the search block ends.
 */
function consumeDotDotDotRegion(contentLines: string[], contentStart: number, searchLines: string[]): number {
  let ci = contentStart
  for (let si = 0; si < searchLines.length; si++) {
    const searchLine = searchLines[si]
    if (searchLine.trim() === DOTDOTDOTS) {
      // Consume zero or more content lines until the next search line matches
      // (or we run out of content). If this is the last search line, consume
      // the rest of the file is NOT allowed — `...` is "skip a chunk", not
      // "skip to EOF" — but trailing `...` is rare and harmless to treat as
      // "match zero lines here".
      if (si === searchLines.length - 1) {
        // trailing `...` — consume nothing
        continue
      }
      const nextSearch = searchLines[si + 1]
      while (ci < contentLines.length && contentLines[ci] !== nextSearch)
        ci++
      if (ci >= contentLines.length)
        return -1
      // Don't advance ci here — the next iteration matches it.
      continue
    }
    if (ci >= contentLines.length || contentLines[ci] !== searchLine)
      return -1
    ci++
  }
  return ci - contentStart
}

/**
 * Restores the original trailing-newline state of the file. The chain steps
 * above operate on normalized text, so the final result may have gained or
 * lost a trailing newline; this preserves the file's original convention.
 */
function finalize(content: string, mode: EditReplacementSuccess['mode'], hadTrailingNewline: boolean): EditReplacementSuccess {
  let result = content
  if (!hadTrailingNewline && result.endsWith('\n'))
    result = result.slice(0, -1)
  if (hadTrailingNewline && !result.endsWith('\n'))
    result = `${result}\n`
  return { content: result, mode, ok: true }
}

/**
 * Finds the start index in `contentLines` where the literal (non-`...`) lines
 * of `searchLines` align consecutively, allowing variable-width gaps at each
 * `...` line. Returns -1 if no alignment is possible.
 */
function findDotDotDotMatch(contentLines: string[], searchLines: string[]): number {
  // The first search line must be a literal anchor (we need a starting point).
  if (searchLines.length === 0 || searchLines[0].trim() === DOTDOTDOTS)
    return -1

  for (let i = 0; i <= contentLines.length - 1; i++) {
    if (canAlignDotDotDots(contentLines, i, searchLines))
      return i
  }
  return -1
}

function findExactMatches(contentLines: string[], searchLines: string[]): number[] {
  const matches: number[] = []
  const searchLength = searchLines.length
  if (searchLength === 0)
    return matches
  for (let i = 0; i <= contentLines.length - searchLength; i++) {
    let equal = true
    for (let j = 0; j < searchLength; j++) {
      if (contentLines[i + j] !== searchLines[j]) {
        equal = false
        break
      }
    }
    if (equal)
      matches.push(i)
  }
  return matches
}

/** Character-bigram Jaccard similarity between two lines, as a rough Levenshtein proxy. */
function lineSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++)
      set.add(s.slice(i, i + 2))
    return set
  }
  const ga = bigrams(a)
  const gb = bigrams(b)
  if (ga.size === 0 && gb.size === 0)
    return 1
  if (ga.size === 0 || gb.size === 0)
    return 0
  let intersection = 0
  for (const gram of ga) {
    if (gb.has(gram))
      intersection++
  }
  const union = ga.size + gb.size - intersection
  return union === 0 ? 1 : intersection / union
}

function longestCommonSubsequenceLength(a: string, b: string): number {
  // Standard LCS DP. Inputs are search chunks (typically <2KB), so the
  // O(n*m) cost is fine; we trade memory for clarity here.
  const m = a.length
  const n = b.length
  // Rolling rows to keep memory at O(min(m, n)).
  const short = m <= n ? a : b
  const long = m <= n ? b : a
  const shortLen = short.length
  const longLen = long.length
  let prev = Array.from<number>({ length: shortLen + 1 }).fill(0)
  let curr = Array.from<number>({ length: shortLen + 1 }).fill(0)
  for (let i = 1; i <= longLen; i++) {
    for (let j = 1; j <= shortLen; j++) {
      if (long[i - 1] === short[j - 1])
        curr[j] = prev[j - 1] + 1
      else
        curr[j] = Math.max(prev[j], curr[j - 1])
    }
    [prev, curr] = [curr, prev]
    curr.fill(0)
  }
  return prev[shortLen]
}

/** Normalizes CRLF and ensures a trailing newline so line comparisons are stable. */
function prepText(text: string): string {
  const normalized = text.replaceAll('\r\n', '\n')
  if (normalized.length === 0 || normalized.endsWith('\n'))
    return normalized
  return `${normalized}\n`
}

/**
 * Step 5 — fuzzy fallback. Picks the single most-similar region using a
 * SequenceMatcher-style ratio over the entire candidate chunk (not a per-line
 * average), mirroring aider's `replace_closest_edit`. Computing similarity
 * over the whole chunk matters: a per-line average would let one wrong line be
 * "averaged out" by identical neighbors, so changing `foo` to `bar` inside an
 * otherwise-identical function would wrongly match. Whole-chunk ratio keeps
 * the cost of any single differing line visible in the final score.
 *
 * The 0.95 threshold is stricter than aider's default 0.8 — we trade a little
 * recall for precision because the MCP server has no human in the loop to
 * catch a misapplied fuzzy match. A different identifier (`foo` vs `bar`)
 * produces a ratio around 0.9, which we deliberately reject; only near-perfect
 * matches with whitespace or formatting drift make it through. Below this
 * threshold, we report `no-match` with a suggestion and let the agent retry
 * with a corrected block.
 */
function replaceClosest(content: string, search: string, replace: string): EditChainResult {
  const contentLines = splitKeepEnds(prepText(content))
  const searchLines = splitKeepEnds(prepText(search))
  if (searchLines.length === 0 || contentLines.length < searchLines.length)
    return { ok: false, reason: 'no-match' }

  let bestRatio = 0
  let bestStart = -1
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const candidate = contentLines.slice(i, i + searchLines.length).join('')
    const ratio = sequenceRatio(searchLines.join(''), candidate)
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestStart = i
    }
  }

  if (bestStart < 0 || bestRatio < 0.95)
    return { ok: false, reason: 'no-match' }

  const replaceLines = replace === '' ? [] : splitKeepEnds(prepText(replace))
  const next = [
    ...contentLines.slice(0, bestStart),
    ...replaceLines,
    ...contentLines.slice(bestStart + searchLines.length),
  ].join('')

  return { content: next, ok: true }
}

/**
 * Step 3 — if the search block starts with a blank line that does not exist in
 * the file, drop it and retry the perfect match. Mirrors aider's handling of
 * the "GPT prepends a stray newline" pattern.
 */
function replaceSkippingBlankLeadingLine(content: string, search: string, replace: string): EditChainResult {
  const searchLines = splitKeepEnds(prepText(search))
  if (searchLines.length <= 1 || searchLines[0].trim() !== '')
    return { ok: false, reason: 'no-match' }

  const trimmedSearch = searchLines.slice(1).join('')
  return tryPerfect(content, trimmedSearch, replace)
}

/**
 * Step 4 — `...` elision. A search block may use a line that is exactly `...`
 * to mean "skip any number of lines here". We expand the pattern into a
 * line-aligned matcher that allows variable-width gaps between literal lines.
 *
 * Example:
 *   function foo() {
 *     ...
 *     return bar
 *   }
 * matches any function body ending in `return bar` inside a `function foo()` block.
 */
function replaceWithDotDotDots(content: string, search: string, replace: string): EditChainResult {
  const contentLines = splitKeepEnds(prepText(content))
  const searchLines = splitKeepEnds(prepText(search))

  if (!searchLines.some(line => line.trim() === DOTDOTDOTS))
    return { ok: false, reason: 'no-match' }

  const matchStart = findDotDotDotMatch(contentLines, searchLines)
  if (matchStart === -1)
    return { ok: false, reason: 'no-match' }

  const consumed = consumeDotDotDotRegion(contentLines, matchStart, searchLines)
  if (consumed === -1)
    return { ok: false, reason: 'no-match' }

  const replaceLines = replace === '' ? [] : splitKeepEnds(prepText(replace))
  const next = [
    ...contentLines.slice(0, matchStart),
    ...replaceLines,
    ...contentLines.slice(matchStart + consumed),
  ].join('')

  return { content: next, ok: true }
}

/**
 * Step 2 — retry with each search line's leading whitespace stripped from both
 * sides. Models commonly forget indentation when copying code into a SEARCH
 * block; this recovers the match without accepting wrong content.
 *
 * The early-out checks that stripping actually changed something on either
 * side — if both content and search already have no leading whitespace, this
 * strategy is a no-op and we fall through to the next step.
 */
function replaceWithMissingLeadingWhitespace(content: string, search: string, replace: string): EditChainResult {
  const contentLines = splitKeepEnds(prepText(content))
  const searchLines = splitKeepEnds(prepText(search))
  const strippedSearch = searchLines.map(stripLeadingWhitespace)
  const strippedContent = contentLines.map(stripLeadingWhitespace)

  const searchChanged = strippedSearch.some((line, i) => line !== searchLines[i])
  const contentChanged = strippedContent.some((line, i) => line !== contentLines[i])
  if (!searchChanged && !contentChanged)
    return { ok: false, reason: 'no-match' }

  const matches = findExactMatches(strippedContent, strippedSearch)
  if (matches.length !== 1)
    return { matches: matches.length, ok: false, reason: matches.length > 1 ? 'multiple-match' : 'no-match' }

  // Apply on the original (indented) content lines so indentation is preserved.
  return applyMatch(contentLines, searchLines, replace, matches[0])
}

/**
 * SequenceMatcher-style ratio between two strings: `2M / (len_a + len_b)`,
 * where `M` is the count of matching characters in the longest common
 * subsequence. This is the same formula Python's `difflib.SequenceMatcher`
 * uses, which is what aider calls for `replace_closest_edit`.
 */
function sequenceRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0)
    return 1
  if (a.length === 0 || b.length === 0)
    return 0
  const lcs = longestCommonSubsequenceLength(a, b)
  return (2 * lcs) / (a.length + b.length)
}

/** Splits text into lines that keep their trailing newline (`splitlines(keepends=True)`). */
function splitKeepEnds(text: string): string[] {
  return text.split(/(?<=\n)/)
}

/** Strips ASCII whitespace from the start of a line, preserving the trailing newline. */
function stripLeadingWhitespace(line: string): string {
  const trimmedStart = line.replace(/^\s+/, '')
  return trimmedStart
}

/**
 * Step 1 — exact line-aligned match. Requires a unique match; multiple matches
 * are reported as `multiple-match` so the agent can disambiguate.
 */
function tryPerfect(content: string, search: string, replace: string): EditChainResult {
  const contentLines = splitKeepEnds(prepText(content))
  const searchLines = splitKeepEnds(prepText(search))
  const matches = findExactMatches(contentLines, searchLines)
  if (matches.length === 0)
    return { ok: false, reason: 'no-match' }
  if (matches.length > 1)
    return { matches: matches.length, ok: false, reason: 'multiple-match' }
  return applyMatch(contentLines, searchLines, replace, matches[0])
}

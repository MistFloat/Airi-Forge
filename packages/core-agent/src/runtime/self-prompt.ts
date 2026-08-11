/**
 * Self-prompt capture for the AIRI self-generation loop.
 *
 * `instruction.md` defines a private channel: the final line of a reply, when
 * it starts with `//`, is NOT spoken to the user. Instead it is captured as a
 * "self prompt" — a question AIRI asks itself — and persisted so a future turn
 * can act on it. `\/\/` escapes the marker so `//` can still appear in spoken
 * text without triggering the loop.
 *
 * Rules (kept strict to avoid false positives such as URLs or comments):
 * - Only the text after the LAST newline of the reply can be a self prompt.
 * - That trailing line must start with `//` (and not `///`).
 * - `\/\/` at line start is an escaped marker: it renders as literal `//`.
 */

export const SELF_PROMPT_MARKER = '//'
export const SELF_PROMPT_ESCAPED_MARKER = '\\/\\/'

export interface SelfPromptCapture {
  /** Feeds one literal chunk into the capture buffer. Must be awaited to preserve stream order. */
  consume: (literal: string) => Promise<void>
  /** Finalizes the capture, flushing buffered text or yielding a captured self prompt. */
  finish: (options?: SelfPromptFinishOptions) => Promise<SelfPromptExtraction>
}

export interface SelfPromptExtraction {
  /** The captured self prompt (marker stripped, trimmed). Absent when the tail is not a self prompt. */
  prompt?: string
  /** Full text with the self prompt line removed (escape sequences resolved). */
  text: string
}

/** Controls whether a terminal stream state is trusted to create a self prompt. */
export interface SelfPromptFinishOptions {
  /**
   * Whether a valid trailing marker may be captured instead of rendered.
   * Set this to false for truncated, filtered, aborted, or failed streams.
   * @default true
   */
  allowCapture?: boolean
}

/**
 * Streaming wrapper around the final-line rule.
 *
 * A possible trailing `//` line is buffered and resolved when the stream ends:
 * - if it turns out to be a `//` self prompt, it is captured and never reaches
 *   the visible/TTS stream;
 * - otherwise it is flushed as normal spoken text.
 *
 * Ordinary lines are emitted as soon as their prefix proves they cannot be a
 * marker. This keeps single-line prose responsive and limits interruption loss
 * to an actual marker candidate.
 */
export function createSelfPromptCapture(
  onLiteral: (literal: string) => Promise<void> | void,
): SelfPromptCapture {
  let full = ''
  let emitted = 0

  function renderEscapedMarkers(text: string, startsAtLineBoundary: boolean): string {
    let rendered = text.replaceAll(`\n${SELF_PROMPT_ESCAPED_MARKER}`, `\n${SELF_PROMPT_MARKER}`)
    if (startsAtLineBoundary && rendered.startsWith(SELF_PROMPT_ESCAPED_MARKER))
      rendered = `${SELF_PROMPT_MARKER}${rendered.slice(SELF_PROMPT_ESCAPED_MARKER.length)}`
    return rendered
  }

  async function flushUpTo(index: number): Promise<void> {
    if (index <= emitted)
      return
    const startsAtLineBoundary = emitted === 0 || full.at(emitted - 1) === '\n'
    const chunk = renderEscapedMarkers(full.slice(emitted, index), startsAtLineBoundary)
    emitted = index
    await onLiteral(chunk)
  }

  function tailMayBeSelfPrompt(tail: string): boolean {
    if (!tail)
      return false
    if (SELF_PROMPT_MARKER.startsWith(tail))
      return true
    if (SELF_PROMPT_ESCAPED_MARKER.startsWith(tail))
      return true
    return tail.startsWith(SELF_PROMPT_MARKER)
      && !tail.startsWith(`${SELF_PROMPT_MARKER}/`)
  }

  return {
    async consume(literal) {
      full += literal
      // Everything before the last newline can never be part of the trailing
      // self-prompt line, so flush it immediately.
      const lastNewline = full.lastIndexOf('\n')
      if (lastNewline >= emitted)
        await flushUpTo(lastNewline + 1)

      const tail = full.slice(lastNewline + 1)
      if (!tailMayBeSelfPrompt(tail))
        await flushUpTo(full.length)
    },

    async finish(options) {
      const result = extractSelfPrompt(full)
      const allowCapture = options?.allowCapture ?? true
      if (!allowCapture || !result.prompt) {
        await flushUpTo(full.length)

        if (!allowCapture && result.prompt) {
          return {
            text: renderEscapedMarkers(full, true),
          }
        }
      }
      return result
    },
  }
}

/**
 * Parses the trailing self-prompt line out of a complete reply.
 *
 * Pure and side-effect free so it can be unit-tested and reused by any
 * consumer that receives the final full text.
 */
export function extractSelfPrompt(fullText: string): SelfPromptExtraction {
  const lastNewline = fullText.lastIndexOf('\n')
  const head = lastNewline < 0 ? '' : fullText.slice(0, lastNewline + 1)
  const tail = lastNewline < 0 ? fullText : fullText.slice(lastNewline + 1)

  // Escaped marker: render as literal `//` and keep as spoken text.
  if (tail.startsWith(SELF_PROMPT_ESCAPED_MARKER)) {
    return {
      text: `${head}${tail.replace(SELF_PROMPT_ESCAPED_MARKER, SELF_PROMPT_MARKER)}`,
    }
  }

  // Real marker: capture. `///` is rejected to avoid swallowing accidental
  // emphasis or comment-like text.
  if (tail.startsWith(SELF_PROMPT_MARKER) && !tail.startsWith(`${SELF_PROMPT_MARKER}/`)) {
    const prompt = tail.slice(SELF_PROMPT_MARKER.length).trim()
    if (!prompt)
      return { text: fullText }

    return {
      prompt,
      text: head,
    }
  }

  return { text: fullText }
}

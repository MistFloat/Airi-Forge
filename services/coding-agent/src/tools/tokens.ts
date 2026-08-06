import type { FileSession } from '../lib/session'
import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { readFile } from 'node:fs/promises'

import { estimateTokens } from '../lib/tokens'
import { resolveInWorkdir } from '../lib/workdir'
import { errorMessageFromValue, errorResult, textResult } from './types'

export interface ConventionsToolsContext {
  session?: FileSession
  workdir: Workdir
}

export interface CountTokensArgs {
  /**
   * When true and no `text` given, counts tokens for every file in the
   * session plus the rendered repo map (when available). Default true.
   */
  includeSession?: boolean
  /** Optional path hint for content-type detection (code vs prose ratio). */
  path?: string
  /**
   * When provided, count tokens for this explicit text instead of the
   * session files. Useful for "how big is this candidate edit block?".
   */
  text?: string
}

/**
 * Estimates token counts for either an explicit text blob or every file in
 * the session. Uses a character-based heuristic (~3.5 chars/token for code,
 * ~4.0 for prose) — see `lib/tokens.ts` for why we don't ship a real
 * tokenizer.
 *
 * The agent uses this to decide when to `drop_file` from the session to
 * stay under the model's context budget, or to estimate the cost of a
 * candidate edit before applying it.
 */
export async function countTokensTool(args: CountTokensArgs, ctx: ConventionsToolsContext): Promise<McpToolResult> {
  if (args.text !== undefined) {
    const estimate = estimateTokens(args.text, args.path)
    return textResult(`${estimate.tokens} tokens (~${estimate.chars} chars, ${estimate.charsPerToken} chars/token, ${estimate.kind})`, {
      chars: estimate.chars,
      charsPerToken: estimate.charsPerToken,
      kind: estimate.kind,
      tokens: estimate.tokens,
    })
  }

  const includeSession = args.includeSession ?? true
  if (!includeSession || !ctx.session) {
    return errorResult('count_tokens: either `text` or `includeSession: true` with an active session is required')
  }

  const entries = []
  let totalChars = 0
  let totalTokens = 0
  const snapshot = ctx.session.list()
  for (const entry of [...snapshot.editable, ...snapshot.readOnly]) {
    const resolved = resolveInWorkdir(ctx.workdir, entry.path)
    if (!resolved.ok) {
      entries.push({ chars: 0, path: entry.path, tokens: 0, unreadable: true })
      continue
    }
    let content: string
    try {
      content = await readFile(resolved.absolute, 'utf8')
    }
    catch (error) {
      entries.push({ error: errorMessageFromValue(error), path: entry.path })
      continue
    }
    const estimate = estimateTokens(content, entry.path)
    totalChars += estimate.chars
    totalTokens += estimate.tokens
    entries.push({ chars: estimate.chars, path: entry.path, tokens: estimate.tokens })
  }

  return textResult(
    [
      `session total: ${totalTokens} tokens (~${totalChars} chars)`,
      ...entries.map(e => `  ${e.path}: ${e.tokens} tokens (${e.chars} chars)`),
    ].join('\n'),
    { entries, totalChars, totalTokens },
  )
}

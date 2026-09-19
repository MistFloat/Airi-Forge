/**
 * Prompt-budget compaction for assembled provider messages.
 *
 * The orchestrator maps durable session history into the provider payload, and
 * long sessions eventually exceed what a model accepts. This module owns the
 * tiered policy that keeps the newest turns intact while making the older part
 * affordable:
 *
 * 1. older tool results are truncated to a fixed preview length,
 * 2. if that is not enough, everything before the recent-turn window collapses
 *    into one summary message,
 * 3. the system messages and the newest user turn are never touched.
 *
 * It is a pure function over already-assembled messages so the policy stays
 * testable and the orchestrator keeps owning transport concerns.
 */

/** Minimal shape the policy needs from an assembled provider message. */
export interface BudgetableMessage {
  content?: unknown
  role: string
}

/** Truncation and summarization budget for one provider request. */
export interface ContextBudgetOptions {
  /**
   * Approximate character budget for the assembled messages.
   *
   * Characters are used instead of tokenizer counts so the policy stays free
   * of model-specific dependencies; the default targets a ~32k token window
   * with room for the system prompt and the model output.
   *
   * @default 120000
   */
  maxCharacters?: number
  /**
   * Newest user turns always kept verbatim, together with their assistant and
   * tool messages.
   *
   * @default 6
   */
  recentTurnLimit?: number
  /**
   * Optional domain summary for the collapsed prefix. When omitted the policy
   * writes a deterministic line naming how much history was folded away.
   */
  summarize?: (input: { droppedMessages: number, droppedTurns: number }) => string
  /**
   * Character preview kept for tool results that fall outside the recent
   * window before they are replaced by a truncation marker.
   *
   * @default 240
   */
  toolResultCharacterLimit?: number
}

/** Outcome of one compaction pass, for telemetry and tests. */
export interface ContextBudgetStats {
  /** Characters in the input, after the policy. */
  charactersAfter: number
  /** Characters in the input, before the policy. */
  charactersBefore: number
  /** Messages folded into the summary message. */
  droppedMessages: number
  /** Turns folded into the summary message. */
  droppedTurns: number
  /** Tool results replaced by a truncation marker. */
  truncatedToolResults: number
}

/** Marker prefix for a tool result that was shortened to fit the budget. */
export const TOOL_RESULT_TRUNCATION_MARKER = '[truncated tool result]'

const DEFAULT_MAX_CHARACTERS = 120_000
const DEFAULT_RECENT_TURN_LIMIT = 6
const DEFAULT_TOOL_RESULT_CHARACTER_LIMIT = 240

/**
 * Applies the tiered prompt budget to assembled provider messages.
 *
 * Messages are returned unchanged when they already fit, so callers can apply
 * the policy unconditionally on the hot path.
 */
export function compactProviderMessages<TMessage extends BudgetableMessage>(
  messages: readonly TMessage[],
  options: ContextBudgetOptions = {},
): { messages: TMessage[], stats: ContextBudgetStats } {
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS
  const recentTurnLimit = options.recentTurnLimit ?? DEFAULT_RECENT_TURN_LIMIT
  const toolResultCharacterLimit = options.toolResultCharacterLimit ?? DEFAULT_TOOL_RESULT_CHARACTER_LIMIT

  const charactersBefore = countMessageCharacters(messages)
  const unchanged = {
    messages: [...messages],
    stats: {
      charactersAfter: charactersBefore,
      charactersBefore,
      droppedMessages: 0,
      droppedTurns: 0,
      truncatedToolResults: 0,
    },
  }

  if (charactersBefore <= maxCharacters)
    return unchanged

  // Tier 1: shorten the tool output that no longer belongs to the recent
  // window. Tool results are the largest messages and the ones the model can
  // re-request, so they are the cheapest thing to shrink first.
  const windowStart = findRecentWindowStart(messages, recentTurnLimit)
  let truncatedToolResults = 0
  const truncated = messages.map((message, index) => {
    if (index >= windowStart || message.role !== 'tool' || typeof message.content !== 'string')
      return message

    if (message.content.length <= toolResultCharacterLimit)
      return message

    truncatedToolResults += 1
    // NOTICE:
    // The spread preserves every provider-specific field of the original
    // message and only replaces `content`, which every budgetable message
    // accepts, but TypeScript cannot prove that for a generic element type.
    return {
      ...message,
      content: `${message.content.slice(0, toolResultCharacterLimit)}\n${TOOL_RESULT_TRUNCATION_MARKER}`,
    } as TMessage
  })

  if (countMessageCharacters(truncated) <= maxCharacters) {
    return {
      messages: truncated,
      stats: {
        charactersAfter: countMessageCharacters(truncated),
        charactersBefore,
        droppedMessages: 0,
        droppedTurns: 0,
        truncatedToolResults,
      },
    }
  }

  // Tier 2: collapse everything before the recent window into one summary
  // message. System messages and the newest user turn survive regardless of
  // the budget, because a request without them is not worth sending.
  const preserved = new Set<number>()
  for (const [index, message] of truncated.entries()) {
    if (message.role === 'system' || index >= windowStart)
      preserved.add(index)
  }
  const lastUserIndex = truncated.findLastIndex(message => message.role === 'user')
  if (lastUserIndex >= 0)
    preserved.add(lastUserIndex)

  const droppedIndexes = truncated
    .map((_message, index) => index)
    .filter(index => !preserved.has(index))
  const droppedTurns = droppedIndexes
    .filter(index => truncated[index]?.role === 'user')
    .length

  if (droppedIndexes.length === 0) {
    return {
      messages: truncated,
      stats: {
        charactersAfter: countMessageCharacters(truncated),
        charactersBefore,
        droppedMessages: 0,
        droppedTurns: 0,
        truncatedToolResults,
      },
    }
  }

  const summary = options.summarize?.({ droppedMessages: droppedIndexes.length, droppedTurns })
    ?? `Earlier conversation compacted: ${droppedTurns} user turn(s) and ${droppedIndexes.length} message(s) were folded out of the prompt to fit the context window.`

  const compacted: TMessage[] = []
  let summaryInserted = false
  for (const [index, message] of truncated.entries()) {
    if (!preserved.has(index)) {
      if (!summaryInserted) {
        // The summary reuses the first folded message's position and shape so
        // provider-specific fields survive; only text and role are replaced.
        compacted.push({ ...message, content: summary, role: 'system' } as TMessage)
        summaryInserted = true
      }
      continue
    }
    compacted.push(message)
  }

  return {
    messages: compacted,
    stats: {
      charactersAfter: countMessageCharacters(compacted),
      charactersBefore,
      droppedMessages: droppedIndexes.length,
      droppedTurns,
      truncatedToolResults,
    },
  }
}

/**
 * Approximate character weight of assembled messages.
 *
 * Counts string content and the text parts of content arrays. Parts without a
 * stable character weight (images, audio) contribute a small constant.
 */
export function countMessageCharacters(messages: readonly BudgetableMessage[]): number {
  return messages.reduce((total, message) => total + countCharacters(message), 0)
}

/**
 * Index of the first message inside the newest `recentTurnLimit` user turns.
 *
 * Returns 0 when the conversation is shorter than the window, which makes every
 * caller a no-op for short sessions.
 */
export function findRecentWindowStart(messages: readonly BudgetableMessage[], recentTurnLimit: number): number {
  if (recentTurnLimit <= 0)
    return messages.length

  let turns = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user')
      continue

    turns += 1
    if (turns >= recentTurnLimit)
      return index
  }

  return 0
}

function countCharacters(message: BudgetableMessage): number {
  let total = message.role.length
  const content = message.content

  if (typeof content === 'string') {
    total += content.length
  }
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        total += part.length
        continue
      }
      if (part !== null && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        total += part.text.length
        continue
      }
      // NOTICE: image/audio parts carry no stable character weight, so they are
      // counted as a small constant. Undercounting them is preferable to
      // dropping a turn the user can still see.
      total += 32
    }
  }

  return total
}

import type {
  AgentTurnListQuery,
  AgentTurnRecord,
  AgentTurnRecoveryAckInput,
  ChatHistoryItem,
} from '@proj-airi/core-agent'

/** Renderer/session dependencies needed for deterministic turn recovery. */
export interface ChatTurnRecoveryOptions {
  /** Closes recovery only after the reconstructed message is durable locally. */
  acknowledge: (input: AgentTurnRecoveryAckInput) => Promise<unknown>
  /** Appends and persists one reconstructed assistant message. */
  append: (sessionId: string, message: ChatHistoryItem) => Promise<void>
  /** Reads current history for idempotent message-ID deduplication. */
  getMessages: (sessionId: string) => ChatHistoryItem[]
  /** Reads unrecovered interrupted turns from the platform owner. */
  list: (query: AgentTurnListQuery) => Promise<AgentTurnRecord[]>
  /** Optional notification after a new message is restored. */
  onRecovered?: (message: ChatHistoryItem, record: AgentTurnRecord) => Promise<void> | void
  /** Optional lifecycle guard checked before each recovery mutation. */
  shouldContinue?: () => boolean
}

/**
 * Restores main-process user input and assistant checkpoints into one session.
 *
 * Acknowledgement follows the durable append. Re-running after a renderer
 * crash is safe because stable user and assistant message IDs are checked;
 * already-present messages are only acknowledged, never duplicated.
 */
export async function recoverInterruptedChatTurns(
  sessionId: string,
  options: ChatTurnRecoveryOptions,
): Promise<number> {
  const records = await options.list({ recoverableOnly: true, sessionId })
  let recoveredCount = 0

  for (const record of records) {
    if (options.shouldContinue && !options.shouldContinue())
      break

    const recoveredMessages: ChatHistoryItem[] = []
    const userAlreadyRestored = options.getMessages(sessionId).some(message => message.id === record.userMessageId)
    if (!userAlreadyRestored) {
      const userMessage = createRecoveredUserMessage(record)
      await options.append(sessionId, userMessage)
      recoveredMessages.push(userMessage)
      recoveredCount += 1
    }

    const checkpoint = record.checkpoint
    let recoveredAssistantMessage = checkpoint
      ? options.getMessages(sessionId).find(message => message.id === checkpoint.assistantMessageId)
      : undefined
    const assistantAlreadyRestored = checkpoint ? recoveredAssistantMessage !== undefined : true
    if (checkpoint && !assistantAlreadyRestored) {
      const assistantMessage = createRecoveredAssistantMessage(record)
      await options.append(sessionId, assistantMessage)
      recoveredAssistantMessage = assistantMessage
      recoveredMessages.push(assistantMessage)
      recoveredCount += 1
    }

    await options.acknowledge({
      ...(recoveredAssistantMessage ? { assistantMessage: recoveredAssistantMessage } : {}),
      sessionId,
      turnId: record.turnId,
    })
    for (const message of recoveredMessages)
      await options.onRecovered?.(message, record)
  }

  return recoveredCount
}

function createRecoveredAssistantMessage(record: AgentTurnRecord): ChatHistoryItem {
  const checkpoint = record.checkpoint
  if (!checkpoint)
    throw new Error(`Interrupted Agent turn ${record.turnId} has no recovery checkpoint`)

  return {
    categorization: {
      reasoning: checkpoint.reasoningText ?? '',
      speech: checkpoint.assistantText,
    },
    content: checkpoint.assistantText,
    createdAt: checkpoint.updatedAt,
    id: checkpoint.assistantMessageId,
    interrupted: true,
    role: 'assistant',
    slices: checkpoint.assistantText
      ? [{ text: checkpoint.assistantText, type: 'text' }]
      : [],
    tool_results: [],
  }
}

function createRecoveredUserMessage(record: AgentTurnRecord): ChatHistoryItem {
  return structuredClone(record.userMessage)
}

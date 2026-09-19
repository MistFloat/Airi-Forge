import type { ConversationSearchHit } from '@proj-airi/core-agent'
import type { Tool } from '@xsai/shared-chat'

import { buildConversationSearchTerms } from '@proj-airi/core-agent'
import { errorMessageFromValue } from '@proj-airi/stage-shared'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE, useConversationSearchStore } from '../stores/modules/conversation-search'

/**
 * Builds the model-facing conversation search tool.
 *
 * The durable conversation log lives in the Electron main process and survives
 * context compaction, so this tool is how the agent recalls something a user
 * said earlier without the raw history having to stay in the prompt.
 */
export async function conversationSearchTools(): Promise<Tool[]> {
  return await Promise.all([
    tool({
      description: 'Search earlier conversation messages by keywords. Use it to recall what was discussed before, including turns that were compacted out of the current context. All keywords must appear in a message for it to match.',
      execute: async ({ limit, query, sessionId }) => {
        const store = useConversationSearchStore()
        if (!store.hasTransport())
          return CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE

        const terms = buildConversationSearchTerms(query)
        if (terms.length === 0)
          return 'Provide at least one keyword to search for.'

        try {
          const hits = await store.search({
            ...(limit === undefined ? {} : { limit }),
            ...(sessionId === undefined ? {} : { sessionId }),
            terms,
          })
          return formatHits(hits, query)
        }
        catch (error) {
          return `Conversation search failed: ${errorMessageFromValue(error)}`
        }
      },
      name: 'built_in_conversationSearch',
      parameters: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of messages to return. Defaults to 20.'),
        query: z.string().min(1).describe('Keywords to look for, separated by spaces. Every keyword must appear in a matching message.'),
        sessionId: z.string().min(1).optional().describe('Restrict the search to one conversation. Omit it to search every conversation.'),
      }).strict(),
    }),
  ])
}

/** Renders hits as one dated line per message, newest-ranked first. */
function formatHits(hits: ConversationSearchHit[], query: string): string {
  if (hits.length === 0)
    return `No earlier messages matched "${query}".`

  const lines = [`Found ${hits.length} matching message(s) for "${query}":`]
  for (const hit of hits) {
    lines.push(`- ${formatTimestamp(hit.createdAt)} [${hit.role}] session ${hit.sessionId} (message ${hit.messageId}): ${hit.snippet}`)
  }
  return lines.join('\n')
}

function formatTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString()
}

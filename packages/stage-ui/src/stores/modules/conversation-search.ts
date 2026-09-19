import type { ConversationSearchHit, ConversationSearchQuery } from '@proj-airi/core-agent'

import { defineStore } from 'pinia'

/**
 * Platform transport that searches the durable conversation log.
 *
 * The Electron main process owns the log, so the renderer only issues queries
 * through this transport and never reads session storage directly.
 */
export interface ConversationSearchTransport {
  /** Searches durable conversation messages. */
  search: (query: ConversationSearchQuery) => Promise<ConversationSearchHit[]>
}

/**
 * Message surfaced when no platform search transport is installed.
 *
 * Shared by the store and the model-facing tool so both report the same
 * unavailability state instead of a silently empty result set.
 */
export const CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE = 'Conversation search is unavailable in this environment.'

let activeTransport: ConversationSearchTransport | undefined

/**
 * Installs the platform conversation-search transport with ownership-safe cleanup.
 *
 * The returned disposer only clears the transport when it is still the one this
 * call installed, so a newer owner is never clobbered by an older one.
 */
export function configureConversationSearchTransport(transport?: ConversationSearchTransport): () => void {
  activeTransport = transport
  return () => {
    if (activeTransport === transport)
      activeTransport = undefined
  }
}

/**
 * Renderer-side access to the durable conversation log.
 *
 * Results are returned to the caller instead of being cached in the store: the
 * only consumer today is a model-facing tool, and a stale cache would answer a
 * later question with earlier hits.
 */
export const useConversationSearchStore = defineStore('conversation-search', () => {
  /**
   * True when a platform transport is installed.
   *
   * Not reactive on purpose: the transport is module-level state, and callers
   * read it once per invocation.
   */
  function hasTransport(): boolean {
    return activeTransport !== undefined
  }

  /** Searches durable conversation messages, failing when no transport is installed. */
  async function search(query: ConversationSearchQuery): Promise<ConversationSearchHit[]> {
    if (!activeTransport)
      throw new Error(CONVERSATION_SEARCH_UNAVAILABLE_MESSAGE)
    return await activeTransport.search(query)
  }

  return {
    hasTransport,
    search,
  }
})

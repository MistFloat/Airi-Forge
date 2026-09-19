import type { ConversationSearchTransport } from '@proj-airi/stage-ui/stores/modules/conversation-search'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { configureConversationSearchTransport } from '@proj-airi/stage-ui/stores/modules/conversation-search'

import { electronAgentConversationSearch } from '../../shared/eventa/agent-runtime'

/**
 * Connects the renderer conversation search tool to the main-process log.
 *
 * Nothing is loaded up front: the durable conversation log stays in the main
 * process, and the renderer only issues queries when a tool call needs them.
 */
export function initializeAgentConversationSearchBridge(
  transport: ConversationSearchTransport = createEventaTransport(),
): () => void {
  return configureConversationSearchTransport(transport)
}

function createEventaTransport(): ConversationSearchTransport {
  const context = getElectronEventaContext()

  return {
    search: defineInvoke(context, electronAgentConversationSearch),
  }
}

import type { AgentSessionEvent, AgentSessionEventsQuery } from '@proj-airi/core-agent'
import type { ChatMessageSessionEventInput, ChatWritableSessionEventInput } from '@proj-airi/stage-ui/stores/chat-session-events'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import {
  configureChatSessionEventProjector,
  configureChatSessionEventReader,
  configureChatSessionEventWriter,
  configureChatSessionMessageImporter,
} from '@proj-airi/stage-ui/stores/chat-session-events'

import {
  electronAgentSessionEventAppend,
  electronAgentSessionEventsList,
  electronAgentSessionMessagesImport,
} from '../../shared/eventa/agent-runtime'

interface AgentSessionEventTransport {
  append: (input: ChatWritableSessionEventInput) => Promise<AgentSessionEvent>
  importMessages: (inputs: ChatMessageSessionEventInput[]) => Promise<AgentSessionEvent[]>
  list: (query: AgentSessionEventsQuery) => Promise<AgentSessionEvent[]>
}

/**
 * Connects the shared renderer runtime to the Electron-owned session log.
 *
 * Projection is serialized so the main process observes exactly the order in
 * which the local runtime emitted events. Reads wait for that queue to drain,
 * preventing an immediate query from observing a stale authoritative cursor.
 */
export function initializeAgentSessionEventBridge(
  transport: AgentSessionEventTransport = createEventaTransport(),
) {
  let projectionQueue = Promise.resolve()

  const append = (input: ChatWritableSessionEventInput) => {
    const pendingProjection = projectionQueue.then(async () => await transport.append(input))
    projectionQueue = pendingProjection.then(() => {}, () => {})
    return pendingProjection
  }

  const disposeProjector = configureChatSessionEventProjector((event) => {
    return append(toEventInput(event)).then(() => {})
  })

  const disposeWriter = configureChatSessionEventWriter(append)
  const disposeMessageImporter = configureChatSessionMessageImporter(transport.importMessages)

  const disposeReader = configureChatSessionEventReader(async (query) => {
    await projectionQueue
    return await transport.list(query)
  })

  return () => {
    disposeReader()
    disposeWriter()
    disposeMessageImporter()
    disposeProjector()
  }
}

function createEventaTransport(): AgentSessionEventTransport {
  const context = getElectronEventaContext()
  const append = defineInvoke(context, electronAgentSessionEventAppend)
  const list = defineInvoke(context, electronAgentSessionEventsList)
  const importMessages = defineInvoke(context, electronAgentSessionMessagesImport)

  return { append, importMessages, list }
}

function toEventInput(event: AgentSessionEvent): ChatWritableSessionEventInput {
  switch (event.type) {
    case 'memory.projected':
      return { payload: event.payload, sessionId: event.sessionId, type: event.type }
    case 'message.appended':
      return { payload: event.payload, sessionId: event.sessionId, type: event.type }
    case 'prompt.composed':
      return { payload: event.payload, sessionId: event.sessionId, type: event.type }
    default: {
      throw new Error(`Renderer runtime cannot append main-owned Agent event: ${event.type}`)
    }
  }
}

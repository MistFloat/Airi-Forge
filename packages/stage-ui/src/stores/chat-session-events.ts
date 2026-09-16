import type {
  AgentSessionEvent,
  AgentSessionEventInput,
  AgentSessionEventPort,
  AgentSessionEventsQuery,
} from '@proj-airi/core-agent'

import type { ChatHistoryItem } from '../types/chat'

import { AgentSessionEventLog } from '@proj-airi/core-agent'

/** Idempotent authored-message input accepted by the host event owner. */
export type ChatMessageSessionEventInput = Extract<ChatWritableSessionEventInput, { type: 'message.appended' }>

/** Projects renderer-owned runtime facts to a platform session-event owner. */
export type ChatSessionEventProjector = (event: AgentSessionEvent) => Promise<void> | void

/** Reads the authoritative session event stream owned by the host platform. */
export type ChatSessionEventReader = (query: AgentSessionEventsQuery) => Promise<AgentSessionEvent[]>

/** Appends one renderer-owned fact to the host event log. */
export type ChatSessionEventWriter = (input: ChatWritableSessionEventInput) => Promise<AgentSessionEvent>

/** Bulk import optimized for existing IndexedDB/cloud authored messages. */
export type ChatSessionMessageImporter = (inputs: ChatMessageSessionEventInput[]) => Promise<AgentSessionEvent[]>

/** Renderer facts accepted by the host-owned append-only session log. */
export type ChatWritableSessionEventInput = Extract<AgentSessionEventInput, {
  type: 'memory.projected' | 'message.appended' | 'prompt.composed' | 'visual.observed'
}>

let activeProjector: ChatSessionEventProjector | undefined
let activeReader: ChatSessionEventReader | undefined
let activeWriter: ChatSessionEventWriter | undefined
let activeMessageImporter: ChatSessionMessageImporter | undefined

/** Appends a renderer-owned fact when the platform exposes durable session events. */
export async function appendChatSessionEvent(input: ChatWritableSessionEventInput): Promise<AgentSessionEvent | undefined> {
  if (!activeWriter)
    return undefined

  try {
    return await commitChatSessionEvent(input)
  }
  catch (error) {
    // Perception and observability must not abort the user-facing model turn.
    console.error('Failed to append Agent session event:', error)
    return undefined
  }
}

/** Commits a renderer-owned fact and propagates durable-host failures. */
export async function commitChatSessionEvent(input: ChatWritableSessionEventInput): Promise<AgentSessionEvent | undefined> {
  if (!activeWriter)
    return undefined
  return await activeWriter(input)
}

/**
 * Installs the platform projector used by subsequently appended chat events.
 *
 * The returned disposer only removes the projector it installed, preventing a
 * stale desktop lifecycle from clearing a newer renderer bridge.
 */
export function configureChatSessionEventProjector(projector?: ChatSessionEventProjector) {
  activeProjector = projector

  return () => {
    if (activeProjector === projector)
      activeProjector = undefined
  }
}

/**
 * Installs the platform reader used by chat event queries.
 *
 * The returned disposer only removes the reader it installed, so stale
 * renderer cleanup cannot detach a newer desktop bridge.
 */
export function configureChatSessionEventReader(reader?: ChatSessionEventReader) {
  activeReader = reader

  return () => {
    if (activeReader === reader)
      activeReader = undefined
  }
}

/** Installs the platform writer used by perception and other renderer producers. */
export function configureChatSessionEventWriter(writer?: ChatSessionEventWriter) {
  activeWriter = writer

  return () => {
    if (activeWriter === writer)
      activeWriter = undefined
  }
}

/** Installs the host's one-flush bulk message importer. */
export function configureChatSessionMessageImporter(importer?: ChatSessionMessageImporter) {
  activeMessageImporter = importer
  return () => {
    if (activeMessageImporter === importer)
      activeMessageImporter = undefined
  }
}

/**
 * Creates the local event port used by the shared chat runtime.
 *
 * When a desktop projector exists, `append` resolves only after the host
 * commits the event. The web runtime keeps the in-memory synchronous path.
 * This makes model requests and tool side effects wait for their durable
 * admission facts without coupling the shared runtime to Electron.
 */
export function createChatSessionEventPort(): AgentSessionEventPort {
  const localLog = new AgentSessionEventLog()
  return {
    append(sessionId, type, payload) {
      const event = localLog.append(sessionId, type, payload)
      if (!activeProjector)
        return event

      return Promise.resolve(activeProjector(event as AgentSessionEvent)).then(() => event)
    },
    list: (sessionId, afterSequence) => localLog.list(sessionId, afterSequence),
  }
}

/** Converts existing authored history into stable, paired import events. */
export function createImportedMessageEvents(
  sessionId: string,
  messages: readonly ChatHistoryItem[],
  origin: 'cloud' | 'import',
): ChatMessageSessionEventInput[] {
  let currentTurnId: string | undefined
  return messages.flatMap((message) => {
    if (!message.id || (message.role !== 'assistant' && message.role !== 'user'))
      return []
    if (message.role === 'user' || !currentTurnId)
      currentTurnId = `import:${origin}:${message.id}`

    return [{
      payload: {
        message: structuredClone(message),
        messageId: message.id,
        origin,
        role: message.role,
        status: message.role === 'assistant' && message.interrupted ? 'interrupted' : 'complete',
        turnId: currentTurnId,
      },
      sessionId,
      type: 'message.appended',
    }]
  })
}

/** Imports authored messages before a renderer or cloud projection consumes them. */
export async function importChatSessionMessages(
  inputs: ChatMessageSessionEventInput[],
): Promise<AgentSessionEvent[]> {
  if (inputs.length === 0)
    return []
  if (activeMessageImporter)
    return await activeMessageImporter(inputs)

  const imported = await Promise.all(inputs.map(input => commitChatSessionEvent(input)))
  return imported.filter((event): event is AgentSessionEvent => event !== undefined)
}

/**
 * Reads platform-owned events while retaining a renderer-local fallback.
 *
 * Desktop IPC is an observability and recovery boundary, so a temporary main
 * process failure must not make session inspection fail completely.
 */
export async function readChatSessionEvents(
  query: AgentSessionEventsQuery,
  localFallback: AgentSessionEvent[],
): Promise<AgentSessionEvent[]> {
  if (!activeReader)
    return localFallback

  try {
    return await activeReader(query)
  }
  catch (error) {
    console.error('Failed to read Agent session events:', error)
    return localFallback
  }
}

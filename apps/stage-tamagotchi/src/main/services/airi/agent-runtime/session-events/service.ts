import type {
  AgentSessionEvent,
  AgentSessionEventInput,
  AgentSessionEventsQuery,
  AgentToolExecutionClaimInput,
  AgentToolExecutionClaimResult,
  AgentToolExecutionSettlementInput,
  ConversationSearchHit,
  ConversationSearchQuery,
} from '@proj-airi/core-agent'

import type { AgentSessionEventCompaction } from './repository'

import {
  AgentSessionEventLog,
  foldAgentToolExecutions,
  searchConversationMessages,
} from '@proj-airi/core-agent'

/** Persistence boundary owned by the Electron main process event service. */
export interface AgentSessionEventRepository {
  /** Persists one newly sequenced event. */
  append: (event: AgentSessionEvent) => void
  /** Moves memory-consumed closed segments into compressed cold storage. */
  compact: (input: AgentSessionEventCompaction) => Promise<AgentSessionEvent[]>
  /** Waits until every scheduled event append is durable. */
  flush: () => Promise<void>
  /** Loads the validated event snapshot during service startup. */
  load: () => AgentSessionEvent[]
}

/** Main-process API for accepting renderer facts and reading ordered sessions. */
export interface AgentSessionEventService {
  /** Assigns the authoritative timestamp and per-session sequence. */
  append: (input: AgentSessionEventInput) => AgentSessionEvent
  /** Atomically admits a new tool call or returns its existing durable state. */
  claimToolExecution: (input: AgentToolExecutionClaimInput) => Promise<AgentToolExecutionClaimResult>
  /** Waits until all preceding appends are durable. */
  flush: () => Promise<void>
  /** Reads one session after an optional cursor. */
  list: (query: AgentSessionEventsQuery) => AgentSessionEvent[]
  /** Reads the bounded resident replay set for main-process recovery. */
  listAll: () => AgentSessionEvent[]
  /** Searches durable conversation messages across every resident session. */
  searchConversations: (query: ConversationSearchQuery) => ConversationSearchHit[]
  /** Durably commits the outcome of one previously claimed tool call. */
  settleToolExecution: (input: AgentToolExecutionSettlementInput) => Promise<void>
  /** Subscribes to newly committed in-process events. */
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void
}

/** Dependencies for the main-process Agent session event service. */
export interface AgentSessionEventServiceOptions {
  /** Clock used for authoritative event timestamps. @default Date.now */
  now?: () => number
  /** Recent authored facts retained for renderer replay. @default 200 */
  recentMessageLimit?: number
  /** Main-process persistence repository. */
  repository: AgentSessionEventRepository
}

interface HotRetentionPolicy {
  recentMessageLimit: number
}

interface ToolExecutionState extends AgentToolExecutionClaimInput {
  durationMs?: number
  error?: string
  output?: AgentToolExecutionSettlementInput['output']
  status: 'completed' | 'failed' | 'running' | 'uncertain'
}

/**
 * Creates the main-process owner of Agent session event ordering.
 *
 * Renderer producers submit facts without timestamps or sequence numbers. The
 * service restores its last persisted cursor and assigns the next sequence,
 * so renderer reloads cannot reset or fork a session's event stream.
 */
export function createAgentSessionEventService(options: AgentSessionEventServiceOptions): AgentSessionEventService {
  const recentMessageLimit = positiveLimit(options.recentMessageLimit ?? 200, 'recent message')
  const listeners = new Set<(event: AgentSessionEvent) => void>()
  const initialEvents = options.repository.load()
  const pendingCompactions = new Map<string, number>()
  const messageEvents = new Map<string, Extract<AgentSessionEvent, { type: 'message.appended' }>>()
  const toolExecutions = new Map<string, ToolExecutionState>()
  for (const event of initialEvents) {
    applyToolExecutionEvent(toolExecutions, event)
    if (event.type === 'message.appended')
      messageEvents.set(messageEventKey(event.sessionId, event.payload.messageId), structuredClone(event))
    if (event.type === 'memory.projected')
      pendingCompactions.set(event.sessionId, Math.max(pendingCompactions.get(event.sessionId) ?? 0, event.payload.throughSequence))
  }
  const log = new AgentSessionEventLog({
    initialEvents,
    now: options.now,
    onAppend: (event) => {
      applyToolExecutionEvent(toolExecutions, event)
      if (event.type === 'message.appended')
        messageEvents.set(messageEventKey(event.sessionId, event.payload.messageId), structuredClone(event))
      if (event.type === 'memory.projected')
        pendingCompactions.set(event.sessionId, Math.max(pendingCompactions.get(event.sessionId) ?? 0, event.payload.throughSequence))
      options.repository.append(event)
      for (const listener of listeners)
        listener(structuredClone(event))
    },
  })
  let durabilityQueue = Promise.resolve()

  function append(input: AgentSessionEventInput): AgentSessionEvent {
    if (input.type === 'message.appended') {
      const existing = messageEvents.get(messageEventKey(input.sessionId, input.payload.messageId))
      if (existing)
        return structuredClone(existing)
    }
    switch (input.type) {
      case 'memory.projected':
        return log.append(input.sessionId, input.type, input.payload)
      case 'message.appended':
        return log.append(input.sessionId, input.type, input.payload)
      case 'prompt.composed':
        return log.append(input.sessionId, input.type, input.payload)
      case 'tool.call-reconciled':
        return log.append(input.sessionId, input.type, input.payload)
      case 'tool.call-settled':
        return log.append(input.sessionId, input.type, input.payload)
      case 'tool.call-started':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.admitted':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.cancellation-requested':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.checkpointed':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.closed':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.interrupted':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.recovery-acknowledged':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.settled':
        return log.append(input.sessionId, input.type, input.payload)
      case 'turn.started':
        return log.append(input.sessionId, input.type, input.payload)
      case 'visual.observed':
        return log.append(input.sessionId, input.type, input.payload)
      default: {
        const unexpectedInput: never = input
        throw new Error(`Unsupported Agent session event: ${String(unexpectedInput)}`)
      }
    }
  }

  function flush(): Promise<void> {
    const operation = durabilityQueue.then(async () => {
      await options.repository.flush()
      for (const [sessionId, requestedCursor] of [...pendingCompactions]) {
        const events = log.list(sessionId)
        const throughSequence = events.reduce((cursor, event) => {
          if (event.type !== 'memory.projected')
            return cursor
          return Math.max(cursor, event.payload.throughSequence)
        }, requestedCursor)
        const residentEvents = await options.repository.compact({
          retainedSequences: retainedHotSequences(events, throughSequence, {
            recentMessageLimit,
          }),
          sessionId,
          throughSequence,
        })
        log.replaceSession(sessionId, residentEvents)
        rebuildSessionDerivedState(sessionId, residentEvents, messageEvents, toolExecutions)
        if (pendingCompactions.get(sessionId) === requestedCursor)
          pendingCompactions.delete(sessionId)
      }
    })
    durabilityQueue = operation.catch(() => {})
    return operation
  }

  // Any call still marked running came from a process that can no longer
  // report its external outcome. Reconciliation is an explicit durable fact,
  // independent of whether the owning turn also needs startup interruption.
  for (const execution of [...toolExecutions.values()]) {
    if (execution.status !== 'running')
      continue
    append({
      payload: {
        callId: execution.callId,
        reason: 'host-restarted',
        status: 'uncertain',
        toolName: execution.toolName,
        turnId: execution.turnId,
      },
      sessionId: execution.sessionId,
      type: 'tool.call-reconciled',
    })
  }

  async function claimToolExecution(input: AgentToolExecutionClaimInput): Promise<AgentToolExecutionClaimResult> {
    const key = toolExecutionKey(input.sessionId, input.turnId, input.callId)
    const current = toolExecutions.get(key)
    if (current) {
      assertSameToolExecution(current, input)
      if (current.status === 'completed') {
        return {
          disposition: 'replay',
          ...(current.output === undefined ? {} : { output: structuredClone(current.output) }),
          status: current.status,
        }
      }
      if (current.status === 'failed') {
        return {
          disposition: 'replay',
          ...(current.error === undefined ? {} : { error: current.error }),
          status: current.status,
        }
      }
      return { disposition: 'blocked', status: current.status }
    }

    append({
      payload: {
        callId: input.callId,
        input: structuredClone(input.input),
        toolName: input.toolName,
        turnId: input.turnId,
      },
      sessionId: input.sessionId,
      type: 'tool.call-started',
    })
    await flush()
    return { disposition: 'execute' }
  }

  async function settleToolExecution(input: AgentToolExecutionSettlementInput): Promise<void> {
    const key = toolExecutionKey(input.sessionId, input.turnId, input.callId)
    const current = toolExecutions.get(key)
    if (!current)
      throw new Error(`Tool call ${input.callId} settled without admission in turn ${input.turnId}`)
    assertSameToolExecution(current, input)

    if (current.status === 'completed' || current.status === 'failed') {
      if (!isSameToolSettlement(current, input))
        throw new Error(`Tool call ${input.callId} changed its durable terminal result`)
      await flush()
      return
    }
    if (current.status !== 'running')
      throw new Error(`Tool call ${input.callId} cannot settle from ${current.status}`)

    append({
      payload: {
        callId: input.callId,
        durationMs: input.durationMs,
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.output === undefined ? {} : { output: structuredClone(input.output) }),
        status: input.status,
        toolName: input.toolName,
        turnId: input.turnId,
      },
      sessionId: input.sessionId,
      type: 'tool.call-settled',
    })
    await flush()
  }

  return {
    append,
    claimToolExecution,
    flush,
    list: query => log.list(query.sessionId, query.afterSequence),
    listAll: () => options.repository.load(),
    searchConversations: query => searchConversationMessages(options.repository.load(), query),
    settleToolExecution,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function applyToolExecutionEvent(executions: Map<string, ToolExecutionState>, event: AgentSessionEvent) {
  if (event.type === 'tool.call-started') {
    const key = toolExecutionKey(event.sessionId, event.payload.turnId, event.payload.callId)
    if (executions.has(key))
      throw new Error(`Tool call ${event.payload.callId} was admitted more than once in turn ${event.payload.turnId}`)
    executions.set(key, {
      callId: event.payload.callId,
      input: structuredClone(event.payload.input),
      sessionId: event.sessionId,
      status: 'running',
      toolName: event.payload.toolName,
      turnId: event.payload.turnId,
    })
    return
  }

  if (event.type === 'tool.call-settled') {
    const key = toolExecutionKey(event.sessionId, event.payload.turnId, event.payload.callId)
    const current = executions.get(key)
    if (!current || current.status !== 'running')
      throw new Error(`Tool call ${event.payload.callId} has an invalid settlement sequence`)
    if (current.toolName !== event.payload.toolName)
      throw new Error(`Tool call ${event.payload.callId} changed tool identity during settlement`)
    executions.set(key, {
      ...current,
      durationMs: event.payload.durationMs,
      ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
      ...(event.payload.output === undefined ? {} : { output: structuredClone(event.payload.output) }),
      status: event.payload.status,
    })
    return
  }

  if (event.type === 'tool.call-reconciled') {
    const key = toolExecutionKey(event.sessionId, event.payload.turnId, event.payload.callId)
    const current = executions.get(key)
    if (!current || current.status !== 'running')
      throw new Error(`Tool call ${event.payload.callId} has an invalid reconciliation sequence`)
    if (current.toolName !== event.payload.toolName)
      throw new Error(`Tool call ${event.payload.callId} changed tool identity during reconciliation`)
    executions.set(key, { ...current, status: event.payload.status })
    return
  }

  const terminalTurnId = event.type === 'turn.closed' || event.type === 'turn.interrupted'
    ? event.payload.turnId
    : undefined
  if (!terminalTurnId)
    return
  for (const [key, execution] of executions) {
    if (execution.sessionId === event.sessionId && execution.turnId === terminalTurnId && execution.status === 'running')
      executions.set(key, { ...execution, status: 'uncertain' })
  }
}

function assertSameToolExecution(current: ToolExecutionState, input: AgentToolExecutionClaimInput) {
  if (current.toolName !== input.toolName || JSON.stringify(current.input) !== JSON.stringify(input.input))
    throw new Error(`Tool call ${input.callId} changed identity across retries`)
}

function eventTurnId(event: AgentSessionEvent): string | undefined {
  switch (event.type) {
    case 'message.appended':
    case 'prompt.composed':
    case 'tool.call-reconciled':
    case 'tool.call-settled':
    case 'tool.call-started':
    case 'turn.admitted':
    case 'turn.cancellation-requested':
    case 'turn.closed':
    case 'turn.interrupted':
    case 'turn.recovery-acknowledged':
    case 'turn.settled':
    case 'turn.started':
      return event.payload.turnId
    case 'turn.checkpointed':
      return event.payload.checkpoint.turnId
    default:
      return undefined
  }
}

function isSameToolSettlement(current: ToolExecutionState, input: AgentToolExecutionSettlementInput): boolean {
  return current.durationMs === input.durationMs
    && current.error === input.error
    && JSON.stringify(current.output) === JSON.stringify(input.output)
    && current.status === input.status
}

function messageEventKey(sessionId: string, messageId: string): string {
  return `${sessionId}\u0000${messageId}`
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Agent session ${name} limit must be a positive safe integer`)
  return value
}

function rebuildSessionDerivedState(
  sessionId: string,
  events: readonly AgentSessionEvent[],
  messages: Map<string, Extract<AgentSessionEvent, { type: 'message.appended' }>>,
  executions: Map<string, ToolExecutionState>,
) {
  for (const [key, event] of messages) {
    if (event.sessionId === sessionId)
      messages.delete(key)
  }
  for (const [key, execution] of executions) {
    if (execution.sessionId === sessionId)
      executions.delete(key)
  }
  for (const event of events) {
    applyToolExecutionEvent(executions, event)
    if (event.type === 'message.appended')
      messages.set(messageEventKey(event.sessionId, event.payload.messageId), structuredClone(event))
  }
}

/**
 * Selects the bounded recovery checkpoint copied out of memory-consumed logs.
 *
 * Completed conversation details remain in compressed archives and semantic
 * memory. Resident facts are limited to current control snapshots, unresolved
 * side effects/turns, and explicit recent-history windows.
 */
function retainedHotSequences(
  events: readonly AgentSessionEvent[],
  throughSequence: number,
  policy: HotRetentionPolicy,
): number[] {
  const consumed = events.filter(event => event.sequence <= throughSequence)
  const retained = new Set<number>()

  for (const event of consumed.filter(event => event.type === 'message.appended').slice(-policy.recentMessageLimit))
    retained.add(event.sequence)

  const latestMemoryCursor = consumed.findLast(event => event.type === 'memory.projected')
  if (latestMemoryCursor)
    retained.add(latestMemoryCursor.sequence)

  const latestVisuals = new Map<string, Extract<AgentSessionEvent, { type: 'visual.observed' }>>()
  for (const event of consumed) {
    if (event.type === 'visual.observed')
      latestVisuals.set(event.payload.contextId, event)
  }
  for (const event of [...latestVisuals.values()].sort((left, right) => right.sequence - left.sequence).slice(0, 32))
    retained.add(event.sequence)

  const admittedTurns = new Set<string>()
  const terminalTurns = new Set<string>()
  const interruptedTurns = new Set<string>()
  const recoveredTurns = new Set<string>()
  for (const event of events) {
    if (event.type === 'turn.admitted')
      admittedTurns.add(event.payload.turnId)
    if (event.type === 'turn.closed' || event.type === 'turn.interrupted')
      terminalTurns.add(event.payload.turnId)
    if (event.type === 'turn.interrupted')
      interruptedTurns.add(event.payload.turnId)
    if (event.type === 'turn.recovery-acknowledged')
      recoveredTurns.add(event.payload.turnId)
  }

  const protectedTurnIds = new Set(
    [...admittedTurns].filter(turnId => !terminalTurns.has(turnId)),
  )
  for (const turnId of interruptedTurns) {
    if (!recoveredTurns.has(turnId))
      protectedTurnIds.add(turnId)
  }
  for (const execution of foldAgentToolExecutions(events)) {
    if (execution.status === 'running' || execution.status === 'uncertain')
      protectedTurnIds.add(execution.turnId)
  }

  for (const event of consumed) {
    const turnId = eventTurnId(event)
    if (turnId && protectedTurnIds.has(turnId))
      retained.add(event.sequence)
  }
  return [...retained].sort((left, right) => left - right)
}

function toolExecutionKey(sessionId: string, turnId: string, callId: string): string {
  return `${sessionId}\u0000${turnId}\u0000${callId}`
}

import type {
  AgentSessionEvent,
  AgentSessionEventInput,
  AgentTurnCancellationInput,
  AgentTurnCancellationNotice,
  AgentTurnCheckpointInput,
  AgentTurnInterruptionReason,
  AgentTurnListQuery,
  AgentTurnRecord,
  AgentTurnRecoveryAckInput,
  AgentTurnSettlementInput,
  AgentTurnStartInput,
  AgentTurnStatusQuery,
} from '@proj-airi/core-agent'

/** Cancellation transition returned before exact renderer notices are emitted. */
export interface AgentTurnCancellationResult {
  /** Correlated notices for renderer execution adapters. */
  notices: AgentTurnCancellationNotice[]
  /** Durable records that now carry the cancellation request. */
  records: AgentTurnRecord[]
}

/** Append-only event boundary owned by the Electron main process. */
export interface AgentTurnEventStore {
  /** Appends one authoritative session fact. */
  append: (input: AgentSessionEventInput) => AgentSessionEvent
  /** Waits until every scheduled event append is durable. */
  flush: () => Promise<void>
  /** Loads the bounded resident event source during startup replay. */
  listAll: () => AgentSessionEvent[]
}

/** Main-process state machine for durable Agent turns. */
export interface AgentTurnRunner {
  /** Marks one interrupted checkpoint as restored in chat history. */
  acknowledgeRecovery: (input: AgentTurnRecoveryAckInput) => Promise<AgentTurnRecord>
  /** Replaces the latest recoverable visible assistant prefix. */
  checkpoint: (input: AgentTurnCheckpointInput, ownerId: string) => AgentTurnRecord
  /** Repairs every active turn owned by a detached renderer. */
  interruptOwner: (ownerId: string, reason: AgentTurnInterruptionReason) => Promise<AgentTurnRecord[]>
  /** Lists durable turns matching the supplied filters. */
  list: (query: AgentTurnListQuery) => AgentTurnRecord[]
  /** Durably enters cancelling before renderer abort notices are emitted. */
  requestCancellation: (input: AgentTurnCancellationInput) => Promise<AgentTurnCancellationResult>
  /** Durably closes a turn after renderer execution converges. */
  settle: (input: AgentTurnSettlementInput, ownerId: string) => Promise<AgentTurnRecord>
  /** Durably reserves main-process ownership before provider dispatch. */
  start: (input: AgentTurnStartInput, ownerId: string) => Promise<AgentTurnRecord>
  /** Reads one exact turn or the latest turn for a session. */
  status: (query: AgentTurnStatusQuery) => AgentTurnRecord | undefined
}

/** Dependencies for the main-process Agent turn runner. */
export interface AgentTurnRunnerOptions {
  /** Authoritative append-only session log. */
  eventStore: AgentTurnEventStore
}

/**
 * Creates and repairs the authoritative Agent turn state machine.
 *
 * Startup is asynchronous because every previously active record is closed as
 * interrupted and flushed before a new renderer is allowed to query recovery.
 */
export async function createAgentTurnRunner(options: AgentTurnRunnerOptions): Promise<AgentTurnRunner> {
  const records = new Map<string, AgentTurnRecord>()
  let repairedOnStartup = false

  const persistedEvents = options.eventStore.listAll()
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence)
  for (const event of persistedEvents)
    applyTurnEvent(records, event)

  for (const record of [...records.values()]) {
    if (!isActive(record))
      continue
    appendEvent(record.sessionId, 'turn.interrupted', {
      reason: 'host-restarted',
      turnId: record.turnId,
    })
    repairedOnStartup = true
  }

  if (repairedOnStartup)
    await options.eventStore.flush()

  async function start(input: AgentTurnStartInput, ownerId: string): Promise<AgentTurnRecord> {
    const key = recordKey(input.sessionId, input.turnId)
    const existing = records.get(key)
    if (existing) {
      if (isSameAdmission(existing, input, ownerId) && isActive(existing)) {
        await options.eventStore.flush()
        return cloneRecord(existing)
      }
      throw new Error(`Agent turn ${input.turnId} already exists with different ownership or state`)
    }

    const activeSessionTurn = [...records.values()].find(record => record.sessionId === input.sessionId && isActive(record))
    if (activeSessionTurn)
      throw new Error(`Agent session ${input.sessionId} already has active turn ${activeSessionTurn.turnId}`)

    if (input.userMessage.role !== 'user' || input.userMessage.id !== input.userMessageId)
      throw new Error(`Agent turn ${input.turnId} has an invalid user message admission`)

    appendEvent(input.sessionId, 'turn.admitted', {
      ...structuredClone(input),
      ownerId,
    })
    options.eventStore.append({
      payload: {
        message: structuredClone(input.userMessage),
        messageId: input.userMessageId,
        role: 'user',
        status: 'complete',
        turnId: input.turnId,
      },
      sessionId: input.sessionId,
      type: 'message.appended',
    })
    await options.eventStore.flush()
    return cloneRecord(requireRecord(input.sessionId, input.turnId))
  }

  function checkpoint(input: AgentTurnCheckpointInput, ownerId: string): AgentTurnRecord {
    const current = requireOwnedActiveRecord(input.sessionId, input.turnId, ownerId)
    if (current.assistantMessageId !== input.assistantMessageId)
      throw new Error(`Assistant message does not match Agent turn ${input.turnId}`)

    appendEvent(input.sessionId, 'turn.checkpointed', {
      checkpoint: {
        ...structuredClone(input),
        revision: (current.checkpoint?.revision ?? 0) + 1,
      },
    })
    return cloneRecord(requireRecord(input.sessionId, input.turnId))
  }

  async function settle(input: AgentTurnSettlementInput, ownerId: string): Promise<AgentTurnRecord> {
    const current = requireRecord(input.sessionId, input.turnId)
    requireOwner(current, ownerId)

    if (!isActive(current)) {
      if (current.status === input.status) {
        await options.eventStore.flush()
        return cloneRecord(current)
      }
      // The main process closes a turn as interrupted when its renderer
      // detaches (did-start-loading, render-process-gone, destroyed) or the
      // host restarts. A renderer that survives the navigation race can still
      // converge its failed/cancelled settlement afterwards. The visible
      // assistant prefix is already durable through turn.checkpointed events
      // and the recovery flow, so converging instead of throwing keeps the
      // original stream failure observable instead of masking it behind this
      // state-machine guard.
      if (current.status === 'interrupted' && (input.status === 'failed' || input.status === 'cancelled')) {
        await options.eventStore.flush()
        return cloneRecord(current)
      }
      throw new Error(`Agent turn ${input.turnId} is already terminal with status ${current.status}`)
    }

    const hasAssistantMessage = input.assistantMessage !== undefined
    if (hasAssistantMessage !== (input.assistantMessageStatus !== undefined))
      throw new Error(`Agent turn ${input.turnId} must provide assistantMessage and assistantMessageStatus together`)
    if (input.assistantMessage) {
      if (input.assistantMessage.role !== 'assistant' || input.assistantMessage.id !== current.assistantMessageId)
        throw new Error(`Agent turn ${input.turnId} has an invalid assistant settlement message`)
      options.eventStore.append({
        payload: {
          message: structuredClone(input.assistantMessage),
          messageId: current.assistantMessageId,
          role: 'assistant',
          status: input.assistantMessageStatus ?? 'interrupted',
          turnId: input.turnId,
        },
        sessionId: input.sessionId,
        type: 'message.appended',
      })
    }

    appendEvent(input.sessionId, 'turn.closed', {
      ...(input.finishReason === undefined ? {} : { finishReason: input.finishReason }),
      status: input.status,
      turnId: input.turnId,
    })
    await options.eventStore.flush()
    return cloneRecord(requireRecord(input.sessionId, input.turnId))
  }

  async function requestCancellation(input: AgentTurnCancellationInput): Promise<AgentTurnCancellationResult> {
    const matching = [...records.values()].filter(record => (
      isActive(record)
      && (input.sessionId === undefined || record.sessionId === input.sessionId)
      && (input.turnId === undefined || record.turnId === input.turnId)
    ))
    const changed: AgentTurnRecord[] = []
    const selected: AgentTurnRecord[] = []

    for (const current of matching) {
      if (current.status === 'cancelling') {
        selected.push(current)
        continue
      }

      appendEvent(current.sessionId, 'turn.cancellation-requested', {
        reason: input.reason,
        turnId: current.turnId,
      })
      const record = requireRecord(current.sessionId, current.turnId)
      changed.push(record)
      selected.push(record)
    }

    if (changed.length > 0)
      await options.eventStore.flush()

    return {
      notices: selected.map(record => ({
        reason: record.cancellationReason ?? input.reason,
        sessionId: record.sessionId,
        turnId: record.turnId,
      })),
      records: selected.map(cloneRecord),
    }
  }

  async function interruptOwner(ownerId: string, reason: AgentTurnInterruptionReason): Promise<AgentTurnRecord[]> {
    const interrupted: AgentTurnRecord[] = []
    for (const current of records.values()) {
      if (current.ownerId !== ownerId || !isActive(current))
        continue

      appendEvent(current.sessionId, 'turn.interrupted', {
        reason,
        turnId: current.turnId,
      })
      interrupted.push(requireRecord(current.sessionId, current.turnId))
    }

    if (interrupted.length > 0)
      await options.eventStore.flush()
    return interrupted.map(cloneRecord)
  }

  function status(query: AgentTurnStatusQuery): AgentTurnRecord | undefined {
    if (query.turnId)
      return cloneOptionalRecord(records.get(recordKey(query.sessionId, query.turnId)))

    const latest = [...records.values()]
      .filter(record => record.sessionId === query.sessionId)
      .sort((left, right) => right.startedAt - left.startedAt)[0]
    return cloneOptionalRecord(latest)
  }

  function list(query: AgentTurnListQuery): AgentTurnRecord[] {
    return [...records.values()]
      .filter((record) => {
        if (query.sessionId !== undefined && record.sessionId !== query.sessionId)
          return false
        if (query.statuses !== undefined && !query.statuses.includes(record.status))
          return false
        if (query.recoverableOnly)
          return record.status === 'interrupted' && record.recoveredAt === undefined
        return true
      })
      .sort((left, right) => left.startedAt - right.startedAt)
      .map(cloneRecord)
  }

  async function acknowledgeRecovery(input: AgentTurnRecoveryAckInput): Promise<AgentTurnRecord> {
    const current = requireRecord(input.sessionId, input.turnId)
    if (current.status !== 'interrupted')
      throw new Error(`Agent turn ${input.turnId} is not interrupted`)
    if (current.recoveredAt !== undefined) {
      await options.eventStore.flush()
      return cloneRecord(current)
    }

    if (input.assistantMessage) {
      if (input.assistantMessage.role !== 'assistant' || input.assistantMessage.id !== current.assistantMessageId)
        throw new Error(`Agent turn ${input.turnId} has an invalid recovered assistant message`)
      options.eventStore.append({
        payload: {
          message: structuredClone(input.assistantMessage),
          messageId: current.assistantMessageId,
          role: 'assistant',
          status: 'interrupted',
          turnId: input.turnId,
        },
        sessionId: input.sessionId,
        type: 'message.appended',
      })
    }

    appendEvent(input.sessionId, 'turn.recovery-acknowledged', {
      turnId: input.turnId,
    })
    await options.eventStore.flush()
    return cloneRecord(requireRecord(input.sessionId, input.turnId))
  }

  function appendEvent<TType extends Extract<AgentSessionEvent['type'], `turn.${string}`>>(
    sessionId: string,
    type: TType,
    payload: Extract<AgentSessionEventInput, { type: TType }>['payload'],
  ) {
    const event = options.eventStore.append({ payload, sessionId, type } as AgentSessionEventInput)
    applyTurnEvent(records, event)
  }

  function requireRecord(sessionId: string, turnId: string): AgentTurnRecord {
    const record = records.get(recordKey(sessionId, turnId))
    if (!record)
      throw new Error(`Unknown Agent turn ${turnId} in session ${sessionId}`)
    return record
  }

  function requireOwnedActiveRecord(sessionId: string, turnId: string, ownerId: string): AgentTurnRecord {
    const record = requireRecord(sessionId, turnId)
    requireOwner(record, ownerId)
    if (!isActive(record))
      throw new Error(`Agent turn ${turnId} is already terminal with status ${record.status}`)
    return record
  }

  return {
    acknowledgeRecovery,
    checkpoint,
    interruptOwner,
    list,
    requestCancellation,
    settle,
    start,
    status,
  }
}

function applyTurnEvent(records: Map<string, AgentTurnRecord>, event: AgentSessionEvent) {
  switch (event.type) {
    case 'turn.admitted': {
      const payload = event.payload
      records.set(recordKey(event.sessionId, payload.turnId), {
        ...structuredClone(payload),
        startedAt: event.occurredAt,
        status: 'running',
        updatedAt: event.occurredAt,
      })
      break
    }
    case 'turn.cancellation-requested': {
      const current = requireProjectedRecord(records, event.sessionId, event.payload.turnId)
      records.set(recordKey(event.sessionId, current.turnId), {
        ...current,
        cancellationReason: event.payload.reason,
        status: 'cancelling',
        updatedAt: event.occurredAt,
      })
      break
    }
    case 'turn.checkpointed': {
      const checkpoint = {
        ...structuredClone(event.payload.checkpoint),
        updatedAt: event.occurredAt,
      }
      const current = requireProjectedRecord(records, event.sessionId, checkpoint.turnId)
      records.set(recordKey(event.sessionId, current.turnId), {
        ...current,
        checkpoint,
        updatedAt: event.occurredAt,
      })
      break
    }
    case 'turn.closed': {
      const current = requireProjectedRecord(records, event.sessionId, event.payload.turnId)
      records.set(recordKey(event.sessionId, current.turnId), {
        ...current,
        ...(event.payload.finishReason === undefined ? {} : { finishReason: event.payload.finishReason }),
        settledAt: event.occurredAt,
        status: event.payload.status,
        updatedAt: event.occurredAt,
      })
      break
    }
    case 'turn.interrupted': {
      const current = requireProjectedRecord(records, event.sessionId, event.payload.turnId)
      records.set(recordKey(event.sessionId, current.turnId), {
        ...current,
        interruptionReason: event.payload.reason,
        settledAt: event.occurredAt,
        status: 'interrupted',
        updatedAt: event.occurredAt,
      })
      break
    }
    case 'turn.recovery-acknowledged': {
      const current = requireProjectedRecord(records, event.sessionId, event.payload.turnId)
      records.set(recordKey(event.sessionId, current.turnId), {
        ...current,
        recoveredAt: event.occurredAt,
        updatedAt: event.occurredAt,
      })
      break
    }
  }
}

function cloneOptionalRecord(record: AgentTurnRecord | undefined): AgentTurnRecord | undefined {
  return record === undefined ? undefined : cloneRecord(record)
}

function cloneRecord(record: AgentTurnRecord): AgentTurnRecord {
  return structuredClone(record)
}

function isActive(record: AgentTurnRecord): boolean {
  return record.status === 'cancelling' || record.status === 'running'
}

function isSameAdmission(record: AgentTurnRecord, input: AgentTurnStartInput, ownerId: string): boolean {
  return record.assistantMessageId === input.assistantMessageId
    && record.ownerId === ownerId
    && record.sessionId === input.sessionId
    && record.source === input.source
    && record.turnId === input.turnId
    && JSON.stringify(record.userMessage) === JSON.stringify(input.userMessage)
    && record.userMessageId === input.userMessageId
    && record.userText === input.userText
}

function recordKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`
}

function requireOwner(record: AgentTurnRecord, ownerId: string) {
  if (record.ownerId !== ownerId)
    throw new Error(`Agent turn ${record.turnId} owner mismatch`)
}

function requireProjectedRecord(
  records: Map<string, AgentTurnRecord>,
  sessionId: string,
  turnId: string,
): AgentTurnRecord {
  const record = records.get(recordKey(sessionId, turnId))
  if (!record)
    throw new Error(`Turn event ${turnId} has no preceding admission in session ${sessionId}`)
  return record
}

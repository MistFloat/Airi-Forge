import type { AgentSessionEvent, AgentSessionJsonValue } from './events'

/** Durable view of one model-requested tool execution. */
export interface AgentToolExecutionProjection {
  /** Provider-issued call identity scoped to the owning turn. */
  callId: string
  /** Tool wall-clock duration when settlement was observed. */
  durationMs?: number
  /** Failure retained for diagnostics and retry policy. */
  error?: string
  /** Parsed input committed before the tool side effect started. */
  input: AgentSessionJsonValue
  /** Result committed after a normal return. */
  output?: AgentSessionJsonValue
  /** Session that owns this execution. */
  sessionId: string
  /** Current durable lifecycle, including crash uncertainty. */
  status: 'completed' | 'failed' | 'running' | 'uncertain'
  /** Tool name selected by the model. */
  toolName: string
  /** Turn that owns the call. */
  turnId: string
}

/**
 * Reconstructs the tool execution ledger from one ordered session log.
 *
 * A call left running when its turn becomes terminal is marked `uncertain`.
 * Recovery policy must never silently execute that side effect again because
 * the external operation may have completed before the renderer disappeared.
 */
export function foldAgentToolExecutions(events: readonly AgentSessionEvent[]): AgentToolExecutionProjection[] {
  const executions = new Map<string, AgentToolExecutionProjection>()

  for (const event of events) {
    if (event.type === 'tool.call-started') {
      const key = executionKey(event.payload.turnId, event.payload.callId)
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
      continue
    }

    if (event.type === 'tool.call-reconciled') {
      const key = executionKey(event.payload.turnId, event.payload.callId)
      const current = executions.get(key)
      if (!current || current.status !== 'running')
        throw new Error(`Tool call ${event.payload.callId} has an invalid reconciliation sequence`)
      if (current.toolName !== event.payload.toolName)
        throw new Error(`Tool call ${event.payload.callId} changed tool identity during reconciliation`)
      executions.set(key, { ...current, status: event.payload.status })
      continue
    }

    if (event.type === 'tool.call-settled') {
      const key = executionKey(event.payload.turnId, event.payload.callId)
      const current = executions.get(key)
      if (!current)
        throw new Error(`Tool call ${event.payload.callId} settled without admission in turn ${event.payload.turnId}`)
      if (current.status !== 'running')
        throw new Error(`Tool call ${event.payload.callId} settled more than once in turn ${event.payload.turnId}`)
      if (current.toolName !== event.payload.toolName)
        throw new Error(`Tool call ${event.payload.callId} changed tool identity during settlement`)
      executions.set(key, {
        ...current,
        durationMs: event.payload.durationMs,
        ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
        ...(event.payload.output === undefined ? {} : { output: structuredClone(event.payload.output) }),
        status: event.payload.status,
      })
      continue
    }

    const terminalTurnId = terminalTurn(event)
    if (!terminalTurnId)
      continue
    for (const [key, execution] of executions) {
      if (execution.turnId === terminalTurnId && execution.status === 'running')
        executions.set(key, { ...execution, status: 'uncertain' })
    }
  }

  return [...executions.values()].map(execution => structuredClone(execution))
}

/** Returns tool side effects that still require explicit human reconciliation. */
export function projectUnsettledToolExecutions(
  events: readonly AgentSessionEvent[],
): AgentToolExecutionProjection[] {
  return foldAgentToolExecutions(events)
    .filter(execution => execution.status === 'running' || execution.status === 'uncertain')
}

function executionKey(turnId: string, callId: string): string {
  return `${turnId}\u0000${callId}`
}

function terminalTurn(event: AgentSessionEvent): string | undefined {
  if (event.type === 'turn.closed' || event.type === 'turn.interrupted')
    return event.payload.turnId
  return undefined
}

import type {
  AgentToolExecutionClaimInput,
  AgentToolExecutionClaimResult,
  AgentToolExecutionControlPort,
} from '@proj-airi/core-agent'

let activeControl: AgentToolExecutionControlPort | undefined

/** Installs the platform owner for tool execution idempotency. */
export function configureChatToolExecutionControl(control?: AgentToolExecutionControlPort) {
  activeControl = control

  return () => {
    if (activeControl === control)
      activeControl = undefined
  }
}

/** Creates the runtime-facing tool ledger, using an in-memory fallback on web. */
export function createChatToolExecutionControlPort(): AgentToolExecutionControlPort {
  const fallback = createLocalToolExecutionControl()
  return {
    claim: input => (activeControl ?? fallback).claim(input),
    settle: input => (activeControl ?? fallback).settle(input),
  }
}

function assertSameToolIdentity(
  current: AgentToolExecutionClaimInput | undefined,
  incoming: AgentToolExecutionClaimInput,
) {
  if (!current
    || current.toolName !== incoming.toolName
    || JSON.stringify(current.input) !== JSON.stringify(incoming.input)) {
    throw new Error(`Tool call ${incoming.callId} changed identity across retries`)
  }
}

function createLocalToolExecutionControl(): AgentToolExecutionControlPort {
  const executions = new Map<string, AgentToolExecutionClaimResult>()
  const identities = new Map<string, AgentToolExecutionClaimInput>()

  return {
    async claim(input) {
      const key = executionKey(input)
      const current = executions.get(key)
      if (current) {
        assertSameToolIdentity(identities.get(key), input)
        return structuredClone(current)
      }

      identities.set(key, structuredClone(input))
      executions.set(key, { disposition: 'blocked', status: 'running' })
      return { disposition: 'execute' }
    },
    async settle(input) {
      const key = executionKey(input)
      const current = executions.get(key)
      if (!current)
        throw new Error(`Tool call ${input.callId} settled without admission`)
      assertSameToolIdentity(identities.get(key), input)

      const terminal: AgentToolExecutionClaimResult = input.status === 'completed'
        ? { disposition: 'replay', output: structuredClone(input.output), status: 'completed' }
        : { disposition: 'replay', error: input.error, status: 'failed' }
      if (current.disposition === 'replay') {
        if (JSON.stringify(current) !== JSON.stringify(terminal))
          throw new Error(`Tool call ${input.callId} changed result during duplicate settlement`)
        return
      }
      if (current.disposition !== 'blocked' || current.status !== 'running')
        throw new Error(`Tool call ${input.callId} cannot be settled from ${current.disposition}`)
      executions.set(key, terminal)
    },
  }
}

function executionKey(input: Pick<AgentToolExecutionClaimInput, 'callId' | 'sessionId' | 'turnId'>): string {
  return `${input.sessionId}\u0000${input.turnId}\u0000${input.callId}`
}

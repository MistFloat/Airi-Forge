import type {
  AgentToolExecutionClaimInput,
  AgentToolExecutionClaimResult,
  AgentToolExecutionSettlementInput,
} from '@proj-airi/core-agent'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { configureChatToolExecutionControl } from '@proj-airi/stage-ui/stores/chat-tool-executions'

import {
  electronAgentToolExecutionClaim,
  electronAgentToolExecutionSettle,
} from '../../shared/eventa/agent-runtime'

interface AgentToolExecutionTransport {
  claim: (input: AgentToolExecutionClaimInput) => Promise<AgentToolExecutionClaimResult>
  settle: (input: AgentToolExecutionSettlementInput) => Promise<void>
}

/** Connects renderer tool wrappers to the Electron-owned atomic ledger. */
export function initializeAgentToolExecutionBridge(
  transport: AgentToolExecutionTransport = createEventaTransport(),
) {
  return configureChatToolExecutionControl({
    claim: input => transport.claim(input),
    settle: input => transport.settle(input),
  })
}

function createEventaTransport(): AgentToolExecutionTransport {
  const context = getElectronEventaContext()
  return {
    claim: defineInvoke(context, electronAgentToolExecutionClaim),
    settle: defineInvoke(context, electronAgentToolExecutionSettle),
  }
}

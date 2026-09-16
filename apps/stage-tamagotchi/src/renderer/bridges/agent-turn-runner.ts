import type { AgentTurnCancellationNotice } from '@proj-airi/core-agent'
import type { ChatTurnControlTransport } from '@proj-airi/stage-ui/stores/chat-turn-control'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import {
  configureChatTurnTransport,
  dispatchChatTurnCancellation,
} from '@proj-airi/stage-ui/stores/chat-turn-control'

import {
  electronAgentTurnAcknowledgeRecovery,
  electronAgentTurnCancel,
  electronAgentTurnCancellationRequested,
  electronAgentTurnCheckpoint,
  electronAgentTurnList,
  electronAgentTurnSettle,
  electronAgentTurnStart,
  electronAgentTurnStatus,
} from '../../shared/eventa/agent-runtime'

/** Eventa commands and push subscription consumed by the renderer bridge. */
export interface AgentTurnRunnerBridgeBindings extends ChatTurnControlTransport {
  /** Subscribes to exact main-process cancellation notices. */
  subscribeCancellation: (listener: (notice: AgentTurnCancellationNotice) => void) => () => void
}

/**
 * Connects the shared chat facade to the Electron-owned turn state machine.
 *
 * The bridge only carries typed commands and correlated cancellation pushes;
 * model, prompt, memory, tool, and multimodal adapters remain renderer-owned.
 */
export function initializeAgentTurnRunnerBridge(
  bindings: AgentTurnRunnerBridgeBindings = createEventaBindings(),
) {
  const disposeTransport = configureChatTurnTransport(bindings)
  const unsubscribeCancellation = bindings.subscribeCancellation(dispatchChatTurnCancellation)

  return () => {
    unsubscribeCancellation()
    disposeTransport()
  }
}

function createEventaBindings(): AgentTurnRunnerBridgeBindings {
  const context = getElectronEventaContext()

  return {
    acknowledgeRecovery: defineInvoke(context, electronAgentTurnAcknowledgeRecovery),
    cancel: defineInvoke(context, electronAgentTurnCancel),
    checkpoint: defineInvoke(context, electronAgentTurnCheckpoint),
    list: defineInvoke(context, electronAgentTurnList),
    settle: defineInvoke(context, electronAgentTurnSettle),
    start: defineInvoke(context, electronAgentTurnStart),
    status: defineInvoke(context, electronAgentTurnStatus),
    subscribeCancellation: listener => context.on(
      electronAgentTurnCancellationRequested,
      (event) => {
        if (event.body)
          listener(event.body)
      },
    ),
  }
}

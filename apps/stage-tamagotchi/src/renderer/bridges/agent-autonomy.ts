import type { AgentScheduleDueNotice } from '@proj-airi/core-agent'
import type { ChatAutonomyTransport } from '@proj-airi/stage-ui/stores/chat-autonomy'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import {
  configureChatAutonomyTransport,
  dispatchChatScheduleDue,
} from '@proj-airi/stage-ui/stores/chat-autonomy'

import {
  electronAgentAutonomyGet,
  electronAgentGoalPut,
  electronAgentGoalTransition,
  electronAgentScheduleCancel,
  electronAgentScheduleClaim,
  electronAgentScheduleCreate,
  electronAgentScheduleDue,
  electronAgentScheduleSettle,
} from '../../shared/eventa/agent-runtime'

/**
 * Connects renderer autonomy commands and due notifications to Electron main.
 *
 * Main remains the only owner of Goal/Schedule state; the renderer merely
 * claims a persisted dispatch and executes it as an ordinary chat turn.
 */
export function initializeAgentAutonomyBridge(
  transport: ChatAutonomyTransport = createEventaTransport(),
  subscribeDue = createDueSubscription,
) {
  const disposeTransport = configureChatAutonomyTransport(transport)
  const disposeDue = subscribeDue(dispatchChatScheduleDue)

  return () => {
    disposeDue()
    disposeTransport()
  }
}

function createDueSubscription(listener: (notice: AgentScheduleDueNotice) => Promise<void> | void) {
  const context = getElectronEventaContext()
  return context.on(electronAgentScheduleDue, (event) => {
    if (event.body) {
      void Promise.resolve(listener(event.body)).catch((error) => {
        console.error('Failed to deliver Agent schedule to chat authority:', error)
      })
    }
  })
}

function createEventaTransport(): ChatAutonomyTransport {
  const context = getElectronEventaContext()
  return {
    cancelSchedule: defineInvoke(context, electronAgentScheduleCancel),
    claimSchedule: defineInvoke(context, electronAgentScheduleClaim),
    createSchedule: defineInvoke(context, electronAgentScheduleCreate),
    get: defineInvoke(context, electronAgentAutonomyGet),
    putGoal: defineInvoke(context, electronAgentGoalPut),
    settleSchedule: defineInvoke(context, electronAgentScheduleSettle),
    transitionGoal: defineInvoke(context, electronAgentGoalTransition),
  }
}

import type { InvocableEventContext } from '@moeru/eventa'

import type { AgentSessionEventService } from './service'

import { defineInvokeHandler } from '@moeru/eventa'

import {
  electronAgentConversationSearch,
  electronAgentSessionEventAppend,
  electronAgentSessionEventsList,
  electronAgentSessionMessagesImport,
  electronAgentToolExecutionClaim,
  electronAgentToolExecutionSettle,
} from '../../../../../shared/eventa/agent-runtime'
import {
  parseAgentSessionEventInput,
  parseAgentSessionEventsQuery,
  parseAgentToolExecutionClaimInput,
  parseAgentToolExecutionSettlementInput,
  parseConversationSearchQuery,
} from './schemas'

/**
 * Registers the main-process Eventa handlers for Agent session events.
 *
 * Every renderer payload is validated before it reaches ordering or
 * persistence. The returned cleanup removes both invoke handlers together.
 */
export function registerAgentSessionEventHandlers<ContextExtension, EventOptions extends { raw?: unknown }>(
  context: InvocableEventContext<ContextExtension, EventOptions>,
  service: AgentSessionEventService,
) {
  const cleanups = [
    defineInvokeHandler(context, electronAgentSessionEventAppend, async (input) => {
      const event = service.append(parseAgentSessionEventInput(input))
      await service.flush()
      return event
    }),
    defineInvokeHandler(context, electronAgentSessionEventsList, input => service.list(parseAgentSessionEventsQuery(input))),
    defineInvokeHandler(context, electronAgentConversationSearch, input => (
      service.searchConversations(parseConversationSearchQuery(input))
    )),
    defineInvokeHandler(context, electronAgentSessionMessagesImport, async (inputs) => {
      if (!Array.isArray(inputs))
        throw new Error('Agent message import expects an array')
      const events = inputs.map((input) => {
        const parsed = parseAgentSessionEventInput(input)
        if (parsed.type !== 'message.appended')
          throw new Error(`Agent message import cannot append ${parsed.type}`)
        return service.append(parsed)
      })
      await service.flush()
      return events
    }),
    defineInvokeHandler(context, electronAgentToolExecutionClaim, input => (
      service.claimToolExecution(parseAgentToolExecutionClaimInput(input))
    )),
    defineInvokeHandler(context, electronAgentToolExecutionSettle, input => (
      service.settleToolExecution(parseAgentToolExecutionSettlementInput(input))
    )),
  ]

  return () => {
    for (const cleanup of cleanups)
      cleanup()
  }
}

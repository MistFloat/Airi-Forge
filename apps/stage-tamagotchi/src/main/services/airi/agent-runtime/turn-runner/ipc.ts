import type { InvocableEventContext } from '@moeru/eventa'

import type { AgentTurnRunner } from './service'

import { defineInvokeHandler } from '@moeru/eventa'

import {
  electronAgentTurnAcknowledgeRecovery,
  electronAgentTurnCancel,
  electronAgentTurnCancellationRequested,
  electronAgentTurnCheckpoint,
  electronAgentTurnList,
  electronAgentTurnSettle,
  electronAgentTurnStart,
  electronAgentTurnStatus,
} from '../../../../../shared/eventa/agent-runtime'
import {
  parseAgentTurnCancellationInput,
  parseAgentTurnCheckpointInput,
  parseAgentTurnListQuery,
  parseAgentTurnRecoveryAckInput,
  parseAgentTurnSettlementInput,
  parseAgentTurnStartInput,
  parseAgentTurnStatusQuery,
} from './schemas'

/** Resolves the stable renderer owner token from transport metadata. */
export type AgentTurnOwnerResolver<EventOptions> = (options?: EventOptions) => string

/**
 * Registers the main-process Eventa command surface for durable Agent turns.
 *
 * Admission, checkpoints, and settlement bind to the invoking renderer owner.
 * Cancellation is flushed by the service before correlated push events are
 * emitted, so recipients never observe a cancellation absent durable state.
 */
export function registerAgentTurnHandlers<ContextExtension, EventOptions extends { raw?: unknown }>(
  context: InvocableEventContext<ContextExtension, EventOptions>,
  service: AgentTurnRunner,
  resolveOwnerId: AgentTurnOwnerResolver<EventOptions>,
) {
  const cleanups = [
    defineInvokeHandler(context, electronAgentTurnStart, (input, options) => (
      service.start(parseAgentTurnStartInput(input), requireOwnerId(resolveOwnerId(options)))
    )),
    defineInvokeHandler(context, electronAgentTurnCheckpoint, (input, options) => (
      service.checkpoint(parseAgentTurnCheckpointInput(input), requireOwnerId(resolveOwnerId(options)))
    )),
    defineInvokeHandler(context, electronAgentTurnSettle, (input, options) => (
      service.settle(parseAgentTurnSettlementInput(input), requireOwnerId(resolveOwnerId(options)))
    )),
    defineInvokeHandler(context, electronAgentTurnCancel, async (input) => {
      const result = await service.requestCancellation(parseAgentTurnCancellationInput(input))
      for (const notice of result.notices)
        context.emit(electronAgentTurnCancellationRequested, notice)
      return result.records
    }),
    defineInvokeHandler(context, electronAgentTurnStatus, input => service.status(parseAgentTurnStatusQuery(input))),
    defineInvokeHandler(context, electronAgentTurnList, input => service.list(parseAgentTurnListQuery(input))),
    defineInvokeHandler(context, electronAgentTurnAcknowledgeRecovery, input => (
      service.acknowledgeRecovery(parseAgentTurnRecoveryAckInput(input))
    )),
  ]

  return () => {
    for (const cleanup of cleanups)
      cleanup()
  }
}

function requireOwnerId(ownerId: string): string {
  if (ownerId.length === 0)
    throw new Error('Agent turn command is missing a renderer owner')
  return ownerId
}

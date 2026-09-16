import type { InvocableEventContext } from '@moeru/eventa'

import type { AgentAutonomyService } from './service'

import { defineInvokeHandler } from '@moeru/eventa'

import {
  electronAgentAutonomyGet,
  electronAgentGoalPut,
  electronAgentGoalTransition,
  electronAgentScheduleCancel,
  electronAgentScheduleClaim,
  electronAgentScheduleCreate,
  electronAgentScheduleDue,
  electronAgentScheduleSettle,
} from '../../../../../shared/eventa/agent-runtime'
import {
  parseAgentAutonomyQuery,
  parseAgentGoalPutInput,
  parseAgentGoalTransitionInput,
  parseAgentScheduleCancelInput,
  parseAgentScheduleClaimInput,
  parseAgentScheduleCreateInput,
  parseAgentScheduleSettlementInput,
} from './schemas'

/** Resolves the stable renderer owner token from transport metadata. */
export type AgentAutonomyOwnerResolver<EventOptions> = (options?: EventOptions) => string

/** Registers Goal/Schedule commands and persisted due notifications over Eventa. */
export function registerAgentAutonomyHandlers<ContextExtension, EventOptions extends { raw?: unknown }>(
  context: InvocableEventContext<ContextExtension, EventOptions>,
  service: AgentAutonomyService,
  resolveOwnerId: AgentAutonomyOwnerResolver<EventOptions>,
) {
  const cleanups = [
    defineInvokeHandler(context, electronAgentAutonomyGet, input => service.get(parseAgentAutonomyQuery(input))),
    defineInvokeHandler(context, electronAgentGoalPut, input => service.putGoal(parseAgentGoalPutInput(input))),
    defineInvokeHandler(context, electronAgentGoalTransition, input => (
      service.transitionGoal(parseAgentGoalTransitionInput(input))
    )),
    defineInvokeHandler(context, electronAgentScheduleCreate, input => (
      service.createSchedule(parseAgentScheduleCreateInput(input))
    )),
    defineInvokeHandler(context, electronAgentScheduleCancel, input => (
      service.cancelSchedule(parseAgentScheduleCancelInput(input))
    )),
    defineInvokeHandler(context, electronAgentScheduleClaim, (input, invokeOptions) => (
      service.claimSchedule(
        parseAgentScheduleClaimInput(input),
        requireOwnerId(resolveOwnerId(invokeOptions)),
      )
    )),
    defineInvokeHandler(context, electronAgentScheduleSettle, (input, invokeOptions) => (
      service.settleSchedule(
        parseAgentScheduleSettlementInput(input),
        requireOwnerId(resolveOwnerId(invokeOptions)),
      )
    )),
    service.subscribeDue(notice => context.emit(electronAgentScheduleDue, notice)),
  ]

  return () => {
    for (const cleanup of cleanups)
      cleanup()
  }
}

function requireOwnerId(ownerId: string): string {
  if (!ownerId)
    throw new Error('Agent autonomy command is missing a renderer owner')
  return ownerId
}

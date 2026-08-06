import type { SparkNotifyResponseControl } from '@proj-airi/core-agent/agents/spark-notify'
import type { WebSocketBaseEvent, WebSocketEventOf, WebSocketEvents } from '@proj-airi/server-sdk'

import { setupAgentSparkNotifyHandler } from '@proj-airi/core-agent/agents/spark-notify'
import { defineStore, storeToRefs } from 'pinia'
import { ref } from 'vue'

import { useCharacterNotebookStore, useCharacterStore } from '../'
import { useLLM } from '../../llm'
import { useModsServerChannelStore } from '../../mods/api/channel-server'
import { useConsciousnessStore } from '../../modules/consciousness'
import { useProvidersStore } from '../../providers'

export { sparkNotifyCommandSchema } from '@proj-airi/core-agent/agents/spark-notify'

export const useCharacterOrchestratorStore = defineStore('character-orchestrator', () => {
  const { stream } = useLLM()
  const { activeModel, activeProvider } = storeToRefs(useConsciousnessStore())
  const providersStore = useProvidersStore()
  const characterStore = useCharacterStore()
  const notebookStore = useCharacterNotebookStore()
  const modsServerChannelStore = useModsServerChannelStore()

  const processing = ref(false)
  const pendingNotifies = ref<Array<WebSocketEventOf<'spark:notify'>>>([])
  const scheduledNotifies = ref<Array<{
    attempts: number
    control?: SparkNotifyResponseControl
    enqueuedAt: number
    event: WebSocketEventOf<'spark:notify'>
    maxAttempts: number
    nextRunAt: number
    reason?: string
  }>>([])
  const attentionConfig = ref({
    maxAttempts: 3,
    requeueDelayMs: 30_000,
    taskNotifyWindowMs: 60_000,
    tickIntervalMs: 2_000,
  })
  let tickTimer: ReturnType<typeof setInterval> | undefined
  let initialized = false
  const eventUnsubscribes: Array<() => void> = []
  const sparkNotifyAgent = setupAgentSparkNotifyHandler({
    getActiveModel: () => activeModel.value,
    getActiveProvider: () => activeProvider.value,
    getPending: () => pendingNotifies.value,
    getProcessing: () => processing.value,
    getProviderInstance: name => providersStore.getProviderInstance(name),
    getSystemPrompt: () => '',
    onReactionDelta: (eventId, text) => characterStore.onSparkNotifyReactionStreamEvent(eventId, text),
    onReactionEnd: (eventId, text) => characterStore.onSparkNotifyReactionStreamEnd(eventId, text),
    setPending: next => pendingNotifies.value = next,
    setProcessing: next => processing.value = next,
    stream,
  })

  function computeNextRunAt(event: WebSocketEventOf<'spark:notify'>, attempts: number) {
    const now = Date.now()
    const baseDelay = (() => {
      switch (event.data.urgency) {
        case 'immediate':
          return 0
        case 'later':
          return 60_000
        case 'soon':
          return 10_000
        default:
          return 30_000
      }
    })()

    return now + baseDelay + (attempts * attentionConfig.value.requeueDelayMs)
  }

  function removePending(eventId: string) {
    pendingNotifies.value = pendingNotifies.value.filter(item => item.data.id !== eventId)
  }

  function enqueueSparkNotify(
    event: WebSocketEventOf<'spark:notify'>,
    options?: {
      control?: SparkNotifyResponseControl
      maxAttempts?: number
      nextRunAt?: number
      reason?: string
    },
  ) {
    if (!pendingNotifies.value.some(item => item.data.id === event.data.id)) {
      pendingNotifies.value.push(event)
    }

    scheduledNotifies.value.push({
      attempts: 0,
      control: options?.control,
      enqueuedAt: Date.now(),
      event,
      maxAttempts: options?.maxAttempts ?? attentionConfig.value.maxAttempts,
      nextRunAt: options?.nextRunAt ?? computeNextRunAt(event, 0),
      reason: options?.reason,
    })
  }

  async function processSparkNotify(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) {
    const result = await sparkNotifyAgent.handle(event, control)
    if (!result?.commands?.length)
      return result

    for (const command of result.commands) {
      modsServerChannelStore.send({
        data: command as WebSocketEvents['spark:command'],
        type: 'spark:command',
      })
    }

    return result
  }

  async function handleIncomingSparkNotify(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) {
    if (event.data.urgency === 'immediate' && !processing.value) {
      return await processSparkNotify(event, control)
    }

    enqueueSparkNotify(event, { control, reason: 'spark:notify' })
    return undefined
  }

  async function handleSparkNotifyWithReaction(
    event: WebSocketEventOf<'spark:notify'>,
    options?: SparkNotifyResponseControl & { fallbackText?: string },
  ) {
    await handleIncomingSparkNotify(event, options)

    const reaction = [...characterStore.reactions]
      .reverse()
      .find(item => item.sourceEventId === event.data.id)
      ?.message
      ?.trim()

    return reaction || options?.fallbackText || ''
  }

  function enqueueDueTasks(now: number) {
    const dueTasks = notebookStore.getDueTasks(now, attentionConfig.value.taskNotifyWindowMs)
    if (!dueTasks.length)
      return

    for (const task of dueTasks) {
      const event: WebSocketEventOf<'spark:notify'> = {
        data: {
          destinations: ['character'],
          eventId: task.id,
          headline: `Task reminder: ${task.title}`,
          id: `task-${task.id}`,
          kind: 'reminder',
          note: task.details,
          payload: {
            dueAt: task.dueAt,
            priority: task.priority,
            taskId: task.id,
          },
          urgency: task.priority === 'critical' ? 'immediate' : 'soon',
        },
        source: 'character:task-scheduler',
        type: 'spark:notify',
      }

      enqueueSparkNotify(event, { reason: 'task:due' })
      notebookStore.markTaskNotified(task.id, now + attentionConfig.value.requeueDelayMs)
    }
  }

  async function tick() {
    if (processing.value)
      return

    const now = Date.now()
    enqueueDueTasks(now)

    const nextIndex = scheduledNotifies.value.findIndex(item => item.nextRunAt <= now)
    if (nextIndex < 0)
      return

    const [next] = scheduledNotifies.value.splice(nextIndex, 1)
    removePending(next.event.data.id)

    try {
      await processSparkNotify(next.event, next.control)
    }
    catch (error) {
      if (next.attempts + 1 < next.maxAttempts) {
        scheduledNotifies.value = [...scheduledNotifies.value, {
          ...next,
          attempts: next.attempts + 1,
          nextRunAt: computeNextRunAt(next.event, next.attempts + 1),
        }]
        pendingNotifies.value = [...pendingNotifies.value, next.event]
      }
      else {
        console.warn('Dropped spark:notify after max attempts:', error)
      }
    }
  }

  function startTicker() {
    if (tickTimer)
      return

    tickTimer = setInterval(() => {
      void tick()
    }, attentionConfig.value.tickIntervalMs)
  }

  function stopTicker() {
    if (!tickTimer)
      return

    clearInterval(tickTimer)
    tickTimer = undefined
  }

  async function handleSparkEmit(_: WebSocketBaseEvent<'spark:emit', WebSocketEvents['spark:emit']>) {
    // Currently no-op
    return undefined
  }

  function initialize() {
    if (initialized)
      return

    initialized = true

    eventUnsubscribes.push(
      modsServerChannelStore.onEvent('spark:notify', async (event) => {
        try {
          await handleIncomingSparkNotify(event)
        }
        catch (error) {
          console.warn('Failed to handle spark:notify event:', error)
        }
      }),
    )

    eventUnsubscribes.push(
      modsServerChannelStore.onEvent('spark:emit', async (event) => {
        try {
          await handleSparkEmit(event)
        }
        catch (error) {
          console.warn('Failed to handle spark:emit event:', error)
        }
      }),
    )

    startTicker()
  }

  function dispose() {
    stopTicker()

    for (const unsubscribe of eventUnsubscribes) {
      unsubscribe()
    }

    eventUnsubscribes.length = 0
    initialized = false
  }

  return {
    attentionConfig,
    dispose,
    handleSparkEmit,
    handleSparkNotify: handleIncomingSparkNotify,

    handleSparkNotifyWithReaction,
    initialize,
    pendingNotifies,
    processing,

    scheduledNotifies,
    startTicker,
    stopTicker,
  }
})

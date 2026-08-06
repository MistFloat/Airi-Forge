import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { nextVisionPollDelay } from './frame-change'

export interface VisionTickOutcome {
  capturedAt?: number
  changeScore?: number
  contextUpdates?: number
  meaningfulChange?: boolean
  sampledAt?: number
}

type VisionTickHandler = () => Promise<VisionTickOutcome | void> | VisionTickOutcome | void

const DEFAULT_CAPTURE_INTERVAL_MS = 3000
const HISTORY_MAX_AGE_MS = 5 * 60 * 1000
const PROCESSING_HISTORY_LIMIT = 240

function countInWindow(history: number[], windowMs: number) {
  const cutoff = Date.now() - windowMs
  let count = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index] < cutoff)
      break
    count += 1
  }
  return count
}

function trimHistoryByAge(history: number[], maxAgeMs: number) {
  const cutoff = Date.now() - maxAgeMs
  while (history.length > 0 && history[0] < cutoff)
    history.shift()
}

export const useVisionProcessingStore = defineStore('vision-processing', () => {
  const captureIntervalMs = useLocalStorageManualReset<number>(
    'settings/vision/capture-interval-ms',
    DEFAULT_CAPTURE_INTERVAL_MS,
  )
  const changeThreshold = useLocalStorageManualReset<number>('settings/vision/change-threshold', 0.018)
  const privacyMode = useLocalStorageManualReset<boolean>('settings/vision/privacy-mode', true)

  const isRunning = ref(false)
  const isProcessing = ref(false)
  const tickCount = ref(0)
  const skippedTicks = ref(0)
  const captureCount = ref(0)
  const sampleCount = ref(0)
  const unchangedSampleCount = ref(0)
  const contextUpdateCount = ref(0)
  const lastTickAt = ref<null | number>(null)
  const lastCaptureAt = ref<null | number>(null)
  const lastChangeScore = ref<null | number>(null)
  const currentPollDelayMs = ref(DEFAULT_CAPTURE_INTERVAL_MS)
  const lastContextUpdateAt = ref<null | number>(null)
  const lastProcessingDurationMs = ref<null | number>(null)
  const lastError = ref<null | string>(null)

  const processingHistoryMs = ref<number[]>([])
  const captureHistory = ref<number[]>([])
  const contextUpdateHistory = ref<number[]>([])

  let timeoutHandle: null | ReturnType<typeof setTimeout> = null
  const tickHandler = ref<null | VisionTickHandler>(null)
  let stableTicks = 0

  const captureRatePerMinute = computed(() => countInWindow(captureHistory.value, 60_000))
  const contextUpdateRatePerMinute = computed(() => countInWindow(contextUpdateHistory.value, 60_000))

  const averageProcessingMs = computed(() => {
    if (processingHistoryMs.value.length === 0)
      return 0
    const total = processingHistoryMs.value.reduce((sum, value) => sum + value, 0)
    return total / processingHistoryMs.value.length
  })

  function recordProcessingDuration(durationMs: number) {
    lastProcessingDurationMs.value = durationMs
    processingHistoryMs.value = [...processingHistoryMs.value, durationMs].slice(-PROCESSING_HISTORY_LIMIT)
  }

  function recordCapture(capturedAt = Date.now()) {
    captureCount.value += 1
    lastCaptureAt.value = capturedAt
    captureHistory.value.push(capturedAt)
    trimHistoryByAge(captureHistory.value, HISTORY_MAX_AGE_MS)
  }

  function recordContextUpdates(count = 1, updatedAt = Date.now()) {
    if (count <= 0)
      return

    contextUpdateCount.value += count
    lastContextUpdateAt.value = updatedAt
    for (let index = 0; index < count; index += 1)
      contextUpdateHistory.value.push(updatedAt)
    trimHistoryByAge(contextUpdateHistory.value, HISTORY_MAX_AGE_MS)
  }

  async function runTick() {
    if (!tickHandler.value)
      return
    if (isProcessing.value) {
      skippedTicks.value += 1
      return
    }

    isProcessing.value = true
    lastTickAt.value = Date.now()
    tickCount.value += 1

    const start = performance.now()

    try {
      const outcome = await tickHandler.value()
      lastError.value = null

      if (outcome?.sampledAt)
        sampleCount.value += 1
      if (typeof outcome?.changeScore === 'number')
        lastChangeScore.value = outcome.changeScore
      if (outcome?.meaningfulChange === false) {
        stableTicks += 1
        unchangedSampleCount.value += 1
      }
      else if (outcome?.meaningfulChange) {
        stableTicks = 0
      }

      if (outcome?.capturedAt)
        recordCapture(outcome.capturedAt)
      if (outcome?.contextUpdates)
        recordContextUpdates(outcome.contextUpdates)
    }
    catch (error) {
      lastError.value = errorMessageFrom(error) || 'Unknown error'
    }
    finally {
      recordProcessingDuration(performance.now() - start)
      isProcessing.value = false
      scheduleNextTick()
    }
  }

  function scheduleNextTick() {
    if (!isRunning.value)
      return

    if (timeoutHandle)
      clearTimeout(timeoutHandle)

    currentPollDelayMs.value = nextVisionPollDelay({
      baseIntervalMs: Number(captureIntervalMs.value),
      changeScore: lastChangeScore.value ?? 1,
      stableTicks,
    })
    timeoutHandle = setTimeout(() => void runTick(), currentPollDelayMs.value)
  }

  function startTicker(handler: VisionTickHandler) {
    tickHandler.value = handler
    if (isRunning.value)
      return

    isRunning.value = true
    if (timeoutHandle)
      clearTimeout(timeoutHandle)

    void runTick()
  }

  function stopTicker() {
    isRunning.value = false
    if (timeoutHandle)
      clearTimeout(timeoutHandle)
    timeoutHandle = null
  }

  function resetMetrics() {
    tickCount.value = 0
    skippedTicks.value = 0
    captureCount.value = 0
    sampleCount.value = 0
    unchangedSampleCount.value = 0
    contextUpdateCount.value = 0
    lastTickAt.value = null
    lastCaptureAt.value = null
    lastChangeScore.value = null
    currentPollDelayMs.value = Number(captureIntervalMs.value)
    lastContextUpdateAt.value = null
    lastProcessingDurationMs.value = null
    lastError.value = null
    processingHistoryMs.value = []
    captureHistory.value = []
    contextUpdateHistory.value = []
    stableTicks = 0
  }

  function resetState() {
    stopTicker()
    resetMetrics()
    captureIntervalMs.reset()
    changeThreshold.reset()
    privacyMode.reset()
  }

  watch(captureIntervalMs, (next, previous) => {
    if (!isRunning.value)
      return
    if (next === previous)
      return

    currentPollDelayMs.value = nextVisionPollDelay({
      baseIntervalMs: Number(next),
      changeScore: lastChangeScore.value ?? 1,
      stableTicks,
    })
    scheduleNextTick()
  })

  return {
    averageProcessingMs,
    captureCount,
    captureHistory,
    captureIntervalMs,
    captureRatePerMinute,
    changeThreshold,
    contextUpdateCount,
    contextUpdateHistory,
    contextUpdateRatePerMinute,
    currentPollDelayMs,
    isProcessing,
    isRunning,
    lastCaptureAt,
    lastChangeScore,
    lastContextUpdateAt,
    lastError,
    lastProcessingDurationMs,
    lastTickAt,
    privacyMode,
    processingHistoryMs,
    recordContextUpdates,
    resetMetrics,
    resetState,
    sampleCount,
    skippedTicks,
    startTicker,
    stopTicker,
    tickCount,
    unchangedSampleCount,
  }
})

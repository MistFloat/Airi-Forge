import type { createVADStates } from '@proj-airi/stage-ui/workers/vad'

import type { MimoConfig } from '../lib/transcribe'

import vadWorkletUrl from '@proj-airi/stage-ui/workers/vad/process.worklet?worker&url'

import { errorMessageFrom } from '@moeru/std'
import { toWav } from '@proj-airi/audio'
import { computed, onUnmounted, shallowRef } from 'vue'

import { transcribeWithMimo } from '../lib/transcribe'

export interface DemoSegment {
  audioUrl?: string
  durationMs: number
  error?: string
  id: number
  outcome: 'accepted' | 'rejected'
  reason?: string
  status: 'complete' | 'error' | 'filtered' | 'queued' | 'uploading'
  text?: string
  voicedDurationMs: number
  voicedRatio: number
}

export function useVoiceRecognitionDemo(getConfig: () => MimoConfig) {
  const status = shallowRef('尚未启动')
  const probability = shallowRef(0)
  const isSpeaking = shallowRef(false)
  const isRunning = shallowRef(false)
  const segments = shallowRef<DemoSegment[]>([])

  let stream: MediaStream | undefined
  let manager: ReturnType<typeof createVADStates> | undefined
  let segmentId = 0
  let uploadTail = Promise.resolve()
  const audioUrls = new Set<string>()

  const acceptedCount = computed(() => segments.value.filter(segment => segment.outcome === 'accepted').length)
  const rejectedCount = computed(() => segments.value.filter(segment => segment.outcome === 'rejected').length)

  function addSegment(segment: DemoSegment) {
    segments.value = [segment, ...segments.value]
  }

  async function uploadSegment(segment: DemoSegment, recording: Blob) {
    segment.status = 'uploading'
    segments.value = [...segments.value]
    try {
      segment.text = await transcribeWithMimo(recording, getConfig())
      segment.status = 'complete'
      if (!segment.text)
        segment.error = '供应商返回了空文本'
    }
    catch (error) {
      segment.status = 'error'
      segment.error = errorMessageFrom(error)
    }
    finally {
      segments.value = [...segments.value]
    }
  }

  async function start() {
    if (isRunning.value)
      return

    status.value = '请求麦克风权限…'
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    })

    status.value = '加载 Silero VAD 模型…'
    const { createVAD, createVADStates } = await import('@proj-airi/stage-ui/workers/vad')
    const vad = await createVAD({
      exitThreshold: 0.105,
      maxBufferDuration: 30,
      minSilenceDurationMs: 1200,
      minSpeechDurationMs: 300,
      newBufferSize: 512,
      sampleRate: 16000,
      speechPadMs: 360,
      speechThreshold: 0.35,
    })

    vad.on('debug', ({ data }) => {
      if (typeof data?.probability === 'number')
        probability.value = data.probability
    })
    vad.on('speech-start', () => {
      isSpeaking.value = true
      status.value = '检测到人声，正在缓存完整语句…'
    })
    vad.on('speech-end', () => {
      isSpeaking.value = false
      status.value = '语句结束，正在评估片段…'
    })
    vad.on('speech-rejected', (event) => {
      addSegment({
        durationMs: event.duration,
        id: ++segmentId,
        outcome: 'rejected',
        reason: event.reason === 'too-short' ? '有效人声不足 300ms' : '人声占比低于 15%',
        status: 'filtered',
        voicedDurationMs: event.voicedDurationMs,
        voicedRatio: event.voicedRatio,
      })
      status.value = '片段已在本地过滤，继续监听'
    })
    vad.on('speech-ready', (event) => {
      const recording = new Blob([toWav(event.buffer.buffer, 16000)], { type: 'audio/wav' })
      const audioUrl = URL.createObjectURL(recording)
      audioUrls.add(audioUrl)
      const segment: DemoSegment = {
        audioUrl,
        durationMs: event.duration,
        id: ++segmentId,
        outcome: 'accepted',
        status: 'queued',
        voicedDurationMs: event.voicedDurationMs,
        voicedRatio: event.voicedRatio,
      }
      addSegment(segment)
      uploadTail = uploadTail.then(() => uploadSegment(segment, recording))
      status.value = '片段已进入转写队列，继续监听'
    })

    manager = createVADStates(vad, vadWorkletUrl, {
      audioContextOptions: { latencyHint: 'interactive', sampleRate: 16000 },
      minChunkSize: 512,
    })
    await manager.initialize()
    await manager.start(stream)
    isRunning.value = true
    status.value = '正在监听'
  }

  async function stop() {
    manager?.stop()
    manager?.dispose()
    manager = undefined
    stream?.getTracks().forEach(track => track.stop())
    stream = undefined
    isRunning.value = false
    isSpeaking.value = false
    probability.value = 0
    status.value = '已停止；已提交的转写仍会完成'
  }

  function clearSegments() {
    for (const url of audioUrls)
      URL.revokeObjectURL(url)
    audioUrls.clear()
    segments.value = []
  }

  onUnmounted(() => {
    void stop()
    clearSegments()
  })

  return {
    acceptedCount,
    clearSegments,
    isRunning,
    isSpeaking,
    probability,
    rejectedCount,
    segments,
    start,
    status,
    stop,
  }
}

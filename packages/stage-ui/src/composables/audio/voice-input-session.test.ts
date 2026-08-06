import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref, shallowRef } from 'vue'

const audioRecorderMock = vi.hoisted(() => ({
  isRecording: undefined as unknown as { value: boolean },
  startRecord: vi.fn(),
  stopRecord: vi.fn(),
}))

const vadMock = vi.hoisted(() => ({
  loaded: true,
  options: undefined as undefined | {
    onSpeechReady?: (event: { buffer: Float32Array, duration: number }) => void
    onSpeechStart?: () => void
  },
}))

const hearingPipelineMock = vi.hoisted(() => ({
  transcribeForRecording: vi.fn<(recording: Blob) => Promise<string>>(async () => ''),
}))

vi.mock('../../workers/vad/process.worklet?worker&url', () => ({
  default: 'vad-worklet-url',
}))

vi.mock('../../stores/ai/models/vad', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')

  return {
    useVAD: (_workerUrl: string, options: typeof vadMock.options) => {
      vadMock.options = options
      return {
        dispose: vi.fn(),
        inferenceError: vue.ref(),
        init: vi.fn(),
        isSpeech: vue.ref(false),
        isSpeechHistory: vue.ref([]),
        isSpeechProb: vue.ref(0),
        loaded: vue.computed(() => vadMock.loaded),
        start: vi.fn(),
      }
    },
  }
})

vi.mock('../../stores/modules/hearing', () => ({
  useHearingSpeechInputPipeline: () => ({
    transcribeForRecording: hearingPipelineMock.transcribeForRecording,
  }),
}))

vi.mock('./audio-recorder', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  audioRecorderMock.isRecording = vue.ref(false)

  return {
    useAudioRecorder: () => ({
      isRecording: audioRecorderMock.isRecording,
      onStopRecord: vi.fn(),
      startRecord: audioRecorderMock.startRecord,
      stopRecord: audioRecorderMock.stopRecord,
    }),
  }
})

function createMediaStream() {
  return {
    getAudioTracks: () => ([{} as MediaStreamTrack]),
  } as MediaStream
}

describe('useVoiceInputSession', () => {
  afterEach(() => {
    audioRecorderMock.isRecording.value = false
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    vadMock.options = undefined
    vadMock.loaded = true
  })

  it('transcribes the VAD buffered segment without waiting on a recorder started after speech detection', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')
    useVoiceInputSession(shallowRef(createMediaStream()), {
      volumeFallback: { enabled: false },
    })

    vadMock.options?.onSpeechStart?.()
    await Promise.resolve()
    vadMock.options?.onSpeechReady?.({
      buffer: new Float32Array([0, 0.25, -0.25, 0]),
      duration: 250,
    })

    await vi.waitFor(() => {
      expect(hearingPipelineMock.transcribeForRecording).toHaveBeenCalledOnce()
    })

    expect(audioRecorderMock.startRecord).not.toHaveBeenCalled()
    const recording = hearingPipelineMock.transcribeForRecording.mock.calls[0]?.[0]
    expect(recording).toBeInstanceOf(Blob)
    expect(recording?.type).toBe('audio/wav')
    expect(await recording?.slice(0, 4).text()).toBe('RIFF')
  })

  it('clears the active recorder segment when discarding fails during stop', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')

    audioRecorderMock.startRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = true
    })
    audioRecorderMock.stopRecord.mockImplementationOnce(async () => {
      audioRecorderMock.isRecording.value = false
      throw new Error('finalize failed')
    })

    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      volumeFallback: { enabled: false },
    })

    await expect(session.startSegment('manual')).resolves.toBe(true)
    expect(session.activeRecordingTrigger.value).toBe('manual')

    await expect(session.stop({ flushActiveRecording: false })).rejects.toThrow('finalize failed')

    expect(session.activeRecordingTrigger.value).toBeUndefined()
  })

  it('reports a failed recorder start without leaving an active segment', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')
    const startupError = new Error('start failed')

    audioRecorderMock.startRecord.mockRejectedValueOnce(startupError)

    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      volumeFallback: { enabled: false },
    })

    await expect(session.startSegment('manual')).resolves.toBe(false)

    expect(session.activeRecordingTrigger.value).toBeUndefined()
    expect(session.lastError.value).toBe(startupError)
  })

  it('clears the active segment when the caller start gate rejects', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')
    const gateError = new Error('gate failed')

    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      canStartSegment: vi.fn()
        .mockRejectedValueOnce(gateError)
        .mockResolvedValueOnce(true),
      volumeFallback: { enabled: false },
    })

    await expect(session.startSegment('manual')).resolves.toBe(false)

    expect(session.activeRecordingTrigger.value).toBeUndefined()
    expect(session.lastError.value).toBe(gateError)

    audioRecorderMock.startRecord.mockImplementationOnce(async () => {
      audioRecorderMock.isRecording.value = true
    })

    await expect(session.startSegment('manual')).resolves.toBe(true)
    expect(session.activeRecordingTrigger.value).toBe('manual')
  })

  it('clears the active segment when the caller start hook rejects', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')
    const hookError = new Error('start hook failed')

    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      onSegmentStart: vi.fn().mockRejectedValueOnce(hookError),
      volumeFallback: { enabled: false },
    })

    await expect(session.startSegment('manual')).resolves.toBe(false)

    expect(audioRecorderMock.startRecord).not.toHaveBeenCalled()
    expect(session.activeRecordingTrigger.value).toBeUndefined()
    expect(session.lastError.value).toBe(hookError)
  })

  it('stops and clears the recorder when the caller started hook rejects', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')
    const hookError = new Error('started hook failed')

    audioRecorderMock.startRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = true
    })
    audioRecorderMock.stopRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = false
    })

    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      onSegmentStarted: vi.fn().mockRejectedValueOnce(hookError),
      volumeFallback: { enabled: false },
    })

    await expect(session.startSegment('manual')).resolves.toBe(false)

    expect(audioRecorderMock.stopRecord).toHaveBeenCalledOnce()
    expect(session.isRecording.value).toBe(false)
    expect(session.activeRecordingTrigger.value).toBeUndefined()
    expect(session.lastError.value).toBe(hookError)
  })

  it('finalizes the recorder when the caller stop hook rejects', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')
    const hookError = new Error('stop hook failed')
    const onTranscriptionError = vi.fn()

    audioRecorderMock.startRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = true
    })
    audioRecorderMock.stopRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = false
    })

    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      onSegmentStop: vi.fn().mockRejectedValueOnce(hookError),
      onTranscriptionError,
      volumeFallback: { enabled: false },
    })

    await expect(session.startSegment('manual')).resolves.toBe(true)
    await expect(session.stopSegment('manual')).resolves.toBeUndefined()

    expect(audioRecorderMock.stopRecord).toHaveBeenCalledOnce()
    expect(session.isRecording.value).toBe(false)
    expect(session.activeRecordingTrigger.value).toBeUndefined()
    expect(session.lastError.value).toBe(hookError)
    expect(onTranscriptionError).toHaveBeenCalledWith(expect.objectContaining({ error: hookError }))
  })

  it('stops an active recorder segment after stream mode becomes enabled', async () => {
    const { useVoiceInputSession } = await import('./voice-input-session')
    const shouldUseStreamInput = ref(false)

    audioRecorderMock.startRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = true
    })
    audioRecorderMock.stopRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = false
    })

    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      shouldUseStreamInput,
      volumeFallback: { enabled: false },
    })

    await expect(session.startSegment('manual')).resolves.toBe(true)
    shouldUseStreamInput.value = true
    await session.stopSegment('manual')

    expect(audioRecorderMock.stopRecord).toHaveBeenCalledOnce()
    expect(session.isRecording.value).toBe(false)
    expect(session.activeRecordingTrigger.value).toBeUndefined()
  })

  it('lets volume fallback finalize a VAD-owned segment after silence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)

    const animationFrames: FrameRequestCallback[] = []
    const stopRecord = audioRecorderMock.stopRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = false
    })
    audioRecorderMock.startRecord.mockImplementation(async () => {
      audioRecorderMock.isRecording.value = true
    })

    class FakeAudioContext {
      close = vi.fn()
      destination = {}

      resume = vi.fn()

      state: AudioContextState = 'running'

      createAnalyser() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          fftSize: 512,
          getByteTimeDomainData: (data: Uint8Array<ArrayBuffer>) => data.fill(128),
          smoothingTimeConstant: 0,
        }
      }

      createGain() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
          gain: { value: 1 },
        }
      }

      createMediaStreamSource() {
        return {
          connect: vi.fn(),
          disconnect: vi.fn(),
        }
      }
    }

    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vadMock.loaded = false

    const { useVoiceInputSession } = await import('./voice-input-session')
    const session = useVoiceInputSession(shallowRef(createMediaStream()), {
      volumeFallback: {
        enabled: true,
        stopDelayMs: 10,
      },
    })

    await expect(session.startSegment('vad')).resolves.toBe(true)
    await session.startAutoSegmentation()

    animationFrames.shift()?.(1000)
    vi.setSystemTime(1011)
    animationFrames.shift()?.(1011)
    await Promise.resolve()

    expect(stopRecord).toHaveBeenCalledOnce()
    expect(session.activeRecordingTrigger.value).toBeUndefined()
  })

  it('does not start the volume fallback while model VAD is available', async () => {
    const audioContext = vi.fn()
    vi.stubGlobal('AudioContext', audioContext)

    const { useVoiceInputSession } = await import('./voice-input-session')
    const session = useVoiceInputSession(shallowRef(createMediaStream()))

    await session.startAutoSegmentation()

    expect(audioContext).not.toHaveBeenCalled()
  })
})

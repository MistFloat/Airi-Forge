import { computed, onUnmounted, reactive, shallowRef } from 'vue'

export interface AiriMotionParameters {
  angleX: number
  angleY: number
  angleZ: number
  bodyAngleX: number
  breath: number
  eyeOpen: number
  eyeX: number
  eyeY: number
  mouthOpen: number
}

/**
 * Reproduces AIRI's model-input semantics for a PSD proxy rig.
 *
 * Update order mirrors the Live2D scene: idle gaze, forced blink, lip sync proxy,
 * breathing/body idle, then the transient beat impulse. Values use Cubism's familiar
 * parameter ranges so a future `.model3.json` can consume the same controller inputs.
 */
export function useAiriMotion() {
  const autoBlink = shallowRef(true)
  const speaking = shallowRef(false)
  const pointerActive = shallowRef(false)
  const parameters = reactive<AiriMotionParameters>({
    angleX: 0,
    angleY: 0,
    angleZ: 0,
    bodyAngleX: 0,
    breath: 0,
    eyeOpen: 1,
    eyeX: 0,
    eyeY: 0,
    mouthOpen: 0,
  })

  let animationFrame = 0
  let blinkStartedAt = -1
  let nextBlinkAt = performance.now() + 1800
  let beatStartedAt = -1
  let idleGazeX = 0
  let idleGazeY = 0
  let nextSaccadeAt = 0
  let pointerX = 0
  let pointerY = 0
  let previousTime = performance.now()

  function setPointer(clientX: number, clientY: number, rect: DOMRect) {
    pointerActive.value = true
    pointerX = clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1)
    pointerY = clamp(-(((clientY - rect.top) / rect.height) * 2 - 1), -1, 1)
  }

  function clearPointer() {
    pointerActive.value = false
  }

  function scheduleBeat() {
    beatStartedAt = performance.now()
  }

  function updateBlink(now: number) {
    if (!autoBlink.value) {
      parameters.eyeOpen = 1
      return
    }
    if (blinkStartedAt < 0 && now >= nextBlinkAt)
      blinkStartedAt = now
    if (blinkStartedAt < 0) {
      parameters.eyeOpen = 1
      return
    }

    const elapsed = now - blinkStartedAt
    // AIRI closes in 75 ms and opens over 150-300 ms. This proxy uses the midpoint.
    if (elapsed <= 75) {
      parameters.eyeOpen = 1 - (1 - (1 - elapsed / 75) ** 2)
    }
    else if (elapsed <= 300) {
      parameters.eyeOpen = ((elapsed - 75) / 225) ** 2
    }
    else {
      parameters.eyeOpen = 1
      blinkStartedAt = -1
      nextBlinkAt = now + 3000 + Math.random() * 5000
    }
  }

  function update(now: number) {
    const deltaSeconds = Math.min((now - previousTime) / 1000, 0.05)
    previousTime = now

    if (!pointerActive.value && now >= nextSaccadeAt) {
      idleGazeX = (Math.random() * 2 - 1) * 0.5
      idleGazeY = (Math.random() * 1.7 - 1) * 0.5
      nextSaccadeAt = now + 1800 + Math.random() * 2600
    }
    const gazeX = pointerActive.value ? pointerX : idleGazeX
    const gazeY = pointerActive.value ? pointerY : idleGazeY
    parameters.eyeX = lerp(parameters.eyeX, gazeX, 0.12)
    parameters.eyeY = lerp(parameters.eyeY, gazeY, 0.12)
    parameters.angleX = lerp(parameters.angleX, gazeX * 18, 0.08)
    parameters.angleY = lerp(parameters.angleY, gazeY * 12, 0.08)

    updateBlink(now)

    const speechWave = (Math.sin(now * 0.021) + Math.sin(now * 0.037) * 0.45 + 1.45) / 2.9
    parameters.mouthOpen = lerp(parameters.mouthOpen, speaking.value ? clamp(speechWave, 0.08, 0.82) : 0, 0.28)
    parameters.breath = (Math.sin(now * 0.0018) + 1) / 2
    parameters.bodyAngleX = Math.sin(now * 0.00072) * 2.5

    const beatElapsed = now - beatStartedAt
    const beat = beatElapsed >= 0 && beatElapsed < 520
      ? Math.sin((beatElapsed / 520) * Math.PI) * Math.exp(-beatElapsed / 420)
      : 0
    parameters.angleZ = lerp(parameters.angleZ, Math.sin(now * 0.0009) * 1.2 + beat * 7, clamp(deltaSeconds * 12, 0, 1))

    animationFrame = requestAnimationFrame(update)
  }

  animationFrame = requestAnimationFrame(update)
  onUnmounted(() => cancelAnimationFrame(animationFrame))

  return {
    autoBlink,
    clearPointer,
    debugParameters: computed(() => ({ ...parameters })),
    parameters,
    scheduleBeat,
    setPointer,
    speaking,
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount
}

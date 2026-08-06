<script setup lang="ts">
import type { CSSProperties } from 'vue'

import type { AiriMotionParameters } from '../composables/useAiriMotion'
import type { PsdRig } from '../types'

import { computed, useTemplateRef } from 'vue'

const props = defineProps<{
  parameters: AiriMotionParameters
  rig: PsdRig
}>()

const emit = defineEmits<{
  pointerLeave: []
  pointerMove: [clientX: number, clientY: number, rect: DOMRect]
}>()

const stageRef = useTemplateRef<HTMLDivElement>('stage')

const rigStyle = computed<CSSProperties>(() => ({
  'aspectRatio': `${props.rig.width} / ${props.rig.height}`,
  '--angle-x': `${props.parameters.angleX * 0.14}px`,
  '--angle-y': `${-props.parameters.angleY * 0.12}px`,
  '--angle-z': `${props.parameters.angleZ}deg`,
  '--body-angle': `${props.parameters.bodyAngleX}deg`,
  '--breath': String(1 + props.parameters.breath * 0.012),
  '--eye-open': String(Math.max(0.04, props.parameters.eyeOpen)),
  '--eye-x': `${props.parameters.eyeX * 7}px`,
  '--eye-y': `${-props.parameters.eyeY * 4}px`,
  '--mouth-open': String(1 + props.parameters.mouthOpen * 0.75),
}))

function handlePointerMove(event: PointerEvent) {
  const rect = stageRef.value?.getBoundingClientRect()
  if (rect)
    emit('pointerMove', event.clientX, event.clientY, rect)
}
</script>

<template>
  <div
    ref="stage"
    class="avatar-stage"
    @pointerleave="emit('pointerLeave')"
    @pointermove="handlePointerMove"
  >
    <div class="avatar-rig" :style="rigStyle">
      <img
        v-for="layer in rig.layers"
        :key="layer.name"
        class="avatar-layer"
        :class="`avatar-layer--${layer.role}`"
        :src="layer.dataUrl"
        :alt="layer.name"
        :title="`${layer.name} · ${layer.role}`"
        :style="{
          height: `${layer.height / rig.height * 100}%`,
          left: `${layer.left / rig.width * 100}%`,
          top: `${layer.top / rig.height * 100}%`,
          width: `${layer.width / rig.width * 100}%`,
          zIndex: layer.zIndex,
        }"
      >
    </div>
  </div>
</template>

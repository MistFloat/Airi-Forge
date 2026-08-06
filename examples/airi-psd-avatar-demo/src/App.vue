<script setup lang="ts">
import type { PsdRig } from './types'

import { errorMessageFrom } from '@moeru/std'
import { onMounted, shallowRef } from 'vue'

import rootPsdUrl from '../../../seethrough_output (1).psd?url'
import MotionControls from './components/MotionControls.vue'
import PsdAvatarStage from './components/PsdAvatarStage.vue'

import { useAiriMotion } from './composables/useAiriMotion'
import { loadPsdRig } from './lib/psdRig'

const rig = shallowRef<PsdRig>()
const errorMessage = shallowRef('')
const loading = shallowRef(true)
const motion = useAiriMotion()

onMounted(async () => {
  try {
    rig.value = await loadPsdRig(rootPsdUrl)
  }
  catch (error) {
    errorMessage.value = errorMessageFrom(error) ?? '无法解析 PSD。'
  }
  finally {
    loading.value = false
  }
})
</script>

<template>
  <main class="app-shell">
    <section class="demo-card">
      <div v-if="loading" class="state-message">
        <span class="loader" />
        正在解析根目录 PSD 的分层像素…
      </div>
      <div v-else-if="errorMessage" class="state-message state-message--error">
        {{ errorMessage }}
      </div>
      <template v-else-if="rig">
        <PsdAvatarStage
          :rig="rig"
          :parameters="motion.parameters"
          @pointer-leave="motion.clearPointer"
          @pointer-move="motion.setPointer"
        />
        <MotionControls
          :auto-blink="motion.autoBlink.value"
          :layer-count="rig.layers.length"
          :parameters="motion.parameters"
          :speaking="motion.speaking.value"
          @beat="motion.scheduleBeat"
          @toggle-auto-blink="motion.autoBlink.value = !motion.autoBlink.value"
          @toggle-speaking="motion.speaking.value = !motion.speaking.value"
        />
      </template>
    </section>
  </main>
</template>

<script setup lang="ts">
import type { MimoLanguage } from './lib/transcribe'

import { errorMessageFrom } from '@moeru/std'
import { shallowRef } from 'vue'

import ProviderSettings from './components/ProviderSettings.vue'
import SegmentList from './components/SegmentList.vue'
import VadMonitor from './components/VadMonitor.vue'

import { useVoiceRecognitionDemo } from './composables/useVoiceRecognitionDemo'

const apiKey = shallowRef('')
const baseUrl = shallowRef('https://api.xiaomimimo.com/v1/')
const model = shallowRef('mimo-v2.5-asr')
const language = shallowRef<MimoLanguage>('auto')
const startError = shallowRef('')

const demo = useVoiceRecognitionDemo(() => ({
  apiKey: apiKey.value,
  baseUrl: baseUrl.value,
  language: language.value,
  model: model.value,
}))

async function startDemo() {
  startError.value = ''
  try {
    await demo.start()
  }
  catch (error) {
    startError.value = errorMessageFrom(error)
    await demo.stop()
  }
}
</script>

<template>
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">
          Standalone diagnostic
        </p>
        <h1>AIRI Voice Pipeline Lab</h1>
        <p class="hero-copy">
          独立验证“持续读取 → VAD分段 → 有效语音过滤 → WAV试听 → MiMo ASR → 返回文字”的完整流程。
        </p>
      </div>
      <div class="architecture">
        <span>MIC</span><i>→</i><span>VAD</span><i>→</i><span>WAV</span><i>→</i><span>ASR</span>
      </div>
    </header>

    <ProviderSettings
      v-model:api-key="apiKey"
      v-model:base-url="baseUrl"
      v-model:model="model"
      v-model:language="language"
    />
    <VadMonitor
      :accepted-count="demo.acceptedCount.value"
      :is-running="demo.isRunning.value"
      :is-speaking="demo.isSpeaking.value"
      :probability="demo.probability.value"
      :rejected-count="demo.rejectedCount.value"
      :status="demo.status.value"
      @start="startDemo"
      @stop="demo.stop"
      @clear="demo.clearSegments"
    />
    <p v-if="startError" class="global-error">
      {{ startError }}
    </p>
    <SegmentList :segments="demo.segments.value" />
  </main>
</template>

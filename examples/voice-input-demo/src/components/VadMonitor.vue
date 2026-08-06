<script setup lang="ts">
defineProps<{
  acceptedCount: number
  isRunning: boolean
  isSpeaking: boolean
  probability: number
  rejectedCount: number
  status: string
}>()

const emit = defineEmits<{
  clear: []
  start: []
  stop: []
}>()
</script>

<template>
  <section class="panel monitor-panel">
    <div class="monitor-copy">
      <p class="eyebrow">
        Live detector
      </p>
      <h2>{{ status }}</h2>
      <p class="muted">
        阈值0.35 · 结束静音1.2s · 有效人声≥300ms · 人声占比≥15%
      </p>
    </div>
    <div class="meter-block">
      <div class="meter-labels">
        <span>VAD概率</span>
        <strong>{{ probability.toFixed(3) }}</strong>
      </div>
      <div class="meter-track">
        <div class="meter-fill" :class="{ speaking: isSpeaking }" :style="{ width: `${Math.min(100, probability * 100)}%` }" />
        <div class="threshold-marker" />
      </div>
      <div class="stats-row">
        <span>通过 {{ acceptedCount }}</span>
        <span>过滤 {{ rejectedCount }}</span>
      </div>
    </div>
    <div class="actions">
      <button v-if="!isRunning" class="button primary" type="button" @click="emit('start')">
        开始监听
      </button>
      <button v-else class="button danger" type="button" @click="emit('stop')">
        停止监听
      </button>
      <button class="button ghost" type="button" @click="emit('clear')">
        清空结果
      </button>
    </div>
  </section>
</template>

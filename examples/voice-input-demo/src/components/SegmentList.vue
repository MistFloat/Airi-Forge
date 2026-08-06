<script setup lang="ts">
import type { DemoSegment } from '../composables/useVoiceRecognitionDemo'

defineProps<{ segments: DemoSegment[] }>()

function statusLabel(segment: DemoSegment) {
  const labels = {
    complete: '识别完成',
    error: '请求失败',
    filtered: '本地过滤',
    queued: '等待上传',
    uploading: '正在识别',
  }
  return labels[segment.status]
}
</script>

<template>
  <section class="panel">
    <div class="section-heading">
      <div>
        <p class="eyebrow">
          Segments
        </p>
        <h2>分段与识别结果</h2>
      </div>
      <span class="muted">最新片段在前</span>
    </div>
    <div v-if="segments.length" class="segment-list">
      <article v-for="segment in segments" :key="segment.id" class="segment" :class="segment.outcome">
        <div class="segment-topline">
          <strong>#{{ segment.id }} · {{ statusLabel(segment) }}</strong>
          <span>{{ (segment.durationMs / 1000).toFixed(2) }}s 总长 / {{ (segment.voicedDurationMs / 1000).toFixed(2) }}s 人声 / {{ (segment.voicedRatio * 100).toFixed(1) }}%</span>
        </div>
        <p v-if="segment.reason" class="reason">
          {{ segment.reason }}
        </p>
        <audio v-if="segment.audioUrl" :src="segment.audioUrl" controls preload="metadata" />
        <p v-if="segment.text" class="transcript">
          {{ segment.text }}
        </p>
        <p v-if="segment.error" class="error-text">
          {{ segment.error }}
        </p>
      </article>
    </div>
    <div v-else class="empty-state">
      开始监听后，说一句完整的话；这里会同时显示被接受和被过滤的片段。
    </div>
  </section>
</template>

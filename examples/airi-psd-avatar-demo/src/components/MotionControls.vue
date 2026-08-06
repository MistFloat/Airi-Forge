<script setup lang="ts">
import type { AiriMotionParameters } from '../composables/useAiriMotion'

const props = defineProps<{
  autoBlink: boolean
  layerCount: number
  parameters: AiriMotionParameters
  speaking: boolean
}>()

const emit = defineEmits<{
  beat: []
  toggleAutoBlink: []
  toggleSpeaking: []
}>()

function format(value: number) {
  return value.toFixed(2)
}
</script>

<template>
  <aside class="control-panel">
    <div>
      <p class="eyebrow">
        AIRI-compatible proxy rig
      </p>
      <h1>PSD 自动绑定演示</h1>
      <p class="lede">
        已自动识别 {{ layerCount }} 个可见图层。把鼠标移到角色周围，她会像 AIRI 的 Live2D 模型一样追踪视线。
      </p>
    </div>

    <div class="actions">
      <button class="primary" type="button" @click="emit('toggleSpeaking')">
        {{ props.speaking ? '停止说话' : '模拟说话' }}
      </button>
      <button type="button" @click="emit('beat')">
        触发节拍
      </button>
      <button type="button" @click="emit('toggleAutoBlink')">
        自动眨眼：{{ props.autoBlink ? '开' : '关' }}
      </button>
    </div>

    <dl class="parameter-grid">
      <div><dt>ParamAngleX</dt><dd>{{ format(parameters.angleX) }}</dd></div>
      <div><dt>ParamAngleY</dt><dd>{{ format(parameters.angleY) }}</dd></div>
      <div><dt>ParamAngleZ</dt><dd>{{ format(parameters.angleZ) }}</dd></div>
      <div><dt>ParamEyeLOpen/R</dt><dd>{{ format(parameters.eyeOpen) }}</dd></div>
      <div><dt>ParamEyeBallX/Y</dt><dd>{{ format(parameters.eyeX) }} / {{ format(parameters.eyeY) }}</dd></div>
      <div><dt>ParamMouthOpenY</dt><dd>{{ format(parameters.mouthOpen) }}</dd></div>
      <div><dt>ParamBodyAngleX</dt><dd>{{ format(parameters.bodyAngleX) }}</dd></div>
      <div><dt>ParamBreath</dt><dd>{{ format(parameters.breath) }}</dd></div>
    </dl>

    <p class="disclaimer">
      这是分层代理绑定，不会生成 Cubism 的 ArtMesh 或 .moc3。参数命名、输入含义和动作节奏与 AIRI 对齐，因此以后换成正式模型时控制逻辑可以保留。
    </p>
  </aside>
</template>

<script setup lang="ts">
import type { MimoLanguage } from '../lib/transcribe'

const apiKey = defineModel<string>('apiKey', { required: true })
const baseUrl = defineModel<string>('baseUrl', { required: true })
const model = defineModel<string>('model', { required: true })
const language = defineModel<MimoLanguage>('language', { required: true })
</script>

<template>
  <section class="panel">
    <div class="section-heading">
      <div>
        <p class="eyebrow">
          Provider
        </p>
        <h2>MiMo ASR连接</h2>
      </div>
      <span class="privacy-pill">仅保存在当前页面内存</span>
    </div>
    <div class="form-grid">
      <label class="field field-wide">
        <span>API Key</span>
        <input v-model="apiKey" type="password" autocomplete="off" placeholder="输入新的 MiMo API Key">
      </label>
      <label class="field field-wide">
        <span>Base URL</span>
        <input v-model="baseUrl" type="url">
      </label>
      <label class="field">
        <span>模型</span>
        <input v-model="model" type="text">
      </label>
      <label class="field">
        <span>语言</span>
        <select v-model="language">
          <option value="auto">自动</option>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>
    </div>
  </section>
</template>

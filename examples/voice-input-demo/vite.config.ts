import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [Vue()],
  root: import.meta.dirname,
  server: {
    host: '127.0.0.1',
    port: 4178,
  },
  worker: {
    format: 'es',
  },
})

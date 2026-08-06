import { cwd } from 'node:process'
import { fileURLToPath } from 'node:url'

import vue from '@vitejs/plugin-vue'

import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    vue(),
  ],
  resolve: {
    alias: {
      // `~build/time` and `~build/git` are virtual modules injected by the
      // Vite build plugin; resolve them to static mocks under Vitest.
      '~build/git': fileURLToPath(new URL('./src/test/mocks/build-git.ts', import.meta.url)),
      '~build/time': fileURLToPath(new URL('./src/test/mocks/build-time.ts', import.meta.url)),
    },
  },
  test: {
    env: loadEnv('test', cwd(), ''),
    exclude: ['**/node_modules/**', '**/.git/**'],
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})

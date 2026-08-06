import Vue from '@vitejs/plugin-vue'

import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [Vue()],
  root: import.meta.dirname,
  test: {
    projects: [
      {
        extends: true,
        test: {
          exclude: ['src/**/*.browser.test.ts'],
          include: ['src/**/*.test.ts'],
          name: 'node',
        },
      },
      {
        extends: true,
        test: {
          browser: {
            enabled: true,
            instances: [
              { browser: 'chromium' },
            ],
            provider: playwright(),
          },
          exclude: ['**/node_modules/**'],
          include: ['src/**/*.browser.{spec,test}.ts'],
          name: 'browser',
        },
      },
    ],
  },
})

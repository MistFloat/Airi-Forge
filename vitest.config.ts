import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'apps/stage-tamagotchi',
      'packages/core-agent',
      'packages/better-ws',
      'packages/plugin-sdk',
      'packages/plugin-sdk-tamagotchi',
      'packages/server-runtime',
      'packages/server-sdk',
      'packages/stage-shared',
    ],
  },
})

<script setup lang="ts">
import { InstructionManager } from '@proj-airi/stage-ui/components'
</script>

<template>
  <InstructionManager />
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.instructions.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.modules.instructions.description
  icon: i-solar:book-bookmark-bold-duotone
  settingsEntry: true
  order: 5.5
  stageTransition:
    name: slide
</route>

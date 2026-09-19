<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useWorkspaceStore } from '@proj-airi/stage-ui/stores/modules/workspace'
import { Button } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'

/**
 * Workspace selection.
 *
 * The chosen folder becomes the boundary the filesystem tools (the coding-agent
 * MCP server) are scoped to, and the model is told about it in its system prompt.
 */
const workspaceStore = useWorkspaceStore()
const { root } = storeToRefs(workspaceStore)
const error = ref<string | undefined>()
const busy = ref(false)

async function choose() {
  busy.value = true
  error.value = undefined
  try {
    await workspaceStore.pick()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Could not update the workspace'
  }
  finally {
    busy.value = false
  }
}

async function clear() {
  busy.value = true
  error.value = undefined
  try {
    await workspaceStore.set()
  }
  catch (cause) {
    error.value = errorMessageFrom(cause) ?? 'Could not update the workspace'
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div :class="['flex flex-col gap-4']">
    <section
      :class="[
        'rounded-2xl p-4',
        'border border-neutral-200/70 bg-white/60 dark:border-neutral-800/70 dark:bg-neutral-900/50',
      ]"
    >
      <div :class="['flex items-center gap-2', 'text-sm font-semibold']">
        <div :class="['i-solar:folder-path-connect-bold-duotone', 'text-primary-500']" />
        <span>Workspace</span>
      </div>
      <p :class="['mt-1 text-xs', 'text-neutral-500 dark:text-neutral-400']">
        The folder the agent may read, write and search. Filesystem tools are scoped to it, and every tool validates paths against it.
      </p>

      <div :class="['mt-3 flex flex-wrap items-center gap-2']">
        <code
          :class="[
            'min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-xs',
            'bg-neutral-100 dark:bg-neutral-800',
            'text-neutral-700 dark:text-neutral-200',
          ]"
        >
          {{ root || 'No workspace selected' }}
        </code>
        <Button :disabled="busy" size="sm" icon="i-solar:folder-open-bold-duotone" label="Choose folder" @click="choose" />
        <Button v-if="root" :disabled="busy" size="sm" variant="ghost" icon="i-solar:trash-bin-trash-bold-duotone" label="Clear" @click="clear" />
      </div>

      <p v-if="error" :class="['mt-2 text-xs', 'text-red-500']">
        {{ error }}
      </p>
      <p v-else-if="root" :class="['mt-2 text-xs', 'text-neutral-500 dark:text-neutral-400']">
        The coding-agent MCP server is pointed at this folder; restart the app if a tool still reports the previous workspace.
      </p>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  settingsEntry: true
  title: Workspace
  description: Choose the folder the agent may operate in
  icon: i-solar:folder-path-connect-bold-duotone
  order: 40
  stageTransition:
    name: slide
</route>

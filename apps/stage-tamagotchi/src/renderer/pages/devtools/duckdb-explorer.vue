<script setup lang="ts">
import { useDuckDb } from '@proj-airi/stage-ui/composables/use-duck-db'
import { Button, FieldInput } from '@proj-airi/ui'
import { sql } from 'drizzle-orm'
import { computed, onMounted, ref } from 'vue'

interface ShortTermMemoryTurn extends Record<string, unknown> {
  id: string
  sessionId: string
  userText: string
  assistantText: string
  createdAt: number
}

interface EditableTurn {
  id: string
  sessionId: string
  userText: string
  assistantText: string
  createdAt: number
}

const { getDb } = useDuckDb()
const turns = ref<ShortTermMemoryTurn[]>([])
const filterSessionId = ref('')
const loading = ref(false)
const errorMessage = ref('')
const editingTurn = ref<EditableTurn | null>(null)
const confirmDialog = ref<{ open: boolean, title: string, message: string, onConfirm: () => void } | null>(null)

async function db() {
  const ref = await getDb()
  const client = ref.value
  if (!client)
    throw new Error('DuckDB is not initialized')
  return client
}

async function refreshTurns() {
  loading.value = true
  errorMessage.value = ''
  try {
    const client = await db()
    const rows = await client.execute<ShortTermMemoryTurn>(sql`
      SELECT id, session_id AS sessionId, user_text AS userText,
             assistant_text AS assistantText, created_at AS createdAt
      FROM short_term_memory_turns
      ORDER BY created_at DESC
      LIMIT 500
    `)
    turns.value = rows
  }
  catch (error) {
    errorMessage.value = `Failed to load turns: ${error}`
  }
  finally {
    loading.value = false
  }
}

const filteredTurns = computed(() => {
  if (!filterSessionId.value.trim())
    return turns.value
  const needle = filterSessionId.value.trim().toLowerCase()
  return turns.value.filter(turn =>
    turn.sessionId.toLowerCase().includes(needle)
    || turn.userText.toLowerCase().includes(needle)
    || turn.assistantText.toLowerCase().includes(needle),
  )
})

const sessionStats = computed(() => {
  const sessions = new Set(turns.value.map(turn => turn.sessionId))
  return {
    sessionCount: sessions.size,
    turnCount: turns.value.length,
  }
})

function deleteTurn(id: string) {
  confirmDialog.value = {
    message: `This will permanently remove turn ${id}.`,
    onConfirm: async () => {
      try {
        const client = await db()
        await client.execute(sql`DELETE FROM short_term_memory_turns WHERE id = ${id}`)
        await refreshTurns()
      }
      catch (error) {
        errorMessage.value = `Failed to delete turn: ${error}`
      }
      finally {
        confirmDialog.value = null
      }
    },
    open: true,
    title: 'Delete turn?',
  }
}

function clearAll() {
  confirmDialog.value = {
    message: 'Delete ALL short-term memory turns? This cannot be undone.',
    onConfirm: async () => {
      try {
        const client = await db()
        await client.execute(sql`DELETE FROM short_term_memory_turns`)
        await refreshTurns()
      }
      catch (error) {
        errorMessage.value = `Failed to clear turns: ${error}`
      }
      finally {
        confirmDialog.value = null
      }
    },
    open: true,
    title: 'Clear all memory?',
  }
}

function startEdit(turn: ShortTermMemoryTurn) {
  editingTurn.value = { ...turn }
}

function cancelEdit() {
  editingTurn.value = null
}

async function saveEdit() {
  if (!editingTurn.value)
    return
  try {
    const client = await db()
    await client.execute(sql`
      UPDATE short_term_memory_turns
      SET user_text = ${editingTurn.value.userText},
          assistant_text = ${editingTurn.value.assistantText}
      WHERE id = ${editingTurn.value.id}
    `)
    editingTurn.value = null
    await refreshTurns()
  }
  catch (error) {
    errorMessage.value = `Failed to save turn: ${error}`
  }
}

onMounted(() => {
  void refreshTurns()
})
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold">
        DuckDB Short-term Memory Explorer
      </h1>
      <div class="flex gap-2">
        <Button size="sm" variant="secondary" @click="refreshTurns">
          Refresh
        </Button>
        <Button size="sm" variant="danger" @click="clearAll">
          Clear All
        </Button>
      </div>
    </div>

    <div class="text-sm text-neutral-500">
      Turns: {{ sessionStats.turnCount }} | Sessions: {{ sessionStats.sessionCount }}
    </div>

    <FieldInput
      v-model="filterSessionId"
      label="Filter by session ID or text"
      placeholder="Type to filter..."
    />

    <div v-if="loading" class="text-sm text-neutral-500">
      Loading...
    </div>

    <div v-if="errorMessage" class="rounded-lg bg-red-100 p-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
      {{ errorMessage }}
    </div>

    <div v-if="!loading && filteredTurns.length === 0" class="text-sm text-neutral-500">
      No turns found.
    </div>

    <div
      v-if="confirmDialog?.open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div class="max-w-md w-full rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-900">
        <h3 class="mb-2 text-lg font-bold">
          {{ confirmDialog.title }}
        </h3>
        <p class="mb-4 text-sm text-neutral-600 dark:text-neutral-300">
          {{ confirmDialog.message }}
        </p>
        <div class="flex justify-end gap-2">
          <Button variant="secondary" @click="confirmDialog = null">
            Cancel
          </Button>
          <Button variant="danger" @click="confirmDialog.onConfirm">
            Confirm
          </Button>
        </div>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      <div
        v-for="turn in filteredTurns" :key="turn.id"
        class="border border-neutral-200 rounded-lg bg-white p-4 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div v-if="editingTurn?.id === turn.id" class="flex flex-col gap-3">
          <div class="text-xs text-neutral-500">
            Editing {{ turn.id }} | Session: {{ turn.sessionId }} | {{ new Date(turn.createdAt).toLocaleString() }}
          </div>
          <FieldInput v-model="editingTurn.userText" label="User" multiline />
          <FieldInput v-model="editingTurn.assistantText" label="Assistant" multiline />
          <div class="flex gap-2">
            <Button size="sm" @click="saveEdit">
              Save
            </Button>
            <Button size="sm" variant="secondary" @click="cancelEdit">
              Cancel
            </Button>
          </div>
        </div>

        <div v-else class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <div class="text-xs text-neutral-500">
              {{ turn.id }} | Session: {{ turn.sessionId }} | {{ new Date(turn.createdAt).toLocaleString() }}
            </div>
            <div class="flex gap-2">
              <Button size="sm" variant="secondary" @click="startEdit(turn)">
                Edit
              </Button>
              <Button size="sm" variant="danger" @click="deleteTurn(turn.id)">
                Delete
              </Button>
            </div>
          </div>
          <div class="text-sm">
            <span class="text-green-600 font-semibold dark:text-green-400">User:</span> {{ turn.userText }}
          </div>
          <div class="text-sm">
            <span class="text-blue-600 font-semibold dark:text-blue-400">Assistant:</span> {{ turn.assistantText }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: DuckDB Explorer
  subtitleKey: tamagotchi.settings.devtools.title
</route>

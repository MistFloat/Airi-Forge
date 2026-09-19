import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/**
 * Workspace selection as the renderer sees it.
 *
 * Mirrors the platform payload structurally; the desktop host defines the IPC
 * contract, and keeping the renderer type local avoids depending on app code.
 */
export interface WorkspaceState {
  /** Absolute path of the bundled coding-agent service, when resolvable. */
  mcpServiceDirectory?: string
  /** Selected workspace root, absent until one is chosen. */
  root?: string
}

/**
 * Platform transport for the agent workspace selection.
 *
 * The Electron main process owns the native folder picker and the persisted
 * root; the renderer only reads it, asks for a pick, or clears it.
 */
export interface WorkspaceTransport {
  /** Clears the selection. */
  clear: () => Promise<WorkspaceState>
  /** Reads the persisted selection. */
  get: () => Promise<WorkspaceState>
  /** Opens the native folder picker and persists the result. */
  pick: () => Promise<WorkspaceState>
  /** Sets an explicit root, rejecting paths that are not directories. */
  set: (root: string) => Promise<WorkspaceState>
}

let activeTransport: undefined | WorkspaceTransport

/**
 * Installs the platform workspace transport with ownership-safe cleanup.
 *
 * The returned disposer only clears the transport when it is still the one this
 * call installed, so a newer owner is never clobbered by an older one.
 */
export function configureWorkspaceTransport(transport?: WorkspaceTransport): () => void {
  activeTransport = transport
  return () => {
    if (activeTransport === transport)
      activeTransport = undefined
  }
}

/**
 * Renderer-side view of the agent workspace.
 *
 * The root is the boundary every filesystem tool validates against, so the
 * store keeps exactly what the main process reports instead of guessing.
 */
export const useWorkspaceStore = defineStore('workspace', () => {
  const root = ref<string | undefined>(undefined)

  /** Replaces the local view with one authoritative state. */
  function applyState(state: WorkspaceState): void {
    root.value = state.root
  }

  function setRoot(next: string | undefined): void {
    root.value = next
  }

  /** Loads the persisted selection; fails soft so a missing host is not fatal. */
  async function refresh(): Promise<void> {
    if (!activeTransport)
      return
    try {
      applyState(await activeTransport.get())
    }
    catch (error) {
      console.error('Failed to read the agent workspace:', error)
    }
  }

  /** Opens the native picker and applies its result. */
  async function pick(): Promise<string | undefined> {
    if (!activeTransport)
      return undefined
    const state = await activeTransport.pick()
    applyState(state)
    return state.root
  }

  /** Sets an explicit root, or clears the selection when given nothing. */
  async function set(next?: string): Promise<string | undefined> {
    if (!activeTransport)
      return undefined
    const state = next ? await activeTransport.set(next) : await activeTransport.clear()
    applyState(state)
    return state.root
  }

  function hasTransport(): boolean {
    return activeTransport !== undefined
  }

  /**
   * Prompt line telling the model where it may operate.
   *
   * Empty without a workspace, so an unconfigured app adds no prompt noise.
   */
  const promptLine = computed(() => root.value
    ? `## Workspace\n\nThe user selected this workspace: \`${root.value}\`.\nFilesystem tools (MCP servers such as the coding agent) are scoped to it; ask before operating outside.`
    : '')

  return {
    applyState,
    hasTransport,
    pick,
    promptLine,
    refresh,
    root,
    set,
    setRoot,
  }
})

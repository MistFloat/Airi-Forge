import type { WorkspaceTransport } from '@proj-airi/stage-ui/stores/modules/workspace'

import type { ElectronMcpStdioConfigFile, ElectronMcpStdioServerConfig, ElectronWorkspaceState } from '../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { configureWorkspaceTransport, useWorkspaceStore } from '@proj-airi/stage-ui/stores/modules/workspace'
import { watch } from 'vue'

import {
  electronMcpApplyAndRestart,
  electronMcpReadConfigText,
  electronMcpWriteConfigText,
  electronWorkspaceChanged,
  electronWorkspaceGet,
  electronWorkspacePick,
  electronWorkspaceSet,
} from '../../shared/eventa'

/** Name of the MCP server entry the workspace drives. */
export const WORKSPACE_MCP_SERVER_NAME = 'coding-agent'

/**
 * Points the coding-agent MCP server at the selected workspace.
 *
 * The server resolves its workdir from `CODING_AGENT_WORKDIR` (falling back to
 * its own cwd), so the workspace is written to that variable while the entry
 * keeps running from the service directory.
 *
 * Returns the config unchanged when the workspace is cleared, so removing a
 * workspace stops the tool from being scoped to a stale path.
 *
 * @param config - Parsed MCP config file.
 * @param root - Selected workspace root, or undefined when none is selected.
 * @param serviceDirectory - Absolute path of the coding-agent service.
 */
export function applyWorkspaceToMcpConfig(
  config: ElectronMcpStdioConfigFile,
  root: string | undefined,
  serviceDirectory: string,
): ElectronMcpStdioConfigFile {
  const existing = config.mcpServers?.[WORKSPACE_MCP_SERVER_NAME]

  if (!root) {
    if (!existing)
      return config

    const { [WORKSPACE_MCP_SERVER_NAME]: _removed, ...rest } = config.mcpServers
    return { ...config, mcpServers: rest }
  }

  const server: ElectronMcpStdioServerConfig = {
    ...existing,
    args: existing?.args ?? ['exec', 'tsx', 'src/index.ts'],
    command: existing?.command ?? 'pnpm',
    cwd: serviceDirectory,
    env: { ...existing?.env, CODING_AGENT_WORKDIR: root },
  }

  return {
    ...config,
    mcpServers: { ...config.mcpServers, [WORKSPACE_MCP_SERVER_NAME]: server },
  }
}

/**
 * Connects the renderer workspace store to the main process, and keeps the
 * coding-agent MCP entry pointed at the selected workspace.
 *
 * Call this after Pinia is installed: the bridge reads the store immediately.
 */
export function initializeAgentWorkspaceBridge(transport: WorkspaceTransport = createEventaTransport()): () => void {
  const context = getElectronEventaContext()
  const store = useWorkspaceStore()
  const disposeTransport = configureWorkspaceTransport(transport)
  const readConfig = defineInvoke(context, electronMcpReadConfigText)
  const writeConfig = defineInvoke(context, electronMcpWriteConfigText)
  const applyConfig = defineInvoke(context, electronMcpApplyAndRestart)
  let serviceDirectory: string | undefined

  /**
   * Mirrors the workspace into the MCP config.
   *
   * Failures are logged instead of thrown: an unusable MCP config must not take
   * down the window that just picked a folder.
   */
  async function syncMcpConfig(root: string | undefined) {
    if (!serviceDirectory)
      return

    try {
      const current = await readConfig()
      const parsed = JSON.parse(current.text) as ElectronMcpStdioConfigFile
      const next = applyWorkspaceToMcpConfig(parsed, root, serviceDirectory)
      if (JSON.stringify(next) === JSON.stringify(parsed))
        return

      await writeConfig({ text: `${JSON.stringify(next, null, 2)}\n` })
      await applyConfig()
    }
    catch (error) {
      console.error('Failed to point the coding-agent MCP server at the workspace:', error)
    }
  }

  context.on(electronWorkspaceChanged, (event: { body?: ElectronWorkspaceState }) => {
    if (!event.body)
      return

    serviceDirectory = event.body.mcpServiceDirectory
    store.applyState(event.body)
  })

  const stopWatching = watch(() => store.root, root => void syncMcpConfig(root))

  void (async () => {
    await store.refresh()
    serviceDirectory ??= (await defineInvoke(context, electronWorkspaceGet)()).mcpServiceDirectory
  })()

  return () => {
    stopWatching()
    disposeTransport()
  }
}

function createEventaTransport(): WorkspaceTransport {
  const context = getElectronEventaContext()

  return {
    clear: () => defineInvoke(context, electronWorkspaceSet)({ root: null }),
    get: defineInvoke(context, electronWorkspaceGet),
    pick: defineInvoke(context, electronWorkspacePick),
    set: root => defineInvoke(context, electronWorkspaceSet)({ root }),
  }
}

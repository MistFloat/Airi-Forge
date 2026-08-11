import type { ChatToolCallRendererRegistry } from '@proj-airi/stage-ui/components'
import type { McpToolRuntime } from '@proj-airi/stage-ui/tools/mcp'
import type { Component } from 'vue'

import type { ElectronMcpToolDescriptor, ElectronMcpToolProgressPayload } from '../../shared/eventa'

import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { useMemoryLongTermStore } from '@proj-airi/stage-ui/stores/modules/memory-long-term'
import { createMcpDirectTools, createMcpTools, sanitizeMcpToolName } from '@proj-airi/stage-ui/tools/mcp'
import { createMemoryMcpRuntime } from '@proj-airi/stage-ui/tools/memory-mcp'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import McpToolCallBlock from '../components/chat-tool-renderers/mcp-tool-call-block.vue'

import { electronMcpCallTool, electronMcpListTools, electronMcpToolProgress } from '../../shared/eventa'

/**
 * Registers Electron-backed MCP tools into the shared LLM tools store and
 * bridges live tool progress from the main process into chat renderers.
 *
 * Use when:
 * - The Tamagotchi renderer needs live MCP tools during chat streaming
 * - Chat tool-call blocks want to show `notifications/progress` from a server
 *
 * Expects:
 * - Electron Eventa handlers for MCP listing and invocation are available
 *
 * Returns:
 * - Store actions for refreshing, disposing, and progress-aware renderers
 */
export const useTamagotchiMcpToolsStore = defineStore('tamagotchi-mcp-tools', () => {
  const llmToolsStore = useLlmToolsStore()
  const memoryStore = useMemoryLongTermStore()
  const listMcpTools = useElectronEventaInvoke(electronMcpListTools)
  const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
  const context = useElectronEventaContext()

  let cachedTools: ElectronMcpToolDescriptor[] = []
  let progressDisposer: (() => void) | undefined
  const mcpToolNames = ref<string[]>([])
  const lastToolProgress = ref<ElectronMcpToolProgressPayload | undefined>(undefined)

  // The main process emits one progress event per MCP tool execution; keeping
  // only the latest matches the sequential agent loop and lets each tool-call
  // block pick its own progress by qualified name.
  progressDisposer = context.value.on(electronMcpToolProgress, (event) => {
    if (event?.body)
      lastToolProgress.value = event.body
  })

  const mcpToolCallRenderers = computed<ChatToolCallRendererRegistry>(() => {
    const registry: Record<string, Component> = {}
    for (const name of mcpToolNames.value)
      registry[name] = McpToolCallBlock
    return registry
  })

  async function refresh() {
    const electronRuntime: McpToolRuntime = {
      callTool: payload => callMcpTool(payload),
      listTools: async () => cachedTools,
    }
    const memoryRuntime = createMemoryMcpRuntime(memoryStore)
    const externalTools = await listMcpTools()
    const memoryTools = await memoryRuntime.listTools()
    cachedTools = [...externalTools, ...memoryTools]
    // Use sanitized names so the renderer registry keys match the
    // provider-facing tool function names (e.g. "coding-agent__git_status").
    mcpToolNames.value = cachedTools.map(tool => sanitizeMcpToolName(tool.name))
    const runtime: McpToolRuntime = {
      callTool: payload => payload.name.startsWith('memory::')
        ? memoryRuntime.callTool(payload)
        : electronRuntime.callTool(payload),
      listTools: async () => cachedTools,
    }
    // Register both the meta-tools (builtIn_mcpListTools / builtIn_mcpCallTool)
    // and direct tools (e.g. `coding-agent::git_status`) so the model can call
    // MCP tools by their qualified name without the two-step indirection.
    // Meta-tools remain as a discovery fallback for tools added after refresh.
    const [metaTools, directTools] = await Promise.all([
      Promise.all(createMcpTools(runtime)),
      createMcpDirectTools(runtime),
    ])
    return llmToolsStore.registerTools('mcp', [...metaTools, ...directTools])
  }

  function dispose() {
    llmToolsStore.clearTools('mcp')
    progressDisposer?.()
    progressDisposer = undefined
  }

  return {
    dispose,
    lastToolProgress,
    mcpToolCallRenderers,
    refresh,
  }
})

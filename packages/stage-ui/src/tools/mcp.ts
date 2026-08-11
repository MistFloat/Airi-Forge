import type { Tool } from '@xsai/shared-chat'

import { errorMessageFromValue } from '@proj-airi/stage-shared'
import { tool } from '@xsai/tool'
import { z } from 'zod'

/**
 * Payload for invoking an MCP tool through a runtime-specific transport.
 *
 * Use when:
 * - A runtime needs to forward a tool invocation into the MCP layer
 *
 * Expects:
 * - `name` matches a descriptor returned from `listTools`
 * - `arguments` is a JSON-compatible object when provided
 *
 * Returns:
 * - The MCP tool call input envelope
 */
export interface McpCallToolPayload {
  arguments?: Record<string, unknown>
  name: string
}

/**
 * Result returned from an MCP tool invocation.
 *
 * Use when:
 * - An MCP runtime returns tool output back to the shared LLM layer
 *
 * Expects:
 * - Error responses set `isError` when the tool execution failed
 *
 * Returns:
 * - Structured and unstructured MCP tool output
 */
export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  isError?: boolean
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
}

/**
 * Describes an MCP tool that can be exposed to the shared LLM runtime.
 *
 * Use when:
 * - A runtime needs to list available MCP tools before exposing them to models
 *
 * Expects:
 * - `name` is the fully-qualified tool name used for invocation
 *
 * Returns:
 * - The MCP tool descriptor metadata reported by the runtime
 */
export interface McpToolDescriptor {
  description?: string
  inputSchema: Record<string, unknown>
  name: string
  serverName: string
  toolName: string
}

/**
 * Runtime contract for wiring MCP tool discovery and execution into `stage-ui`.
 *
 * Use when:
 * - A concrete runtime such as Electron needs to provide MCP access without a singleton bridge
 *
 * Expects:
 * - `listTools` and `callTool` are safe to call multiple times
 *
 * Returns:
 * - An object that can back `createMcpTools`
 */
export interface McpToolRuntime {
  callTool: (payload: McpCallToolPayload) => Promise<McpCallToolResult>
  listTools: () => Promise<McpToolDescriptor[]>
}

/**
 * Separator used in MCP qualified tool names (`serverName::toolName`).
 * Internal only — provider-facing names use `sanitizeMcpToolName` to replace
 * it with `__` because providers like DeepSeek/OpenAI require
 * `^[a-zA-Z0-9_-]+$` and reject colons.
 */
const MCP_TOOL_NAME_SEPARATOR = '::'
const PROVIDER_SAFE_SEPARATOR = '__'

/**
 * Creates direct xsai tool definitions for every MCP tool reported by the runtime.
 *
 * Each MCP tool becomes a first-class tool the model can call by its
 * provider-safe name (e.g. `coding-agent__git_status`), instead of forcing
 * the model through the two-step `builtIn_mcpListTools` →
 * `builtIn_mcpCallTool` indirection.
 *
 * The `function.name` is sanitized (`::` → `__`) to satisfy provider naming
 * patterns, but the `execute` callback preserves the original qualified name
 * for MCP dispatch.
 *
 * Use when:
 * - A runtime wants MCP tools directly callable by the model
 *
 * Expects:
 * - The runtime implements the `McpToolRuntime` contract
 *
 * Returns:
 * - xsai tool definitions mirroring the MCP server's tool list, or an empty
 *   array when the runtime cannot list tools
 */
export async function createMcpDirectTools(runtime: McpToolRuntime): Promise<Tool[]> {
  let descriptors: McpToolDescriptor[]
  try {
    descriptors = await runtime.listTools()
  }
  catch (error) {
    console.warn('[createMcpDirectTools] failed to list MCP tools:', error)
    return []
  }

  return descriptors.map(descriptor => createDirectMcpTool(descriptor, runtime))
}

/**
 * Creates MCP proxy tools backed by a runtime-provided transport.
 *
 * Use when:
 * - A runtime wants to register MCP tools into the shared LLM tool store
 *
 * Expects:
 * - The runtime implements the `McpToolRuntime` contract
 *
 * Returns:
 * - xsai tool definition promises for MCP listing and invocation
 */
export function createMcpTools(runtime: McpToolRuntime): Array<Promise<Tool>> {
  return [
    tool({
      description: 'List all available MCP tools. Call this first to discover tool names before calling builtIn_mcpCallTool.',
      execute: async () => {
        try {
          return await runtime.listTools()
        }
        catch (error) {
          console.warn('[builtIn_mcpListTools] failed to list tools:', error)
          return ''
        }
      },
      name: 'builtIn_mcpListTools',
      parameters: z.object({}).strict(),
    }),
    tool({
      description: 'Call an MCP tool by name. Use builtIn_mcpListTools first to get available tool names. Accepts both "server::tool" and "server__tool" name formats.',
      execute: async ({ arguments: argsJson, name }) => {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {}
          // Accept both "::" (from builtIn_mcpListTools) and "__" (from direct
          // tool names) so the model can use either form interchangeably.
          const qualifiedName = name.includes(MCP_TOOL_NAME_SEPARATOR)
            ? name
            : desanitizeMcpToolName(name)
          const result = await runtime.callTool({ arguments: args, name: qualifiedName })
          return boundMcpResultForModelHistory(result)
        }
        catch (error) {
          return {
            content: [{ text: errorMessageFromValue(error), type: 'text' }],
            isError: true,
          }
        }
      },
      name: 'builtIn_mcpCallTool',
      // NOTICE: `arguments` is z.string() (JSON) because z.unknown() produces `{}` (no `type` key)
      // and z.record() emits `propertyNames`, both rejected by OpenAI.
      parameters: z.object({
        arguments: z.string().describe('JSON object of tool arguments, e.g. {"query":"hello","limit":10}'),
        name: z.string().describe('Tool name in "serverName::toolName" or "serverName__toolName" format'),
      }).strict(),
    }),
  ]
}

/**
 * Reverses {@link sanitizeMcpToolName}: converts a provider-safe name back to
 * the MCP qualified format. Used by `builtIn_mcpCallTool` so the meta-tool
 * accepts both `::` (from `builtIn_mcpListTools`) and `__` (from direct tool
 * names) formats.
 *
 * Before: `coding-agent__git_status`
 * After:  `coding-agent::git_status`
 */
export function desanitizeMcpToolName(providerSafeName: string): string {
  // Only replace the FIRST `__` to avoid corrupting tool names that
  // legitimately contain double underscores after the server prefix.
  const idx = providerSafeName.indexOf(PROVIDER_SAFE_SEPARATOR)
  if (idx <= 0 || idx === providerSafeName.length - PROVIDER_SAFE_SEPARATOR.length)
    return providerSafeName
  return providerSafeName.slice(0, idx)
    + MCP_TOOL_NAME_SEPARATOR
    + providerSafeName.slice(idx + PROVIDER_SAFE_SEPARATOR.length)
}

/**
 * Builds the default stage-ui MCP tool set without depending on runtime singletons.
 *
 * Use when:
 * - Shared code needs the MCP tool schema before a concrete runtime registers live implementations
 *
 * Expects:
 * - Runtime-specific callers override these tools through `useLlmToolsStore`
 *
 * Returns:
 * - MCP tool definitions with an unavailable-runtime fallback
 */
export async function mcp(): Promise<Tool[]> {
  return await Promise.all(createMcpTools(createUnavailableMcpToolRuntime()))
}

/**
 * Converts an MCP qualified tool name to a provider-safe function name.
 *
 * Providers like DeepSeek/OpenAI require `function.name` to match
 * `^[a-zA-Z0-9_-]+$`. The MCP qualified name format `serverName::toolName`
 * contains colons which are invalid. Replaces `::` with `__` so the model
 * can call the tool directly.
 *
 * Before: `coding-agent::git_status`
 * After:  `coding-agent__git_status`
 */
export function sanitizeMcpToolName(qualifiedName: string): string {
  return qualifiedName.split(MCP_TOOL_NAME_SEPARATOR).join(PROVIDER_SAFE_SEPARATOR)
}

/**
 * Bounds an MCP result before xsAI serializes it into the conversation history.
 * Small results retain their original structure; oversized results keep the
 * beginning and end so the model sees both command context and trailing errors.
 */
function boundMcpResultForModelHistory(result: McpCallToolResult): McpCallToolResult {
  let serialized: string
  try {
    serialized = JSON.stringify(result)
  }
  catch (error) {
    return {
      content: [{
        text: `MCP result could not be serialized by AIRI: ${errorMessageFromValue(error)}`,
        type: 'text',
      }],
      isError: true,
      structuredContent: { airiSerializationFailed: true },
    }
  }

  // A roughly 24k-character ceiling leaves useful tool evidence while
  // preventing one read/search response from dominating every subsequent
  // provider request in the same agent loop.
  const maxSerializedCharacters = 24_000
  if (serialized.length <= maxSerializedCharacters)
    return result

  const preservedHead = serialized.slice(0, 18_000)
  const preservedTail = serialized.slice(-4_000)
  return {
    content: [{
      text: [
        `[MCP result truncated by AIRI: ${serialized.length} serialized characters; request a narrower range or query to retrieve omitted data.]`,
        preservedHead,
        '[... omitted ...]',
        preservedTail,
      ].join('\n'),
      type: 'text',
    }],
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    structuredContent: {
      airiOriginalSerializedCharacters: serialized.length,
      airiTruncated: true,
    },
  }
}

function createDirectMcpTool(descriptor: McpToolDescriptor, runtime: McpToolRuntime): Tool {
  return {
    execute: async (input: unknown) => {
      // NOTICE: xsai parses the model's tool-call arguments string via
      // JSON.parse before passing the result as `input`. For MCP tools the
      // arguments object is forwarded as-is to the MCP server's callTool.
      const args = isPlainObject(input) ? input : undefined
      try {
        // Use the original qualified name (with "::") for MCP dispatch —
        // the main process splits on "::" to find the server + tool.
        const result = await runtime.callTool({ arguments: args, name: descriptor.name })
        return boundMcpResultForModelHistory(result)
      }
      catch (error) {
        // Return an MCP-style error result instead of throwing so the model
        // receives structured feedback rather than killing the stream.
        return {
          content: [{ text: errorMessageFromValue(error), type: 'text' }],
          isError: true,
        }
      }
    },
    function: {
      description: descriptor.description ?? `MCP tool ${descriptor.name}`,
      // Provider-facing name: "::" → "__" to satisfy ^[a-zA-Z0-9_-]+$
      name: sanitizeMcpToolName(descriptor.name),
      parameters: normalizeMcpInputSchema(descriptor.inputSchema),
    },
    type: 'function',
  }
}

function createUnavailableMcpToolRuntime(): McpToolRuntime {
  return {
    async callTool() {
      throw new Error('MCP tools are not available in this runtime.')
    },
    async listTools() {
      throw new Error('MCP tools are not available in this runtime.')
    },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Ensures a JSON Schema from an MCP `inputSchema` is provider-compatible.
 *
 * MCP spec requires `inputSchema` to be a JSON Schema of `type: 'object'`,
 * but some servers omit the `type` field for parameterless tools. OpenAI-
 * compatible providers reject tool schemas without a `type` field, so we
 * default to `'object'` when missing.
 */
function normalizeMcpInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return { type: 'object' }
  if (!('type' in schema))
    return { ...schema, type: 'object' }
  return schema
}

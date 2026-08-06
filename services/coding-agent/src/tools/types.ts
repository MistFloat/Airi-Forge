/**
 * Shared result helpers for MCP tool handlers.
 *
 * Tool handlers return `McpToolResult` (content text + optional structured
 * content + error flag). AIRI's `builtIn_mcpCallTool` proxy passes both
 * `content` and `structuredContent` back to the model, so metadata that the
 * agent needs for its next decision (e.g. truncation state, applied edits)
 * belongs in `structuredContent`, while human-readable output goes in `content`.
 */

export interface McpTextContent {
  text: string
  type: 'text'
}

export interface McpToolResult {
  // NOTICE: The SDK's `Result` schema is a loose object (index signature), so a
  // result type without one is not assignable to `CallToolResult`. Kept loose
  // to stay structurally compatible with the tool callback return type.
  [key: string]: unknown
  content: McpTextContent[]
  isError?: boolean
  structuredContent?: Record<string, unknown>
}

/** Extracts a readable message from an unknown error value. */
export function errorMessageFromValue(error: unknown): string {
  if (error instanceof Error)
    return error.message
  if (typeof error === 'string')
    return error
  return JSON.stringify(error)
}

export function errorResult(message: string, structuredContent?: Record<string, unknown>): McpToolResult {
  return {
    content: [{ text: message, type: 'text' }],
    isError: true,
    structuredContent,
  }
}

export function textResult(text: string, structuredContent?: Record<string, unknown>): McpToolResult {
  return {
    content: [{ text, type: 'text' }],
    structuredContent,
  }
}

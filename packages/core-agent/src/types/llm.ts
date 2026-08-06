import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, CompletionToolCall, CompletionToolResult, Message, Tool } from '@xsai/shared-chat'

export type BuiltinToolsResolver = (model: string, chatProvider: ChatProvider) => Promise<Tool[]>

export type StreamEvent
  = | (any & { type: 'finish' })
    | (CompletionToolCall & { type: 'tool-call' })
    | (CompletionToolResult & { type: 'tool-error' })
    | { error: any, type: 'error' }
    | { result?: CommonContentPart[] | string, toolCallId: string, type: 'tool-result' }
    | { text: string, type: 'reasoning-delta' }
    | { text: string, type: 'text-delta' }

export interface StreamFromOptions {
  builtinToolsResolver?: BuiltinToolsResolver
  chatProvider: ChatProvider
  messages: Message[]
  model: string
  options?: StreamOptions
}

export interface StreamOptions {
  abortSignal?: AbortSignal
  captureToolErrors?: boolean
  /**
   * Per-model runtime cache of whether the provider accepts content-part arrays
   * (e.g. `[{type:'text',...},{type:'image_url',...}]`) for `messages[].content`.
   *
   * Some OpenAI-compatible providers (notably Rust/serde-strict gateways) only
   * deserialize `content` as a plain string and reject arrays with HTTP 400
   * `Failed to deserialize the JSON body into the target type: messages[N]:
   * invalid type: sequence, expected a string`. When a stream surfaces such an
   * error we set the entry to `false` for the model key and force-flatten on
   * the next attempt.
   *
   * Mirrors {@link toolsCompatibility} for the tool-calling capability.
   *
   * See: https://github.com/moeru-ai/airi/issues/1500
   */
  contentArrayCompatibility?: Map<string, boolean>
  headers?: Record<string, string>
  /**
   * Hard ceiling on agent-loop steps (one LLM round trip per step) before the
   * stream stops, guarding against runaway tool loops. Defaults to 50; the old
   * default of 10 was too low for real multi-tool tasks (a task with 11+ tool
   * calls was silently cut off).
   */
  maxSteps?: number
  /**
   * Hard cap on output tokens for a single completion. Many OpenAI-compatible
   * providers default to a low value (e.g. 4096) when unset, silently
   * truncating long responses with `finish_reason: 'length'` — the stream ends
   * without error and the status bar flips to "stopped". Defaults to 16384
   * (the production default across Aider, Cursor, Continue.dev and most
   * open-source coding agents).
   */
  maxTokens?: number
  onStreamEvent?: (event: StreamEvent) => Promise<void> | void
  supportsContentArray?: boolean
  supportsTools?: boolean
  tools?: (() => Promise<Tool[] | undefined>) | Tool[]
  toolsCompatibility?: Map<string, boolean>
  waitForTools?: boolean
}

import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'
import type { StreamTextEvent } from '@xsai/stream-text'

export type BuiltinToolsResolver = (model: string, chatProvider: ChatProvider) => Promise<Tool[]>

/** Events emitted by xsAI while one AIRI completion is streaming. */
export type StreamEvent = StreamTextEvent

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
   * Additional provider calls allowed when a tool-capable model naturally
   * stops immediately after promising an action without issuing a tool call.
   * The retry instruction is provider-local and never persisted as user text.
   *
   * @default 1
   */
  maxActionContinuationAttempts?: number
  /**
   * Number of additional provider calls allowed after a completion ends with
   * `finish_reason: "length"`. Each continuation replays the partial assistant
   * response only inside the provider request context; synthetic continuation
   * instructions are never persisted as user-authored chat history.
   *
   * @default 3
   */
  maxContinuationAttempts?: number
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
  /** Durability barrier run after a tool returns or throws. */
  onToolExecutionFinish?: (context: ToolExecutionFinishContext) => Promise<void> | void
  /** Durability and idempotency barrier run before a model-requested tool side effect starts. */
  onToolExecutionStart?: (context: ToolExecutionStartContext) => Promise<ToolExecutionStartDecision | void> | ToolExecutionStartDecision | void
  supportsContentArray?: boolean
  supportsTools?: boolean
  tools?: (() => Promise<Tool[] | undefined>) | Tool[]
  toolsCompatibility?: Map<string, boolean>
  waitForTools?: boolean
}

/** Terminal context emitted after one admitted tool implementation stops. */
export interface ToolExecutionFinishContext {
  /** Tool execution duration measured by the runtime. */
  durationMs: number
  /** Original failure when the implementation threw. */
  error?: unknown
  /** Parsed provider input committed with the admission. */
  input: unknown
  /** Tool output when the implementation returned normally. */
  output?: unknown
  /** Provider-issued tool-call correlation key. */
  toolCallId: string
  /** Tool name selected by the model. */
  toolName: string
}

/** Admission context emitted immediately before a tool implementation runs. */
export interface ToolExecutionStartContext {
  /** Parsed provider input. */
  input: unknown
  /** Provider-issued tool-call correlation key. */
  toolCallId: string
  /** Tool name selected by the model. */
  toolName: string
}

/** Runtime decision returned by the durable tool execution owner. */
export type ToolExecutionStartDecision
  = | { disposition: 'blocked', status: 'running' | 'uncertain' }
    | { disposition: 'execute' }
    | { disposition: 'replay', error?: string, output?: unknown, status: 'completed' | 'failed' }

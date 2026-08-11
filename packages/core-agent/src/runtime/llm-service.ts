import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool, Usage } from '@xsai/shared-chat'

import type { StreamEvent, StreamFromOptions, StreamOptions } from '../types/llm'

import { stepCountAtLeast } from '@xsai/shared-chat'
import { streamText } from '@xsai/stream-text'

import { errorMessageFromValue } from '../utils/error-message'

export function modelKey(model: string, chatProvider: ChatProvider): string {
  return `${chatProvider.chat(model).baseURL}-${model}`
}

/**
 * Normalize chat messages so they match the wire format the active provider
 * actually accepts, flattening content-part arrays back to plain strings when
 * the provider can't deserialize arrays.
 *
 * Use when:
 * - Composing the final message list right before handing it to the OpenAI-
 *   compatible chat SDK.
 *
 * Expects:
 * - `role: 'error'` entries (AIRI-internal markers from the chat UI). They are
 *   rewritten as user-role narrations so the provider doesn't reject them.
 * - `content` may be a string, a content-part array, or undefined.
 *
 * Returns:
 * - A new array of `Message` values; original objects are not mutated.
 *
 * @param messages - Raw messages from the chat session, may include AIRI's
 *   `error` role.
 * @param supportsContentArray - When `false`, force-flatten every array
 *   content (including text + `image_url` mixes) to a text-only string and
 *   drop non-text parts. Drives the runtime auto-degrade for strict providers.
 *   Defaults to `true` to preserve vision/multimodal payloads on capable
 *   providers.
 */
export function sanitizeMessages(messages: unknown[], supportsContentArray: boolean = true): Message[] {
  return messages.map((message: any) => {
    if (message && message.role === 'error') {
      return {
        content: `User encountered error: ${String(message.content ?? '')}`,
        role: 'user',
      } as Message
    }

    // NOTICE:
    // Flatten array content for providers (e.g. DeepSeek and other Rust/serde-
    // strict OpenAI-compatible gateways) that only accept `messages[].content`
    // as a plain string and reject arrays with `Failed to deserialize the JSON
    // body into the target type: messages[N]: invalid type: sequence, expected
    // a string`.
    // Root cause: OpenAI's chat API permits `content` as either `string` or an
    // array of content parts; some compatible servers only implement the
    // string variant.
    // Source/context: https://github.com/moeru-ai/airi/issues/1500
    // Removal condition: when every supported provider accepts content-part
    // arrays uniformly (no longer realistic for the OpenAI-compatible
    // ecosystem, so this is effectively load-bearing).
    if (message && Array.isArray(message.content)) {
      const contentParts = message.content as { text?: string, type?: string }[]
      const hasNonTextPart = contentParts.some(part => part?.type && part.type !== 'text')
      // When the provider supports arrays, only flatten pure-text arrays so we
      // never silently drop image / audio / file parts on a vision-capable
      // model. When it doesn't, flatten unconditionally; non-text parts are
      // dropped because the provider can't carry them anyway.
      if (!supportsContentArray || !hasNonTextPart) {
        return { ...message, content: contentParts.map(part => part?.text ?? '').join('') } as Message
      }
    }

    return message as Message
  })
}

export async function streamFrom({
  builtinToolsResolver,
  chatProvider,
  messages,
  model,
  options,
}: StreamFromOptions) {
  const chatConfig = chatProvider.chat(model)
  const supportsContentArray = streamOptionsContentArrayCompatibilityOk(model, chatProvider, options)
  const sanitized = sanitizeMessages(messages as unknown[], supportsContentArray)

  const supportedTools = streamOptionsToolsCompatibilityOk(model, chatProvider, options)
  const builtinTools = supportedTools
    ? await (builtinToolsResolver?.(model, chatProvider) ?? Promise.resolve([]))
    : []
  const customTools = supportedTools ? await resolveTools(options) : []
  const mergedTools = supportedTools ? [...builtinTools, ...customTools] : []
  const tools = mergedTools.length > 0 ? mergedTools : undefined
  const capturedToolErrorByCallId = new Map<string, string>()
  const streamTools = options?.captureToolErrors && tools != null
    ? withCapturedToolErrors(tools, capturedToolErrorByCallId)
    : tools

  const configuredContinuationAttempts = options?.maxContinuationAttempts ?? 3
  const maxContinuationAttempts = Number.isFinite(configuredContinuationAttempts)
    ? Math.max(0, Math.floor(configuredContinuationAttempts))
    : 3
  const configuredMaxSteps = options?.maxSteps ?? 50
  const maxSteps = Number.isFinite(configuredMaxSteps)
    ? Math.max(1, Math.floor(configuredMaxSteps))
    : 50
  let remainingSteps = maxSteps
  let continuationAttempts = 0
  let requestMessages = sanitized
  let turnUsage: undefined | Usage
  const textEmitter = createContinuationTextEmitter(text => options?.onStreamEvent?.({ text, type: 'text-delta' }))

  while (true) {
    let callbackError: unknown
    let eventChain = Promise.resolve()
    let pendingFinishEvent: Extract<StreamEvent, { type: 'finish' }> | undefined

    // xsAI currently invokes onEvent without awaiting the returned promise.
    // Serialize AIRI callbacks explicitly so the finish decision cannot race
    // ahead of the last text delta or a consumer-side failure.
    const onEvent = (event: unknown) => {
      eventChain = eventChain
        .then(async () => {
          const resolvedEvent = resolveCapturedToolErrorEvent(event, capturedToolErrorByCallId)
          if (typeof resolvedEvent !== 'object' || resolvedEvent === null || typeof (resolvedEvent as { type?: unknown }).type !== 'string')
            return

          const streamEvent = resolvedEvent as StreamEvent
          if (streamEvent.type === 'text-delta') {
            await textEmitter.push(streamEvent.text)
            return
          }
          if (streamEvent.type === 'finish') {
            const waitingForToolRound = streamEvent.finishReason === 'tool_calls' || streamEvent.finishReason === 'tool-calls'
            if (waitingForToolRound) {
              await options?.onStreamEvent?.(streamEvent)
              return
            }

            // Delay the terminal event until the authoritative `steps` result
            // confirms whether this provider call needs a continuation.
            pendingFinishEvent = streamEvent
            return
          }

          await options?.onStreamEvent?.(streamEvent)
          if (streamEvent.type === 'error')
            throw streamEvent.error
        })
        .catch((error: unknown) => {
          callbackError ??= error
        })

      return eventChain
    }

    const streamResult = streamText({
      ...chatConfig,
      abortSignal: options?.abortSignal,
      headers: options?.headers,
      // NOTICE:
      // Default to 16384 output tokens. Many OpenAI-compatible providers
      // default to a low value (e.g. 4096) when `max_tokens` is unset,
      // silently truncating long responses with `finish_reason: 'length'`.
      // xsai's requestBody() runs objCamelToSnake() so `maxTokens` reaches
      // the provider wire as `max_tokens`.
      // Source/context: `@xsai/shared` request-body serialization and
      // https://github.com/NousResearch/hermes-agent/pull/12846
      // Removal condition: when every supported provider negotiates a safe
      // output limit and never returns `finish_reason: 'length'` unexpectedly.
      maxTokens: options?.maxTokens ?? 16384,
      messages: requestMessages,
      onEvent,
      // The limit covers all tool and continuation calls made for this one
      // AIRI turn, so auto-continuation cannot bypass the agent-loop guard.
      stopWhen: stepCountAtLeast(remainingSteps),
      // OpenAI-compatible streaming responses only include usage when this is
      // requested explicitly. The terminal status badge uses it to diagnose
      // provider output ceilings after the turn settles.
      streamOptions: { includeUsage: true },
      // NOTICE:
      // Do not pass xsAI's `captureToolErrors` option here. In the installed
      // @xsai/stream-text version, stream options are spread into the provider
      // chat body, so unknown runtime-only fields can be rejected upstream.
      // AIRI captures tool failures by wrapping local tool executors instead.
      tools: streamTools,
    })

    // NOTICE:
    // `steps` is the authoritative completion signal for the full xsAI call,
    // including tool rounds. `messages` is needed to replay the partial
    // assistant response without persisting the synthetic continuation prompt.
    // Source/context: installed `@xsai/stream-text` StreamTextResult contract.
    // Removal condition: only if xsAI exposes an awaited terminal callback that
    // also returns the complete provider message history.
    void streamResult.usage.catch(error => console.error('Stream usage error:', error))
    const [steps, completedMessages, callUsage] = await Promise.all([
      streamResult.steps,
      streamResult.messages,
      streamResult.totalUsage,
    ])
    turnUsage = addUsage(turnUsage, callUsage)
    await eventChain
    if (callbackError !== undefined)
      throw callbackError

    const finalStep = steps.at(-1)
    const finishReason = finalStep?.finishReason ?? pendingFinishEvent?.finishReason ?? 'other'
    remainingSteps -= Math.max(steps.length, 1)
    const stoppedAtToolStepLimit = remainingSteps <= 0
      && (finishReason === 'tool_calls' || finishReason === 'tool-calls')

    // Tool-call JSON may itself be incomplete at the token boundary. Replaying
    // it as prose can corrupt call ordering or execute a malformed duplicate,
    // so only plain assistant text is eligible for automatic continuation.
    const hasTruncatedToolCall = (finalStep?.toolCalls.length ?? 0) > 0
    const shouldContinue = finishReason === 'length'
      && !hasTruncatedToolCall
      && continuationAttempts < maxContinuationAttempts
      && remainingSteps > 0
      && !options?.abortSignal?.aborted

    if (shouldContinue) {
      continuationAttempts += 1
      textEmitter.beginContinuation()
      requestMessages = [
        ...completedMessages,
        {
          content: 'Continue exactly where the previous assistant response stopped. Output only the continuation; do not repeat, summarize, or mention text already written or this instruction.',
          role: 'user',
        },
      ]
      console.warn(
        `[llm] Stream reached the provider output limit; continuing automatically (${continuationAttempts}/${maxContinuationAttempts}).`,
      )
      continue
    }

    if (stoppedAtToolStepLimit) {
      await textEmitter.push(
        `\n\n[AIRI stopped this turn after reaching the ${maxSteps}-step tool-call safety limit. Narrow the task or send a follow-up message to continue.]`,
      )
      console.warn(
        `[llm] Agent stopped at maxSteps=${maxSteps} while the model was still requesting tools.`,
      )
    }

    await textEmitter.flush()
    const terminalFinishEvent = stoppedAtToolStepLimit
      ? { finishReason: 'other' as const, type: 'finish' as const }
      : (pendingFinishEvent ?? { finishReason, type: 'finish' as const })
    await options?.onStreamEvent?.({
      ...terminalFinishEvent,
      usage: turnUsage ?? pendingFinishEvent?.usage ?? finalStep?.usage,
    })

    if (finishReason === 'length') {
      console.warn(
        `[llm] Stream remains truncated after ${continuationAttempts} continuation attempt(s) at max_tokens=${options?.maxTokens ?? 16384}.`,
      )
    }
    return
  }
}

/**
 * Resolve whether the active model+provider currently supports content-part
 * arrays. Defaults to `true` so first-time calls keep multimodal payloads;
 * flips to `false` once {@link isContentArrayRelatedError} has fired on this
 * model key and the caller has cached the degrade in
 * {@link StreamOptions.contentArrayCompatibility}.
 */
export function streamOptionsContentArrayCompatibilityOk(model: string, chatProvider: ChatProvider, options?: StreamOptions): boolean {
  if (options?.supportsContentArray !== undefined)
    return options.supportsContentArray
  const key = modelKey(model, chatProvider)
  return options?.contentArrayCompatibility?.get(key) !== false
}

export function streamOptionsToolsCompatibilityOk(model: string, chatProvider: ChatProvider, options?: StreamOptions): boolean {
  if (options?.supportsTools !== undefined)
    return options.supportsTools
  const key = modelKey(model, chatProvider)
  return options?.toolsCompatibility?.get(key) !== false
}

function createCapturedToolErrorResult(toolName: string, error: unknown): string {
  return `Tool call error for "${toolName}": ${errorMessageFromValue(error)}`
}

/**
 * Joins text emitted by separate provider calls without exposing a split word
 * or a repeated overlap at the continuation boundary.
 *
 * Before:
 * - `"The quick bro"` + `"brown fox."`
 *
 * After:
 * - `"The quick brown fox."`
 */
function createContinuationTextEmitter(emit: (text: string) => Promise<void> | void) {
  let continuationPrefix = ''
  let isReadingContinuationPrefix = false
  let pendingText = ''

  const emitSafeText = async (text: string) => {
    pendingText += text
    const trailingWord = pendingText.match(/\w+$/)?.[0] ?? ''
    const safeTextLength = pendingText.length - trailingWord.length

    if (safeTextLength > 0) {
      await emit(pendingText.slice(0, safeTextLength))
      pendingText = pendingText.slice(safeTextLength)
    }

    // A provider can stream an unusually long identifier without whitespace.
    // Retain only the tail needed for boundary stitching so buffering stays
    // bounded while ordinary prose still streams immediately.
    if (pendingText.length > 256) {
      await emit(pendingText.slice(0, -256))
      pendingText = pendingText.slice(-256)
    }
  }

  const mergeContinuationPrefix = async () => {
    isReadingContinuationPrefix = false

    let overlapLength = Math.min(pendingText.length, continuationPrefix.length)
    while (overlapLength > 0 && !continuationPrefix.startsWith(pendingText.slice(-overlapLength)))
      overlapLength -= 1

    const joinedText = pendingText + continuationPrefix.slice(overlapLength)
    continuationPrefix = ''
    pendingText = ''
    await emitSafeText(joinedText)
  }

  return {
    beginContinuation() {
      isReadingContinuationPrefix = true
    },
    async flush() {
      if (isReadingContinuationPrefix)
        await mergeContinuationPrefix()
      if (pendingText)
        await emit(pendingText)
      pendingText = ''
    },
    async push(text: string) {
      if (!isReadingContinuationPrefix) {
        await emitSafeText(text)
        return
      }

      continuationPrefix += text
      if (/^\w+$/.test(continuationPrefix) && continuationPrefix.length <= 256)
        return

      await mergeContinuationPrefix()
    },
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

function resolveCapturedToolErrorEvent(
  event: unknown,
  capturedToolErrorByCallId: Map<string, string>,
) {
  if (
    typeof event !== 'object'
    || event === null
    || (event as { type?: unknown }).type !== 'tool-result'
    || typeof (event as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    return event
  }

  const toolCallId = (event as { toolCallId: string }).toolCallId
  const result = capturedToolErrorByCallId.get(toolCallId)
  if (result == null)
    return event

  capturedToolErrorByCallId.delete(toolCallId)
  return {
    ...event,
    isError: true,
    result,
    type: 'tool-error',
  }
}

async function resolveTools(options?: StreamOptions) {
  const tools = typeof options?.tools === 'function'
    ? await options.tools()
    : options?.tools
  return tools ?? []
}

function withCapturedToolErrors(
  tools: Tool[],
  capturedToolErrorByCallId: Map<string, string>,
): Tool[] {
  return tools.map(tool => ({
    ...tool,
    execute: async (input, executeOptions) => {
      try {
        return await tool.execute(input, executeOptions)
      }
      catch (error) {
        if (isAbortError(error))
          throw error

        const result = createCapturedToolErrorResult(tool.function.name, error)
        capturedToolErrorByCallId.set(executeOptions.toolCallId, result)
        return result
      }
    },
  }))
}

// Runtime auto-degrade: patterns that indicate the model/provider does not support tool calling.
const TOOLS_RELATED_ERROR_PATTERNS: RegExp[] = [
  /does not support tools/i, // Ollama
  /no endpoints found that support tool use/i, // OpenRouter
  /invalid schema for function/i, // OpenAI-compatible
  /invalid.?function.?parameters/i, // OpenAI-compatible
  /functions are not supported/i, // Azure AI Foundry
  /unrecognized request argument.+tools/i, // Azure AI Foundry
  /tool use with function calling is unsupported/i, // Google Generative AI
  /tool_use_failed/i, // Groq
  /does not support function.?calling/i, // Anthropic
  /tools?\s+(is|are)\s+not\s+supported/i, // Cloudflare Workers AI
]

export function isToolRelatedError(error: unknown): boolean {
  const message = String(error)
  return TOOLS_RELATED_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

// Runtime auto-degrade: patterns that indicate the provider rejected
// content-part arrays and only accepts a plain string for `messages[].content`.
//
// The first pattern matches the Rust/serde wire-level error format used by
// many strict OpenAI-compatible gateways (e.g. DeepSeek-style servers):
//   "Failed to deserialize the JSON body into the target type:
//    messages[7]: invalid type: sequence, expected a string at line 1 column …"
// The second pattern covers Python/Pydantic-style errors like
//   "messages.0.content: Input should be a valid string"
// and other variants that surface the same root cause.
//
// See: https://github.com/moeru-ai/airi/issues/1500
const CONTENT_ARRAY_RELATED_ERROR_PATTERNS: RegExp[] = [
  /messages\[\d+\][^"]*invalid type:\s*sequence,\s*expected\s+a\s+string/i,
  /messages\.\d+\.content[^"]*(?:expected|should be).*string/i,
]

/**
 * Whether the given error indicates the provider rejected content-part arrays
 * and the caller should auto-degrade to string-only `content` for this model.
 *
 * Use when:
 * - Catching errors thrown by {@link streamFrom} so the chat store can flip
 *   `contentArrayCompatibility` for the failing model key.
 *
 * Expects:
 * - `error` may be an Error instance, a thrown SDK response object, a string,
 *   or anything else; we coerce via `String(error)` and pattern-match.
 *
 * Returns:
 * - `true` when the message matches a known "content array unsupported" wire
 *   format from an OpenAI-compatible gateway, otherwise `false`.
 */
export function isContentArrayRelatedError(error: unknown): boolean {
  const message = String(error)
  return CONTENT_ARRAY_RELATED_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

function addUsage(total: undefined | Usage, next: undefined | Usage): undefined | Usage {
  if (!next)
    return total
  if (!total)
    return next

  return {
    completion_tokens: total.completion_tokens + next.completion_tokens,
    prompt_tokens: total.prompt_tokens + next.prompt_tokens,
    total_tokens: total.total_tokens + next.total_tokens,
  }
}

import type { WebSocketEventOf } from '@proj-airi/server-sdk'
import type { ChatProvider, ChatProviderWithExtraOptions, EmbedProvider, EmbedProviderWithExtraOptions, SpeechProvider, SpeechProviderWithExtraOptions, TranscriptionProvider, TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { Message, Tool, ToolChoice } from '@xsai/shared-chat'

import type { StreamEvent } from '../../types/llm'
import type { SparkNotifyCommandDraft } from './tools'
import type {
  SparkNotifyMessageOverride,
  SparkNotifyResponseControl,
  SparkNotifyRuntimePolicy,
  SparkNotifyTracingHooks,
  SparkTraceEvent,
} from './types'

import { nanoid } from 'nanoid'

import { getEventSourceKey } from './event-source'
import { createSparkNotifyTools } from './tools'

export type { SparkNotifyCommandSchema } from './schema'
export { sparkNotifyCommandSchema } from './schema'
export type { SparkNotifyCommandDraft } from './tools'

/**
 * Dependency bag required by the spark-notify runtime.
 */
export interface SparkNotifyAgentDeps extends SparkNotifyTracingHooks {
  /** Returns the currently selected model name, if any. */
  getActiveModel: () => string | undefined
  /** Returns the currently selected provider name, if any. */
  getActiveProvider: () => string | undefined
  /** Returns queued `spark:notify` events that were deferred while busy. */
  getPending: () => Array<WebSocketEventOf<'spark:notify'>>
  /** Indicates whether the runtime is already handling another notify event. */
  getProcessing: () => boolean
  /** Resolves the provider instance used for the active model call. */
  getProviderInstance: <R extends
  | ChatProvider
  | ChatProviderWithExtraOptions
  | EmbedProvider
  | EmbedProviderWithExtraOptions
  | SpeechProvider
  | SpeechProviderWithExtraOptions
  | TranscriptionProvider
  | TranscriptionProviderWithExtraOptions,
  >(name: string,
  ) => Promise<R>
  /** Returns the host-level system prompt prepended to notify runs. */
  getSystemPrompt: () => string
  /** Receives incremental text deltas while the reaction is streaming. */
  onReactionDelta: (eventId: string, text: string) => void
  /** Receives the final reaction text after streaming completes. */
  onReactionEnd: (eventId: string, text: string) => void
  /** Replaces the deferred `spark:notify` queue after enqueue/dequeue operations. */
  setPending: (next: Array<WebSocketEventOf<'spark:notify'>>) => void
  /** Updates the processing flag used to serialize notify handling. */
  setProcessing: (next: boolean) => void
  /** Streams one notify-agent model call with the provided messages and tool policy. */
  stream: (
    model: string,
    provider: ChatProvider,
    messages: Message[],
    options: {
      onStreamEvent?: (event: StreamEvent) => Promise<void> | void
      supportsTools?: boolean
      toolChoice?: ToolChoice
      tools?: Tool[]
      waitForTools?: boolean
    },
  ) => Promise<void>
}

/**
 * Final command event emitted by the notify runtime.
 */
export interface SparkNotifyCommandEvent {
  /** Optional acknowledgement text that can be surfaced by the downstream consumer. */
  ack?: string
  /** Stable per-command identifier generated for downstream orchestration. */
  commandId: string
  /** Optional context patches that should accompany the emitted command. */
  contexts?: SparkNotifyCommandDraft['contexts']
  /** Destination agent or lane identifiers that should receive the command. */
  destinations: string[]
  /** Original command event identifier inherited from the notify response flow. */
  eventId: string
  /** Optional structured guidance assembled by the notify agent for the downstream command target. */
  guidance?: SparkNotifyCommandDraft['guidance']
  /** Stable runtime event ID generated for the emitted `spark:command` envelope. */
  id: string
  /** Intent label that describes why the downstream agent should process the command. */
  intent: 'action' | 'context' | 'pause' | 'plan' | 'proposal' | 'reroute' | 'resume'
  /** Interrupt mode forwarded to downstream consumers. */
  interrupt: 'force' | 'soft' | false
  /** Parent `spark:notify` event ID that caused this command to be emitted. */
  parentEventId: string
  /** Command priority used by downstream schedulers. */
  priority: 'critical' | 'high' | 'low' | 'normal'
}

/**
 * Handler result after runtime command expansion finishes.
 */
export interface SparkNotifyHandleResult {
  /** Expanded runtime command events ready to enqueue or emit downstream. */
  commands: SparkNotifyCommandEvent[]
}

/**
 * Raw spark-notify model response before runtime command event expansion.
 */
export interface SparkNotifyResponse {
  /** Command drafts collected from `builtIn_sparkCommand` tool calls before runtime event expansion. */
  commands?: SparkNotifyCommandDraft[]
  /** Free-form reaction text streamed back to the caller when the model emits text output. */
  reaction?: string
}

/**
 * Snapshot of spark runtime trace artifacts for eval harnesses.
 */
export interface SparkTraceCapture {
  /** Ordered trace events emitted by the runtime while handling the notify event. */
  events: SparkTraceEvent[]
  /** Final response snapshot captured after command expansion finishes. */
  finalResult?: {
    /** Number of command drafts emitted for the run. */
    commandCount: number
    /** Command drafts produced by the notify runtime before websocket event expansion. */
    commands: SparkNotifyCommandDraft[]
    /** `spark:notify` event identifier associated with the final result. */
    eventId: string
    /** Whether the model selected the `builtIn_sparkNoResponse` pathway. */
    noResponse: boolean
    /** Final reaction text returned to the caller. */
    reaction: string
    /** Whether tools were exposed to the provider for this run. */
    supportsTools: boolean
  }
  /** Raw model input snapshots captured before each provider call. */
  modelInputs: Array<{
    /** `spark:notify` event identifier associated with the model call. */
    eventId: string
    /** Rendered chat messages sent to the provider. */
    messages: Message[]
    /** Concrete model name used for the provider request. */
    model: string
    /** Active provider identifier used for the model request. */
    provider: string
    /** Whether the active provider call exposed tools at all. */
    supportsTools: boolean
    /** Provider tool selection policy, when one was enforced. */
    toolChoice: null | ToolChoice
    /** Whether the runtime waited for tool execution before finishing the call. */
    waitForTools: boolean
  }>
  /** Raw model output events captured during streaming, including tool activity. */
  modelOutputs: Array<{
    /** Accumulated text at the time the output event was captured. */
    accumulatedText?: string
    /** Tool execution error captured by the runtime. */
    error?: string
    /** `spark:notify` event identifier associated with the streaming output. */
    eventId: string
    /** Tool input payload emitted by the provider. */
    input?: unknown
    /** Output event category emitted by the stream adapter. */
    kind: 'text-delta' | 'tool-call' | 'tool-result'
    /** Tool execution output captured by the runtime. */
    output?: unknown
    /** Incremental text chunk emitted by the model. */
    text?: string
    /** Provider tool call identifier, when applicable. */
    toolCallId?: string
    /** Tool name referenced by the output event, when applicable. */
    toolName?: string
  }>
  /** Final rendered messages passed into the model call. */
  renderedMessages: Message[]
  /** Convenience view of tool-call events extracted from `modelOutputs`. */
  toolCalls: Array<{
    /** `spark:notify` event identifier associated with the tool call. */
    eventId: string
    /** Tool input payload captured from the provider stream. */
    input?: unknown
    /** Provider tool call identifier. */
    toolCallId?: string
    /** Tool name referenced by the provider. */
    toolName?: string
  }>
  /** Convenience view of tool execution results extracted from trace events. */
  toolExecutions: Array<{
    /** Tool execution error, when the runtime rejected or failed the call. */
    error?: string
    /** `spark:notify` event identifier associated with the tool execution. */
    eventId: string
    /** Tool input payload passed into runtime execution. */
    input?: unknown
    /** Tool output payload returned by runtime execution. */
    output?: unknown
    /** Provider tool call identifier. */
    toolCallId?: string
    /** Tool name executed by the runtime. */
    toolName?: string
  }>
  /** Tool metadata exposed to the model for the current run. */
  toolExposure: Array<{
    /** Provider-visible tool description, if supplied by the tool wrapper. */
    description?: string
    /** Provider-visible tool name. */
    name: string
  }>
  /** Convenience list of exposed tool names extracted from `toolExposure`. */
  toolNames: string[]
}

/**
 * Builds the instruction block prepended to Spark Notify agent prompts.
 *
 * Use when:
 * - Handling `spark:notify` events
 * - Constructing the per-turn system instruction for the notify reaction agent
 *
 * Expects:
 * - `moduleName` resolved from event source metadata
 *
 * Returns:
 * - Multiline instruction text for system prompt composition
 */
export function getSparkNotifyHandlingAgentInstruction(moduleName: string) {
  return [
    'This is AIRI system, the life pod hosting your consciousness. You don\'t need to respond to me or every spark:notify event directly.',
    `Another module "${moduleName}" triggered spark:notify event for you to checkout.`,
    'You may call the built-in tool "builtIn_sparkCommand" to issue spark:command to sub-agents as needed.',
    'For any of the output that is not a tool call, it will be streamed to user\'s interface and maybe processed with text to speech system ',
    'to be played out loud as your actual reaction to the spark:notify event.',
  ].join('\n')
}

/**
 * Creates a platform-agnostic Spark Notify event handler.
 *
 * Use when:
 * - A runtime consumes websocket `spark:notify` events
 * - Reactions and command drafts should be generated by an LLM with built-in tools
 * - You want identical behavior across stage-ui and offline eval harnesses
 *
 * Expects:
 * - Stream/provider adapters and state accessors passed in `deps`
 *
 * Returns:
 * - `handle(event, control)` function that applies queue/processing policy and returns generated commands
 *
 * Call stack:
 *
 * `handle`
 *   -> `runNotifyAgent`
 *     -> `createSparkNotifyTools`
 *       -> `deps.stream`
 *         -> `deps.onReactionDelta`/`deps.onReactionEnd`
 */
export function setupAgentSparkNotifyHandler(deps: SparkNotifyAgentDeps): {
  handle: (event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) => Promise<SparkNotifyHandleResult | undefined>
} {
  async function runNotifyAgent(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) {
    const activeProvider = deps.getActiveProvider()
    const activeModel = deps.getActiveModel()
    if (!activeProvider || !activeModel) {
      console.warn('Spark notify ignored: missing active provider or model')
      return undefined
    }

    const runtimePolicy = resolveSparkNotifyRuntimePolicy(control)
    const chatProvider = await deps.getProviderInstance<ChatProvider>(activeProvider)
    const commandDrafts: SparkNotifyCommandDraft[] = []
    let noResponse = false

    const { tools } = await createSparkNotifyTools({
      allowNoResponse: runtimePolicy.allowNoResponse,
      allowSparkCommand: runtimePolicy.allowSparkCommand,
      onCommands: commands => commandDrafts.push(...commands),
      onNoResponse: () => {
        noResponse = true
      },
      onTrace: deps.onTrace,
    })

    const systemMessage: Message = {
      content: [
        deps.getSystemPrompt(),
        getSparkNotifyHandlingAgentInstruction(getEventSourceKey(event)),
        ...(control?.messageOverride?.appendSystemInstructions ?? []),
      ].filter(Boolean).join('\n\n'),
      role: 'system',
    }

    const userMessage: Message = {
      content: renderSparkNotifyUserMessage({
        event,
        messageOverride: control?.messageOverride,
      }),
      role: 'user',
    }

    const messages: Message[] = [systemMessage, userMessage]

    traceSpark(deps, {
      payload: {
        eventId: event.data.eventId,
        messageCount: messages.length,
        renderedMessages: messages,
        source: event.source,
        toolCount: tools.length,
      },
      type: 'messages-rendered',
    })
    traceSpark(deps, {
      payload: {
        allowNoResponse: runtimePolicy.allowNoResponse,
        allowSparkCommand: runtimePolicy.allowSparkCommand,
        eventId: event.data.eventId,
        supportsTools: runtimePolicy.supportsTools,
        toolExposure: tools.flatMap((tool) => {
          const name = tool.function?.name
          if (!name)
            return []

          return [{
            description: tool.function?.description,
            name,
          }]
        }),
        toolNames: tools.flatMap((tool) => {
          const name = tool.function?.name
          return name ? [name] : []
        }),
        waitForTools: runtimePolicy.waitForTools,
      },
      type: 'tools-prepared',
    })
    traceSpark(deps, {
      payload: {
        eventId: event.data.eventId,
        messages,
        model: activeModel,
        provider: activeProvider,
        supportsTools: runtimePolicy.supportsTools,
        toolChoice: runtimePolicy.toolChoice ?? null,
        waitForTools: runtimePolicy.waitForTools,
      },
      type: 'model-input',
    })

    let fullText = ''

    await deps.stream(activeModel, chatProvider, messages, {
      onStreamEvent: async (streamEvent: StreamEvent) => {
        if (streamEvent.type === 'text-delta') {
          if (runtimePolicy.ignoreTextOutput || noResponse)
            return

          const nextText = `${fullText}${streamEvent.text}`
          traceSpark(deps, {
            payload: {
              accumulatedText: nextText,
              eventId: event.data.id,
              text: streamEvent.text,
            },
            type: 'model-output-text',
          })
          deps.onReactionDelta(event.data.id, streamEvent.text)
          fullText = nextText
        }

        if (streamEvent.type === 'tool-call') {
          traceSpark(deps, {
            payload: {
              eventId: event.data.eventId,
              kind: 'tool-call',
              ...streamEvent,
            },
            type: 'model-output-tool-call',
          })
        }

        if (streamEvent.type === 'tool-result') {
          traceSpark(deps, {
            payload: {
              eventId: event.data.eventId,
              kind: 'tool-result',
              ...streamEvent,
            },
            type: 'tool-execution',
          })
        }

        if (streamEvent.type === 'finish') {
          if (noResponse) {
            deps.onReactionEnd(event.data.id, '')
          }
          else {
            deps.onReactionEnd(event.data.id, fullText)
          }
        }

        if (streamEvent.type === 'error') {
          deps.onReactionEnd(event.data.id, fullText)
          throw streamEvent.error ?? new Error('Spark notify stream error')
        }
      },
      supportsTools: runtimePolicy.supportsTools,
      toolChoice: runtimePolicy.toolChoice,
      tools,
      waitForTools: runtimePolicy.waitForTools,
    })

    const reaction = fullText.trim()
    traceSpark(deps, {
      payload: {
        commandCount: commandDrafts.length,
        commands: commandDrafts,
        eventId: event.data.eventId,
        noResponse,
        normalizedCommands: commandDrafts,
        normalizedReaction: reaction,
        reaction,
        supportsTools: runtimePolicy.supportsTools,
      },
      type: 'result',
    })

    return {
      commands: commandDrafts,
      reaction,
    } satisfies SparkNotifyResponse
  }

  async function handle(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl): Promise<SparkNotifyHandleResult | undefined> {
    if (event.data.urgency !== 'immediate' && deps.getPending().length > 0) {
      deps.setPending([...deps.getPending(), event])
      return undefined
    }
    if (deps.getProcessing()) {
      deps.setPending([...deps.getPending(), event])
      return undefined
    }

    deps.setProcessing(true)

    try {
      const response = await runNotifyAgent(event, control)
      if (!response)
        return undefined

      const commands = (response.commands ?? [])
        .map(command => ({
          ack: command.ack,
          commandId: nanoid(),
          contexts: command.contexts,
          destinations: command.destinations ?? [],
          eventId: nanoid(),
          guidance: command.guidance,
          id: nanoid(),
          intent: command.intent ?? 'action',
          interrupt: (command.interrupt === true ? 'force' : command.interrupt) ?? false,
          parentEventId: event.data.id,
          priority: command.priority ?? 'normal',
        } satisfies SparkNotifyCommandEvent))
        .filter(command => command.destinations.length > 0)

      return {
        commands,
      }
    }
    finally {
      deps.setProcessing(false)
    }
  }

  return {
    handle,
  }
}

/**
 * Serializes one spark-notify payload into the user message content sent to the model.
 *
 * Use when:
 * - A runtime needs the default JSON envelope for spark-notify
 * - A host optionally appends one-off serialized context sections for the current run
 *
 * Expects:
 * - `messageOverride` content to already be provider-safe text
 *
 * Returns:
 * - A single provider-ready user message string
 */
function renderSparkNotifyUserMessage(input: {
  event: WebSocketEventOf<'spark:notify'>
  messageOverride?: SparkNotifyMessageOverride
}) {
  if (input.messageOverride?.replaceUserMessage) {
    return input.messageOverride.replaceUserMessage
  }

  const sections = [
    JSON.stringify({
      notify: input.event.data,
      source: input.event.source,
    }, null, 2),
    ...(input.messageOverride?.appendUserSections ?? []),
  ].filter(section => section.trim().length > 0)

  return sections.join('\n\n')
}

function resolveSparkNotifyRuntimePolicy(control?: SparkNotifyResponseControl): SparkNotifyRuntimePolicy {
  if (control?.forceTextResponse && control?.forceSparkCommandResponse) {
    console.warn('[spark:notify] forceTextResponse and forceSparkCommandResponse were both set; preferring forceTextResponse')
  }

  if (control?.forceTextResponse) {
    return {
      allowNoResponse: false,
      allowSparkCommand: false,
      ignoreTextOutput: false,
      supportsTools: false,
      waitForTools: false,
    }
  }

  if (control?.forceSparkCommandResponse) {
    return {
      allowNoResponse: false,
      allowSparkCommand: true,
      ignoreTextOutput: true,
      supportsTools: true,
      toolChoice: {
        function: {
          name: 'builtIn_sparkCommand',
        },
        type: 'function',
      },
      waitForTools: true,
    }
  }

  if (control?.forceResponse) {
    return {
      allowNoResponse: false,
      allowSparkCommand: true,
      ignoreTextOutput: false,
      supportsTools: true,
      waitForTools: true,
    }
  }

  return {
    allowNoResponse: true,
    allowSparkCommand: true,
    ignoreTextOutput: false,
    supportsTools: true,
    waitForTools: true,
  }
}

function traceSpark(deps: SparkNotifyTracingHooks, event: SparkTraceEvent) {
  deps.onTrace?.(event)
}

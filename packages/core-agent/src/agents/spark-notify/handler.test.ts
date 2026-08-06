import type { WebSocketEventOf } from '@proj-airi/server-sdk'

import { describe, expect, it, vi } from 'vitest'

import { setupAgentSparkNotifyHandler } from './handler'

describe('setupAgentSparkNotifyHandler', () => {
  it('captures tracing artifacts for command-only spark runs', async () => {
    const traces: unknown[] = []
    const handler = setupAgentSparkNotifyHandler({
      getActiveModel: () => 'mock-model',
      getActiveProvider: () => 'mock-provider',
      getPending: () => [],
      getProcessing: () => false,
      getProviderInstance: async () => ({} as any),
      getSystemPrompt: () => 'system',
      onReactionDelta: vi.fn(),
      onReactionEnd: vi.fn(),
      onTrace: (event: unknown) => traces.push(event),
      setPending: vi.fn(),
      setProcessing: vi.fn(),
      stream: async (_model, _provider, _messages, options) => {
        const commandTool = options.tools?.find((tool: any) => tool.function?.name === 'builtIn_sparkCommand')
        await commandTool?.execute({
          commands: [
            {
              ack: 'play e5',
              destinations: ['chess'],
              guidance: null,
              intent: 'action',
              interrupt: 'false',
              priority: 'high',
            },
          ],
        })
        await options.onStreamEvent?.({ type: 'finish' } as any)
      },
    } as any)

    const event: WebSocketEventOf<'spark:notify'> = {
      data: {
        destinations: ['character'],
        eventId: 'evt-1',
        headline: 'chess update',
        id: 'spark-1',
        kind: 'ping',
        urgency: 'immediate',
      },
      source: 'plugin:airi-plugin-game-chess',
      type: 'spark:notify',
    }

    const result = await handler.handle(event)

    expect(result?.commands).toHaveLength(1)
    expect(traces.length).toBeGreaterThan(0)
  })

  it('routes forceSparkCommandResponse to the model call', async () => {
    const stream = vi.fn(async (_model, _provider, _messages, options) => {
      await options.onStreamEvent?.({ type: 'finish' } as any)
    })

    const handler = setupAgentSparkNotifyHandler({
      getActiveModel: () => 'mock-model',
      getActiveProvider: () => 'mock-provider',
      getPending: () => [],
      getProcessing: () => false,
      getProviderInstance: async () => ({} as any),
      getSystemPrompt: () => 'system',
      onReactionDelta: vi.fn(),
      onReactionEnd: vi.fn(),
      setPending: vi.fn(),
      setProcessing: vi.fn(),
      stream,
    })

    const event: WebSocketEventOf<'spark:notify'> = {
      data: {
        destinations: ['character'],
        eventId: 'evt-2',
        headline: 'command-only update',
        id: 'spark-2',
        kind: 'ping',
        urgency: 'immediate',
      },
      source: 'plugin:airi-plugin-game-chess',
      type: 'spark:notify',
    }

    await handler.handle(event, {
      forceSparkCommandResponse: true,
    } as any)

    const streamOptions = stream.mock.calls[0]?.[3] as undefined | { toolChoice?: unknown }
    expect(streamOptions?.toolChoice).toEqual({
      function: {
        name: 'builtIn_sparkCommand',
      },
      type: 'function',
    })
  })

  it('applies runtime-only message overrides while rendering one notify turn', async () => {
    const stream = vi.fn(async (_model, _provider, messages, options) => {
      expect(String(messages[0]?.content)).toContain('Extra instruction: stay concise.')
      expect(String(messages[1]?.content)).toContain('"headline": "override update"')
      expect(String(messages[1]?.content)).toContain('Rendered board: white to move, fen=...')
      await options.onStreamEvent?.({ type: 'finish' } as any)
    })

    const handler = setupAgentSparkNotifyHandler({
      getActiveModel: () => 'mock-model',
      getActiveProvider: () => 'mock-provider',
      getPending: () => [],
      getProcessing: () => false,
      getProviderInstance: async () => ({} as any),
      getSystemPrompt: () => 'system',
      onReactionDelta: vi.fn(),
      onReactionEnd: vi.fn(),
      setPending: vi.fn(),
      setProcessing: vi.fn(),
      stream,
    })

    const event: WebSocketEventOf<'spark:notify'> = {
      data: {
        destinations: ['character'],
        eventId: 'evt-3',
        headline: 'override update',
        id: 'spark-3',
        kind: 'ping',
        urgency: 'immediate',
      },
      source: 'plugin:airi-plugin-game-chess',
      type: 'spark:notify',
    }

    await handler.handle(event, {
      forceTextResponse: true,
      messageOverride: {
        appendSystemInstructions: ['Extra instruction: stay concise.'],
        appendUserSections: ['Rendered board: white to move, fen=...'],
      },
    })

    expect(stream).toBeCalledTimes(1)
  })
})

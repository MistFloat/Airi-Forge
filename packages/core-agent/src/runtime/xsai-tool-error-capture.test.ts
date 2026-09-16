import type { Tool } from '@xsai/shared-chat'

import { stepCountAtLeast } from '@xsai/shared-chat'
import { streamText } from '@xsai/stream-text'
import { describe, expect, it, vi } from 'vitest'

describe('xsAI tool input error capture', () => {
  // ROOT CAUSE:
  //
  // AIRI's local tool wrapper can capture errors thrown by `tool.execute`, but
  // xsAI parses the model-provided JSON arguments before calling that wrapper.
  // A malformed parallel tool call therefore rejected the entire stream with
  // `Failed to parse tool input`, while an adjacent valid call had already
  // entered the durable execution ledger.
  //
  // xsAI has a native `captureToolErrors` path for this earlier failure stage,
  // but the patched option was also serialized as `capture_tool_errors` into
  // the OpenAI-compatible request body. Strict providers reject that private
  // field, so AIRI previously could not enable the native capture path.
  it('settles a valid parallel call and returns malformed arguments as a tool error without leaking the runtime option', async () => {
    const searchTool = {
      execute: vi.fn(async () => 'search result'),
      function: {
        description: 'Search code.',
        name: 'coding-agent__search_code',
        parameters: {
          properties: { pattern: { type: 'string' } },
          required: ['pattern'],
          type: 'object',
        },
      },
      type: 'function',
    } satisfies Tool
    let requestCount = 0
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      if ('capture_tool_errors' in body) {
        return new Response(JSON.stringify({ error: 'unknown field capture_tool_errors' }), {
          status: 400,
        })
      }

      requestCount += 1
      const chunk = requestCount === 1
        ? {
            choices: [{
              delta: {
                tool_calls: [
                  {
                    function: { arguments: '{"pattern":"finishReason"}', name: 'coding-agent__search_code' },
                    id: 'call-valid',
                    index: 0,
                    type: 'function',
                  },
                  {
                    function: { arguments: '{"pattern":', name: 'coding-agent__search_code' },
                    id: 'call-malformed',
                    index: 1,
                    type: 'function',
                  },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          }
        : {
            choices: [{
              delta: { content: 'Recovered after the malformed tool call.' },
              finish_reason: 'stop',
            }],
          }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 200,
      })
    })
    const result = streamText({
      baseURL: 'https://example.com/v1/',
      captureToolErrors: true,
      fetch: fetchMock,
      messages: [{ content: 'Search the code.', role: 'user' }],
      model: 'model-a',
      stopWhen: stepCountAtLeast(2),
      tools: [searchTool],
    })
    const events: Array<{ result?: unknown, type: string }> = []

    const reader = result.fullStream.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      events.push(value)
    }

    await expect(result.steps).resolves.toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String(call[1]?.body)) as Record<string, unknown>
      expect(body).not.toHaveProperty('capture_tool_errors')
    }
    expect(searchTool.execute).toHaveBeenCalledOnce()
    expect(searchTool.execute).toHaveBeenCalledWith(
      { pattern: 'finishReason' },
      expect.objectContaining({ toolCallId: 'call-valid' }),
    )
    expect(events).toContainEqual(expect.objectContaining({
      result: 'search result',
      type: 'tool-result',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      result: expect.stringContaining('Failed to parse tool input'),
      type: 'tool-error',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'text-delta',
    }))
  })
})

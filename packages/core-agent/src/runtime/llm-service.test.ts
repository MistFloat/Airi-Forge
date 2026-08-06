import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { describe, expect, it, vi } from 'vitest'

import { isContentArrayRelatedError, sanitizeMessages, streamFrom } from './llm-service'

const { streamTextMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
}))

vi.mock('@xsai/stream-text', () => ({
  streamText: streamTextMock,
}))

vi.mock('@xsai/shared-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xsai/shared-chat')>()
  return {
    ...actual,
    stepCountAtLeast: vi.fn(),
  }
})

const provider = {
  chat: () => ({
    baseURL: 'https://example.com/',
  }),
} as unknown as ChatProvider

function createMockStreamResult(steps: Promise<unknown[]> = Promise.resolve([])) {
  return {
    messages: Promise.resolve([]),
    steps,
    totalUsage: Promise.resolve(undefined),
    usage: Promise.resolve(undefined),
  }
}

describe('streamFrom tool error capture', () => {
  /**
   * @example
   * await streamFrom({ model, chatProvider, messages, options: { captureToolErrors: true } })
   */
  it('keeps captureToolErrors internal while forwarding failed tool calls as tool-error events', async () => {
    let resolveSteps: ((steps: unknown[]) => void) | undefined
    const events: unknown[] = []
    const failingTool = {
      execute: vi.fn(() => {
        throw new Error('Focus mode does not accept game-state mutation inputs.')
      }),
      function: {
        description: 'Start chess.',
        name: 'play_chess',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool

    streamTextMock.mockImplementationOnce((options: {
      captureToolErrors?: boolean
      onEvent: (event: unknown) => Promise<void>
      tools?: Tool[]
    }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        resolveSteps = resolve
      })

      queueMicrotask(async () => {
        const result = await options.tools?.[0]?.execute({}, {
          messages: [],
          toolCallId: 'call-1',
        })

        await options.onEvent({
          args: {},
          result,
          toolCallId: 'call-1',
          toolName: 'play_chess',
          type: 'tool-result',
        })
        await options.onEvent({ finishReason: 'stop', type: 'finish' })
        resolveSteps?.([])
      })

      return createMockStreamResult(steps)
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'play chess', role: 'user' }] as Message[],
      model: 'model-a',
      options: {
        captureToolErrors: true,
        onStreamEvent: (event) => {
          events.push(event)
        },
        tools: [failingTool],
      },
    })

    const streamOptions = streamTextMock.mock.calls[0]?.[0]
    expect(streamOptions.captureToolErrors).toBeUndefined()
    expect(streamOptions.tools?.[0]).not.toBe(failingTool)
    expect(failingTool.execute).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({
      isError: true,
      result: expect.stringContaining('Focus mode does not accept game-state mutation inputs.'),
      toolCallId: 'call-1',
      toolName: 'play_chess',
      type: 'tool-error',
    }))
  })
})

describe('sanitizeMessages', () => {
  it('rewrites internal `error`-role messages as user-role narrations', () => {
    /**
     * @example
     * sanitizeMessages([{ role: 'error', content: 'Remote sent 400' }])
     * // -> [{ role: 'user', content: 'User encountered error: Remote sent 400' }]
     */
    const out = sanitizeMessages([{ content: 'Remote sent 400', role: 'error' }])
    expect(out).toEqual([
      { content: 'User encountered error: Remote sent 400', role: 'user' },
    ])
  })

  it('flattens text-only content arrays to a string by default', () => {
    /**
     * @example
     * sanitizeMessages([{
     *   role: 'user',
     *   content: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' there' }],
     * }])
     * // -> [{ role: 'user', content: 'hi there' }]
     */
    const out = sanitizeMessages([{
      content: [
        { text: 'hi', type: 'text' },
        { text: ' there', type: 'text' },
      ],
      role: 'user',
    }])
    expect(out).toEqual([{ content: 'hi there', role: 'user' }])
  })

  it('preserves multimodal arrays when supportsContentArray is true (default)', () => {
    /**
     * @example
     * sanitizeMessages([{ role: 'user', content: [{type:'text',text:'see'},{type:'image_url',...}] }])
     * // -> unchanged: image_url part stays so vision-capable providers receive the image
     */
    const message = {
      content: [
        { text: 'see this', type: 'text' },
        { image_url: { url: 'data:image/png;base64,AAA' }, type: 'image_url' },
      ],
      role: 'user',
    }
    const out = sanitizeMessages([message])
    expect(out[0]).toEqual(message)
  })

  // ROOT CAUSE:
  //
  // Some Rust/serde-based OpenAI-compatible gateways only deserialize
  // `messages[].content` as a plain string and reject content-part arrays
  // with HTTP 400 "Failed to deserialize the JSON body into the target type:
  // messages[N]: invalid type: sequence, expected a string". Before the fix,
  // historical messages that contained an `image_url` part (uploaded image,
  // vision capture, restored session) bypassed the existing flatten branch
  // and stayed as arrays, so every subsequent send re-tripped the 400.
  //
  // We fixed this by adding a `supportsContentArray` flag — when the runtime
  // auto-degrade has flipped it to `false`, we force-flatten arrays to a
  // text-only string and drop non-text parts so the request shape matches
  // what a string-only provider can deserialize.
  //
  // See: https://github.com/moeru-ai/airi/issues/1500
  it('issue #1500: drops image_url parts and flattens to string when supportsContentArray=false', () => {
    /**
     * @example
     * sanitizeMessages([{ role:'user', content: [{type:'text',text:'hi'},{type:'image_url',...}] }], false)
     * // -> [{ role: 'user', content: 'hi' }]
     */
    const out = sanitizeMessages([
      {
        content: [
          { text: 'hi', type: 'text' },
          { image_url: { url: 'data:image/png;base64,AAA' }, type: 'image_url' },
        ],
        role: 'user',
      },
    ], false)
    expect(out).toEqual([{ content: 'hi', role: 'user' }])
  })

  it('issue #1500: drops audio/file parts when supportsContentArray=false', () => {
    /**
     * @example
     * sanitizeMessages([{ role:'user', content: [{type:'text',text:'q'},{type:'input_audio',...},{type:'file',...}] }], false)
     * // -> [{ role: 'user', content: 'q' }]
     */
    const out = sanitizeMessages([
      {
        content: [
          { text: 'q', type: 'text' },
          { input_audio: { data: 'AAA', format: 'wav' }, type: 'input_audio' },
          { file: { file_id: 'f_1' }, type: 'file' },
        ],
        role: 'user',
      },
    ], false)
    expect(out).toEqual([{ content: 'q', role: 'user' }])
  })

  it('passes string content through untouched regardless of the flag', () => {
    expect(sanitizeMessages([{ content: 'plain', role: 'user' }], true))
      .toEqual([{ content: 'plain', role: 'user' }])
    expect(sanitizeMessages([{ content: 'plain', role: 'user' }], false))
      .toEqual([{ content: 'plain', role: 'user' }])
  })
})

describe('isContentArrayRelatedError', () => {
  it('issue #1500: detects the Rust/serde "expected a string" wire error', () => {
    /**
     * @example
     * isContentArrayRelatedError(
     *   `Remote sent 400 response: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[7]: invalid type: sequence, expected a string at line 1 column 5603","code":"invalid_request_error"}}`
     * )
     * // -> true
     */
    const wire = 'Remote sent 400 response: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[7]: invalid type: sequence, expected a string at line 1 column 5603","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'
    expect(isContentArrayRelatedError(wire)).toBe(true)
    expect(isContentArrayRelatedError(new Error(wire))).toBe(true)
  })

  it('detects the Pydantic/Python "Input should be a valid string" variant', () => {
    /**
     * @example
     * isContentArrayRelatedError('messages.0.content: Input should be a valid string')
     * // -> true
     */
    expect(isContentArrayRelatedError('messages.0.content: Input should be a valid string'))
      .toBe(true)
    expect(isContentArrayRelatedError('messages.3.content expected string, got list'))
      .toBe(true)
  })

  it('does not false-positive on unrelated 400s', () => {
    expect(isContentArrayRelatedError('Remote sent 400 response: model not found')).toBe(false)
    expect(isContentArrayRelatedError('Remote sent 401 response: invalid api key')).toBe(false)
    expect(isContentArrayRelatedError('Tool call failed: invalid schema for function')).toBe(false)
    expect(isContentArrayRelatedError(undefined)).toBe(false)
  })
})

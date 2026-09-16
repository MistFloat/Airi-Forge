import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool, Usage } from '@xsai/shared-chat'

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

function createMockStreamResult(
  steps: Promise<unknown[]> = Promise.resolve([]),
  messages: Promise<Message[]> = Promise.resolve([]),
  totalUsage: Promise<undefined | Usage> = Promise.resolve(undefined),
) {
  return {
    messages,
    steps,
    totalUsage,
    usage: Promise.resolve(undefined),
  }
}

beforeEach(() => {
  streamTextMock.mockReset()
})

describe('streamFrom tool error capture', () => {
  /**
   * @example
   * await streamFrom({ model, chatProvider, messages, options: { captureToolErrors: true } })
   */
  it('enables native parse-error capture while forwarding failed tool calls as tool-error events', async () => {
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
    expect(streamOptions.captureToolErrors).toBe(true)
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

describe('streamFrom output continuation', () => {
  // ROOT CAUSE:
  //
  // A model can return a natural `stop` after saying it will read, inspect, or
  // modify something without issuing the promised tool call. AIRI treated any
  // such stop as a completed Agent turn, leaving only an action preamble in
  // history. This was observed as "让我重新读……让我看看……" followed by silence.
  //
  // The completion gate now gives a tool-capable model one bounded internal
  // continuation round. The synthetic instruction remains provider-local and
  // never becomes a durable user message.
  it('continues a tool-capable turn that stops after an unfulfilled action preamble', async () => {
    const events: Array<{ finishReason?: string, text?: string, type: string }> = []
    const readTool = {
      execute: vi.fn(async () => 'current file contents'),
      function: {
        description: 'Read one file.',
        name: 'read_file',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool
    const preamble = '让我重新读这份 8-28.md。让我看看它现在长什么样。'

    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const assistant = { content: preamble, role: 'assistant' } satisfies Message
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: preamble, type: 'text-delta' })
          await options.onEvent({ finishReason: 'stop', type: 'finish' })
          resolve([{ finishReason: 'stop', text: preamble, toolCalls: [], toolResults: [] }])
        })
      })
      return createMockStreamResult(steps, Promise.resolve([...options.messages, assistant]))
    })
    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const answer = '已经读取完成，文件包含三项待办。'
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: answer, type: 'text-delta' })
          await options.onEvent({ finishReason: 'stop', type: 'finish' })
          resolve([
            {
              finishReason: 'tool_calls',
              text: '',
              toolCalls: [{ toolCallId: 'call-read', toolName: 'read_file' }],
              toolResults: [{ result: 'current file contents', toolCallId: 'call-read', toolName: 'read_file' }],
            },
            { finishReason: 'stop', text: answer, toolCalls: [], toolResults: [] },
          ])
        })
      })
      return createMockStreamResult(steps, Promise.resolve(options.messages))
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Read 8-28.md and compare it.', role: 'user' }],
      model: 'model-a',
      options: {
        onStreamEvent: (event) => {
          events.push(event)
        },
        tools: [readTool],
      },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    const continuationMessages = streamTextMock.mock.calls[1]?.[0]?.messages as Message[]
    expect(continuationMessages.at(-2)).toEqual({ content: preamble, role: 'assistant' })
    expect(String(continuationMessages.at(-1)?.content)).toContain('Carry out the pending action')
    expect(events.filter(event => event.type === 'finish')).toEqual([
      expect.objectContaining({ finishReason: 'stop', type: 'finish' }),
    ])
  })

  it('does not continue an ordinary final answer merely because tools are available', async () => {
    const readTool = {
      execute: vi.fn(async () => 'unused'),
      function: {
        description: 'Read one file.',
        name: 'read_file',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool
    streamTextMock.mockImplementationOnce((options: { onEvent: (event: unknown) => Promise<void> }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: 'The file contains three tasks.', type: 'text-delta' })
          await options.onEvent({ finishReason: 'stop', type: 'finish' })
          resolve([{ finishReason: 'stop', text: 'The file contains three tasks.', toolCalls: [], toolResults: [] }])
        })
      })
      return createMockStreamResult(steps)
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Summarize the result.', role: 'user' }],
      model: 'model-a',
      options: { tools: [readTool] },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(1)
  })

  it('marks the turn incomplete when the model repeats an unfulfilled action preamble', async () => {
    const events: Array<{ finishReason?: string, text?: string, type: string }> = []
    const readTool = {
      execute: vi.fn(async () => 'unused'),
      function: {
        description: 'Read one file.',
        name: 'read_file',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool
    const preamble = '让我重新读取这份文件。'

    streamTextMock.mockImplementation((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const assistant = { content: preamble, role: 'assistant' } satisfies Message
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: preamble, type: 'text-delta' })
          await options.onEvent({ finishReason: 'stop', type: 'finish' })
          resolve([{ finishReason: 'stop', text: preamble, toolCalls: [], toolResults: [] }])
        })
      })
      return createMockStreamResult(steps, Promise.resolve([...options.messages, assistant]))
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Read the file.', role: 'user' }],
      model: 'model-a',
      options: {
        onStreamEvent: (event) => {
          events.push(event)
        },
        tools: [readTool],
      },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    expect(events.filter(event => event.type === 'text-delta').at(-1)?.text).toContain('could not complete the promised tool action')
    expect(events.filter(event => event.type === 'finish')).toEqual([
      expect.objectContaining({ finishReason: 'incomplete-action', type: 'finish' }),
    ])
  })

  // ROOT CAUSE:
  //
  // OpenAI-compatible providers end a valid SSE stream with
  // `finish_reason: "length"` when one response reaches the provider output
  // ceiling. Before this regression fix, streamFrom treated that event like a
  // normal completion, so the chat orchestrator persisted the partial text and
  // changed the UI state to stopped.
  //
  // We fixed this by replaying the provider-returned partial assistant message
  // with an internal continuation instruction. Only the final finish event is
  // exposed, and continuation text is joined at the interrupted word boundary.
  // The internal instruction never enters AIRI's durable session messages.
  //
  // Reference implementations:
  // https://github.com/NousResearch/hermes-agent/pull/12846
  // https://vercel.com/blog/ai-sdk-4-0#continuation-support
  it('continues a length-truncated response and emits one seamless final stream', async () => {
    const inputMessages = [{ content: 'Write a sentence.', role: 'user' }] satisfies Message[]
    const events: Array<{ finishReason?: string, text?: string, type: string }> = []

    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const partialAssistant = { content: 'The quick bro', role: 'assistant' } satisfies Message
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: 'The quick bro', type: 'text-delta' })
          await options.onEvent({ finishReason: 'length', type: 'finish' })
          resolve([{ finishReason: 'length', text: partialAssistant.content, toolCalls: [], toolResults: [] }])
        })
      })

      return createMockStreamResult(
        steps,
        Promise.resolve([...options.messages, partialAssistant]),
      )
    })
    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: 'brown fox.', type: 'text-delta' })
          await options.onEvent({ finishReason: 'stop', type: 'finish' })
          resolve([{ finishReason: 'stop', text: 'brown fox.', toolCalls: [], toolResults: [] }])
        })
      })

      return createMockStreamResult(steps, Promise.resolve(options.messages))
    })

    await streamFrom({
      chatProvider: provider,
      messages: inputMessages,
      model: 'model-a',
      options: {
        onStreamEvent: (event) => {
          events.push(event)
        },
      },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(2)
    expect(events.filter(event => event.type === 'text-delta').map(event => event.text).join('')).toBe('The quick brown fox.')
    expect(events.filter(event => event.type === 'finish')).toEqual([
      expect.objectContaining({ finishReason: 'stop', type: 'finish' }),
    ])
    expect(inputMessages).toEqual([{ content: 'Write a sentence.', role: 'user' }])

    const continuationMessages = streamTextMock.mock.calls[1]?.[0]?.messages as Message[]
    expect(continuationMessages.at(-2)).toEqual({ content: 'The quick bro', role: 'assistant' })
    expect(continuationMessages.at(-1)).toEqual(expect.objectContaining({ role: 'user' }))
    expect(String(continuationMessages.at(-1)?.content)).toContain('Continue exactly where')
  })

  // ROOT CAUSE:
  //
  // Automatic continuation creates more than one `streamText` call. Reporting
  // only the last call's usage made a truncated turn look much smaller than it
  // really was, which hid the evidence needed to diagnose provider limits.
  //
  // We fixed this by summing xsAI's per-call `totalUsage` and attaching that
  // turn aggregate to the one terminal finish event exposed to consumers.
  it('reports aggregate output tokens across automatic continuation calls', async () => {
    const finishEvents: Array<{ type: string, usage?: Usage }> = []

    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: 'part one ', type: 'text-delta' })
          await options.onEvent({ finishReason: 'length', type: 'finish' })
          resolve([{ finishReason: 'length', text: 'part one ', toolCalls: [], toolResults: [] }])
        })
      })
      return createMockStreamResult(
        steps,
        Promise.resolve([...options.messages, { content: 'part one ', role: 'assistant' }]),
        Promise.resolve({ completion_tokens: 100, prompt_tokens: 40, total_tokens: 140 }),
      )
    })
    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: 'part two', type: 'text-delta' })
          await options.onEvent({ finishReason: 'stop', type: 'finish' })
          resolve([{ finishReason: 'stop', text: 'part two', toolCalls: [], toolResults: [] }])
        })
      })
      return createMockStreamResult(
        steps,
        Promise.resolve(options.messages),
        Promise.resolve({ completion_tokens: 60, prompt_tokens: 150, total_tokens: 210 }),
      )
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Keep writing.', role: 'user' }],
      model: 'model-a',
      options: {
        onStreamEvent: (event) => {
          if (event.type === 'finish')
            finishEvents.push(event)
        },
      },
    })

    expect(streamTextMock.mock.calls[0]?.[0]?.streamOptions).toEqual({ includeUsage: true })
    expect(streamTextMock.mock.calls[1]?.[0]?.streamOptions).toEqual({ includeUsage: true })
    expect(finishEvents).toEqual([{
      finishReason: 'stop',
      type: 'finish',
      usage: {
        completion_tokens: 160,
        prompt_tokens: 190,
        total_tokens: 350,
      },
    }])
  })

  it('stops after three continuation attempts and surfaces the final length finish', async () => {
    const events: Array<{ finishReason?: string, text?: string, type: string }> = []

    for (let attempt = 0; attempt < 4; attempt += 1) {
      streamTextMock.mockImplementationOnce((options: {
        messages: Message[]
        onEvent: (event: unknown) => Promise<void>
      }) => {
        const text = `part${attempt} `
        const steps = new Promise<unknown[]>((resolve) => {
          queueMicrotask(async () => {
            await options.onEvent({ text, type: 'text-delta' })
            await options.onEvent({ finishReason: 'length', type: 'finish' })
            resolve([{ finishReason: 'length', text, toolCalls: [], toolResults: [] }])
          })
        })

        return createMockStreamResult(
          steps,
          Promise.resolve([...options.messages, { content: text, role: 'assistant' }]),
        )
      })
    }

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Keep writing.', role: 'user' }],
      model: 'model-a',
      options: {
        onStreamEvent: (event) => {
          events.push(event)
        },
      },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(4)
    expect(events.filter(event => event.type === 'finish')).toEqual([
      expect.objectContaining({ finishReason: 'length', type: 'finish' }),
    ])
  })

  it('does not auto-continue a length-truncated tool-call step', async () => {
    const events: Array<{ finishReason?: string, type: string }> = []
    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ finishReason: 'length', type: 'finish' })
          resolve([{
            finishReason: 'length',
            text: '',
            toolCalls: [{ toolCallId: 'call-partial', toolName: 'write_file' }],
            toolResults: [],
          }])
        })
      })
      return createMockStreamResult(steps, Promise.resolve(options.messages))
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Write the file.', role: 'user' }],
      model: 'model-a',
      options: {
        onStreamEvent: (event) => {
          events.push(event)
        },
      },
    })

    expect(streamTextMock).toHaveBeenCalledTimes(1)
    expect(events.filter(event => event.type === 'finish')).toEqual([
      expect.objectContaining({ finishReason: 'length', type: 'finish' }),
    ])
  })

  // ROOT CAUSE:
  //
  // xsAI can finish its last allowed agent step while the model is still
  // requesting another tool. AIRI previously returned normally in that state,
  // so the visible reply simply stopped with no explanation.
  //
  // We fixed this by appending an explicit diagnostic and exposing a terminal
  // non-tool finish event after the safety limit is reached.
  it('surfaces an explicit message when maxSteps stops an unfinished tool loop', async () => {
    const events: Array<{ finishReason?: string, text?: string, type: string }> = []
    streamTextMock.mockImplementationOnce((options: {
      messages: Message[]
      onEvent: (event: unknown) => Promise<void>
    }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        queueMicrotask(async () => {
          await options.onEvent({ text: 'Checking files.', type: 'text-delta' })
          await options.onEvent({ finishReason: 'tool_calls', type: 'finish' })
          resolve([
            { finishReason: 'tool_calls', text: '', toolCalls: [], toolResults: [] },
            {
              finishReason: 'tool_calls',
              text: '',
              toolCalls: [{ toolCallId: 'call-2', toolName: 'read_file' }],
              toolResults: [],
            },
          ])
        })
      })
      return createMockStreamResult(steps, Promise.resolve(options.messages))
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Inspect the repository.', role: 'user' }],
      model: 'model-a',
      options: {
        maxSteps: 2,
        onStreamEvent: (event) => {
          events.push(event)
        },
      },
    })

    expect(events.filter(event => event.type === 'text-delta').map(event => event.text).join(''))
      .toContain('reaching the 2-step tool-call safety limit')
    expect(events.at(-1)).toEqual(expect.objectContaining({
      finishReason: 'other',
      type: 'finish',
    }))
  })

  it('commits the tool admission before execution and settlement after the side effect', async () => {
    const order: string[] = []
    const tool = {
      execute: vi.fn(async () => {
        order.push('execute')
        return { content: 'done' }
      }),
      function: {
        description: 'Write one file.',
        name: 'write_file',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool

    streamTextMock.mockImplementationOnce((options: {
      onEvent: (event: unknown) => Promise<void>
      tools?: Tool[]
    }) => {
      const steps = new Promise<unknown[]>((resolve, reject) => {
        queueMicrotask(async () => {
          try {
            await options.tools?.[0]?.execute({ path: 'README.md' }, {
              messages: [],
              toolCallId: 'call-1',
            })
            await options.onEvent({ finishReason: 'stop', type: 'finish' })
            resolve([])
          }
          catch (error) {
            reject(error)
          }
        })
      })
      return createMockStreamResult(steps)
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Update the file.', role: 'user' }],
      model: 'model-a',
      options: {
        onToolExecutionFinish: async (event) => {
          order.push('settle')
          expect(event).toMatchObject({
            output: { content: 'done' },
            toolCallId: 'call-1',
            toolName: 'write_file',
          })
        },
        onToolExecutionStart: async (event) => {
          order.push('admit')
          expect(event).toEqual({
            input: { path: 'README.md' },
            toolCallId: 'call-1',
            toolName: 'write_file',
          })
        },
        tools: [tool],
      },
    })

    expect(order).toEqual(['admit', 'execute', 'settle'])
  })

  // ROOT CAUSE:
  //
  // If tool admission persistence failed but execution continued, a file or
  // external API could be mutated without any durable evidence that the model
  // requested it. Error capture could also turn that infrastructure failure
  // into an ordinary tool result and let the turn continue.
  //
  // We fixed this by making admission a hard precondition and exempting ledger
  // commit failures from ordinary tool-error capture.
  it('prevents execution when durable tool admission fails', async () => {
    const tool = {
      execute: vi.fn(async () => 'must not run'),
      function: {
        description: 'Delete one record.',
        name: 'delete_record',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool
    const admissionError = new Error('session log unavailable')

    streamTextMock.mockImplementationOnce((options: { tools?: Tool[] }) => {
      const steps = new Promise<unknown[]>((resolve, reject) => {
        queueMicrotask(async () => {
          try {
            await options.tools?.[0]?.execute({ id: 'record-a' }, {
              messages: [],
              toolCallId: 'call-1',
            })
            resolve([])
          }
          catch (error) {
            reject(error)
          }
        })
      })
      return createMockStreamResult(steps)
    })

    await expect(streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Delete it.', role: 'user' }],
      model: 'model-a',
      options: {
        captureToolErrors: true,
        onToolExecutionStart: async () => {
          throw admissionError
        },
        tools: [tool],
      },
    })).rejects.toThrow('Failed to admit tool call call-1')
    expect(tool.execute).not.toHaveBeenCalled()
  })

  it('replays a durable tool result without invoking the implementation or settling again', async () => {
    const tool = {
      execute: vi.fn(async () => 'must not run'),
      function: {
        description: 'Writes one record.',
        name: 'write_record',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool
    const settle = vi.fn()

    streamTextMock.mockImplementationOnce((options: { onEvent: (event: unknown) => unknown, tools?: Tool[] }) => {
      const steps = new Promise<unknown[]>((resolve, reject) => {
        queueMicrotask(async () => {
          try {
            const output = await options.tools?.[0]?.execute({ id: 'record-a' }, {
              messages: [],
              toolCallId: 'call-1',
            })
            expect(output).toEqual({ id: 'record-a', written: true })
            await options.onEvent({ finishReason: 'stop', type: 'finish' })
            resolve([])
          }
          catch (error) {
            reject(error)
          }
        })
      })
      return createMockStreamResult(steps)
    })

    await streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Write it.', role: 'user' }],
      model: 'model-a',
      options: {
        onToolExecutionFinish: settle,
        onToolExecutionStart: async () => ({
          disposition: 'replay',
          output: { id: 'record-a', written: true },
          status: 'completed',
        }),
        tools: [tool],
      },
    })

    expect(tool.execute).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
  })

  it('blocks an uncertain tool side effect from automatic re-execution', async () => {
    const tool = {
      execute: vi.fn(async () => 'must not run'),
      function: {
        description: 'Deletes one record.',
        name: 'delete_record',
        parameters: { properties: {}, type: 'object' },
      },
      type: 'function',
    } satisfies Tool

    streamTextMock.mockImplementationOnce((options: { tools?: Tool[] }) => {
      const steps = new Promise<unknown[]>((resolve, reject) => {
        queueMicrotask(async () => {
          try {
            await options.tools?.[0]?.execute({ id: 'record-a' }, {
              messages: [],
              toolCallId: 'call-1',
            })
            resolve([])
          }
          catch (error) {
            reject(error)
          }
        })
      })
      return createMockStreamResult(steps)
    })

    await expect(streamFrom({
      chatProvider: provider,
      messages: [{ content: 'Delete it.', role: 'user' }],
      model: 'model-a',
      options: {
        onToolExecutionStart: async () => ({ disposition: 'blocked', status: 'uncertain' }),
        tools: [tool],
      },
    })).rejects.toThrow('was not re-executed')
    expect(tool.execute).not.toHaveBeenCalled()
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

import { describe, expect, it, vi } from 'vitest'

import {
  compactProviderMessages,
  countMessageCharacters,
  findRecentWindowStart,
  TOOL_RESULT_TRUNCATION_MARKER,
} from './context-budget'

function assistantMessage(content: string) {
  return { content, role: 'assistant' }
}

function systemMessage(content: string) {
  return { content, role: 'system' }
}

function toolMessage(content: string) {
  return { content, role: 'tool' }
}

function userMessage(content: string) {
  return { content, role: 'user' }
}

describe('countMessageCharacters', () => {
  it('counts the role, string content, and text parts', () => {
    expect(countMessageCharacters([userMessage('abc')])).toBe(7)
    expect(countMessageCharacters([{
      content: [{ text: 'abc', type: 'text' }, { image_url: 'data:image/png;base64,x', type: 'image_url' }],
      role: 'user',
    }])).toBe(39)
  })

  it('ignores non-string, non-array content', () => {
    expect(countMessageCharacters([{ content: undefined, role: 'user' }])).toBe(4)
  })
})

describe('findRecentWindowStart', () => {
  const messages = [
    systemMessage('system'),
    userMessage('q1'),
    assistantMessage('a1'),
    userMessage('q2'),
    assistantMessage('a2'),
    userMessage('q3'),
    assistantMessage('a3'),
  ]

  it('returns the index of the newest matching user turn', () => {
    expect(findRecentWindowStart(messages, 1)).toBe(5)
    expect(findRecentWindowStart(messages, 2)).toBe(3)
  })

  it('returns 0 when the conversation is shorter than the window', () => {
    expect(findRecentWindowStart(messages, 10)).toBe(0)
  })

  it('returns the end of the array for a zero window', () => {
    expect(findRecentWindowStart(messages, 0)).toBe(messages.length)
  })
})

describe('compactProviderMessages', () => {
  it('returns messages untouched when they already fit the budget', () => {
    const messages = [systemMessage('system'), userMessage('hello'), assistantMessage('hi')]

    const { messages: compacted, stats } = compactProviderMessages(messages, { maxCharacters: 10_000 })

    expect(compacted).toEqual(messages)
    expect(stats).toEqual({
      charactersAfter: stats.charactersBefore,
      charactersBefore: stats.charactersBefore,
      droppedMessages: 0,
      droppedTurns: 0,
      truncatedToolResults: 0,
    })
    expect(stats.charactersBefore).toBe(countMessageCharacters(messages))
  })

  it('truncates only the tool results outside the recent window', () => {
    const longToolResult = 'x'.repeat(1000)
    const messages = [
      systemMessage('system'),
      userMessage('q1'),
      toolMessage(longToolResult),
      assistantMessage('a1'),
      userMessage('q2'),
      toolMessage('recent tool result'),
      assistantMessage('a2'),
    ]

    const { messages: compacted, stats } = compactProviderMessages(messages, {
      maxCharacters: 300,
      recentTurnLimit: 1,
      toolResultCharacterLimit: 100,
    })

    expect(stats.truncatedToolResults).toBe(1)
    expect(stats.droppedMessages).toBe(0)
    expect(stats.droppedTurns).toBe(0)
    expect(compacted[2]?.content).toBe(`${'x'.repeat(100)}\n${TOOL_RESULT_TRUNCATION_MARKER}`)
    expect(compacted[5]).toEqual(messages[5])
    expect(stats.charactersAfter).toBeLessThan(stats.charactersBefore)
  })

  it('folds everything before the recent window into one summary message', () => {
    const messages = [
      systemMessage('system'),
      userMessage('q1'),
      toolMessage('x'.repeat(1000)),
      assistantMessage('a1'),
      userMessage('q2'),
      toolMessage('recent tool result'),
      assistantMessage('a2'),
    ]

    const { messages: compacted, stats } = compactProviderMessages(messages, {
      maxCharacters: 100,
      recentTurnLimit: 1,
      toolResultCharacterLimit: 100,
    })

    expect(stats.droppedMessages).toBe(3)
    expect(stats.droppedTurns).toBe(1)
    expect(compacted).toHaveLength(5)
    expect(compacted[0]).toEqual(messages[0])
    expect(compacted[1]).toMatchObject({ role: 'system' })
    expect(compacted[1]?.content).toContain('compact')
    expect(compacted.slice(2)).toEqual([messages[4], messages[5], messages[6]])
  })

  it('uses the supplied summarizer for the folded prefix', () => {
    const summarize = vi.fn(() => 'DOMAIN SUMMARY')
    const messages = [
      systemMessage('system'),
      userMessage('q1'),
      assistantMessage('a1'),
      userMessage('q2'),
      assistantMessage('a2'),
    ]

    const { messages: compacted } = compactProviderMessages(messages, {
      maxCharacters: 1,
      recentTurnLimit: 1,
      summarize,
    })

    expect(summarize).toHaveBeenCalledWith({ droppedMessages: 2, droppedTurns: 1 })
    expect(compacted[1]?.content).toBe('DOMAIN SUMMARY')
  })

  it('keeps the system messages and the newest user turn even outside the window', () => {
    const messages = [
      systemMessage('system'),
      userMessage('old question'),
      assistantMessage('old answer'),
      toolMessage('x'.repeat(1000)),
    ]

    const { messages: compacted, stats } = compactProviderMessages(messages, {
      maxCharacters: 50,
      recentTurnLimit: 0,
      toolResultCharacterLimit: 10,
    })

    expect(stats.droppedMessages).toBeGreaterThan(0)
    expect(compacted[0]).toEqual(messages[0])
    expect(compacted).toContainEqual(messages[1])
  })
})

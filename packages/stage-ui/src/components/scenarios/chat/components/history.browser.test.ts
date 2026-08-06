import type { ChatHistoryItem } from '../../../../types/chat'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { computed, defineComponent, shallowRef } from 'vue'
import { createI18n } from 'vue-i18n'

import ChatHistory from './history.vue'

import { getChatHistoryItemKey } from '../utils'

vi.mock('../composables/use-chat-history-scroll', () => ({
  useChatHistoryScroll: () => undefined,
}))

vi.mock('../../../markdown', () => ({
  MarkdownRenderer: defineComponent({
    name: 'MarkdownRendererStub',
    props: {
      content: {
        default: '',
        type: String,
      },
    },
    template: '<div>{{ content }}</div>',
  }),
}))

function createHarness(messages: ChatHistoryItem[]) {
  return defineComponent({
    components: {
      ChatHistory,
    },
    name: 'ChatHistoryRetryHarness',
    setup() {
      const lastRetryIndex = shallowRef('none')
      const lastToolCallRerunPayload = shallowRef('')

      function handleRetryMessage(payload: { index: number }) {
        lastRetryIndex.value = String(payload.index)
      }

      function handleToolCallRerun(payload: unknown) {
        lastToolCallRerunPayload.value = JSON.stringify(payload)
      }

      const toolCallRerunPayload = computed(() => lastToolCallRerunPayload.value)

      return {
        handleRetryMessage,
        handleToolCallRerun,
        lastRetryIndex,
        messages,
        toolCallRerunPayload,
      }
    },
    template: `
      <div>
        <ChatHistory
          :messages="messages"
          @retry-message="handleRetryMessage"
          @tool-call-rerun="handleToolCallRerun"
        />
        <output aria-label="retry-index">{{ lastRetryIndex }}</output>
        <output aria-label="tool-call-rerun">{{ toolCallRerunPayload }}</output>
      </div>
    `,
  })
}

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        stage: {
          chat: {
            actions: {
              retry: 'Retry',
            },
            message: {
              'character-name': {
                'airi': 'AIRI',
                'core-system': 'System',
                'you': 'You',
              },
            },
          },
        },
      },
    },
  })
}

/**
 * @example
 * describe('ChatHistory retry actions', () => {
 *   it('emits retry-message when the retry button is clicked for an error after a user message', async () => {})
 * })
 */
describe('chatHistory retry actions', () => {
  /**
   * @example
   * it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   await screen.getByRole('button', { name: 'Retry' }).click()
   *   await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
   * })
   */
  it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { content: 'hello', role: 'user' },
      { content: 'Remote sent 400 response', role: 'error' },
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await screen.getByRole('button', { name: 'Retry' }).click()

    await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
  })

  /**
   * @example
   * it('does not render the retry button when the error is not preceded by a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   expect(document.body.textContent).not.toContain('Retry')
   * })
   */
  it('does not render the retry button when the error is not preceded by a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { content: 'hello', role: 'assistant', slices: [], tool_results: [] },
      { content: 'Remote sent 400 response', role: 'error' },
    ]

    await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    expect(document.body.textContent).not.toContain('Retry')
  })

  it('emits tool-call-rerun with message context when a tool call rerun button is clicked', async () => {
    const args = JSON.stringify({ location: 'Tokyo' })
    const assistantMessage: ChatHistoryItem = {
      content: '',
      createdAt: 1710000000000,
      role: 'assistant',
      slices: [
        {
          toolCall: {
            args,
            toolCallId: 'call-weather',
            toolCallType: 'function',
            toolName: 'weather',
          },
          type: 'tool-call',
        },
      ],
      tool_results: [],
    }
    const messages: ChatHistoryItem[] = [
      { content: 'weather in Tokyo', role: 'user' },
      assistantMessage,
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await screen.getByLabelText('Re-run tool call').click()

    await expect.element(screen.getByLabelText('tool-call-rerun')).toHaveTextContent(JSON.stringify({
      args,
      index: 1,
      key: getChatHistoryItemKey(assistantMessage, 1),
      message: assistantMessage,
      toolCallId: 'call-weather',
      toolName: 'weather',
    }))
  })
})

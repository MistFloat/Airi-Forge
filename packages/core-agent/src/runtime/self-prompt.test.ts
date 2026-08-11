import { describe, expect, it } from 'vitest'

import { createSelfPromptCapture, extractSelfPrompt } from './self-prompt'

describe('extractSelfPrompt', () => {
  it('returns the text untouched when there is no trailing marker line', () => {
    const result = extractSelfPrompt('普通的回复内容，没有任何标记。')
    expect(result.prompt).toBeUndefined()
    expect(result.text).toBe('普通的回复内容，没有任何标记。')
  })

  it('captures a trailing // line as the self prompt', () => {
    const result = extractSelfPrompt('这是正文。\n// 我想去查一下量子纠缠的最新进展')
    expect(result.prompt).toBe('我想去查一下量子纠缠的最新进展')
    expect(result.text).toBe('这是正文。\n')
  })

  it('captures when the whole reply is a single // line', () => {
    const result = extractSelfPrompt('// 只写给自己的一句话')
    expect(result.prompt).toBe('只写给自己的一句话')
    expect(result.text).toBe('')
  })

  it('does not capture // lines in the middle of the reply', () => {
    const result = extractSelfPrompt('第一行 // 不是结尾\n这是真正的结尾')
    expect(result.prompt).toBeUndefined()
    expect(result.text).toBe('第一行 // 不是结尾\n这是真正的结尾')
  })

  it('does not capture /// (rejects accidental emphasis)', () => {
    const result = extractSelfPrompt('正文\n/// 这不是自生成 prompt')
    expect(result.prompt).toBeUndefined()
    expect(result.text).toBe('正文\n/// 这不是自生成 prompt')
  })

  it('resolves the escaped marker \\/\\/ as literal // text', () => {
    const result = extractSelfPrompt('正文\n\\/\\/ 这是字面的双斜线，不是回路')
    expect(result.prompt).toBeUndefined()
    expect(result.text).toBe('正文\n// 这是字面的双斜线，不是回路')
  })

  it('does not capture an empty prompt line', () => {
    const result = extractSelfPrompt('正文\n//   ')
    expect(result.prompt).toBeUndefined()
    expect(result.text).toBe('正文\n//   ')
  })

  it('does not mistake URLs for a self prompt', () => {
    const result = extractSelfPrompt('文档见 https://example.com/path\n谢谢')
    expect(result.prompt).toBeUndefined()
    expect(result.text).toBe('文档见 https://example.com/path\n谢谢')
  })
})

describe('createSelfPromptCapture', () => {
  it('flushes every line eagerly and captures only the trailing // line', async () => {
    const emitted: string[] = []
    const capture = createSelfPromptCapture((literal) => {
      emitted.push(literal)
    })

    await capture.consume('第一段。\n')
    await capture.consume('第二段。\n')
    await capture.consume('// 下一轮我想做的事')
    const result = await capture.finish()

    expect(emitted.join('')).toBe('第一段。\n第二段。\n')
    expect(result.prompt).toBe('下一轮我想做的事')
  })

  it('flushes the trailing line when it is not a self prompt', async () => {
    const emitted: string[] = []
    const capture = createSelfPromptCapture((literal) => {
      emitted.push(literal)
    })

    await capture.consume('第一段。\n')
    await capture.consume('普通结尾。')
    const result = await capture.finish()

    expect(emitted.join('')).toBe('第一段。\n普通结尾。')
    expect(result.prompt).toBeUndefined()
  })

  it('keeps streaming responsive by flushing earlier lines before the stream ends', async () => {
    const emitted: string[] = []
    const capture = createSelfPromptCapture((literal) => {
      emitted.push(literal)
    })

    await capture.consume('早该显示的内容。\n')
    expect(emitted.join('')).toBe('早该显示的内容。\n')

    await capture.consume('// 只有这一行被暂存')
    expect(emitted.join('')).toBe('早该显示的内容。\n')
  })

  it('resolves escaped trailing marker when flushing', async () => {
    const emitted: string[] = []
    const capture = createSelfPromptCapture((literal) => {
      emitted.push(literal)
    })

    await capture.consume('正文。\n\\/\\/ 字面双斜线')
    const result = await capture.finish()

    expect(emitted.join('')).toBe('正文。\n// 字面双斜线')
    expect(result.prompt).toBeUndefined()
  })

  it('handles a single chunk containing the entire reply', async () => {
    const emitted: string[] = []
    const capture = createSelfPromptCapture((literal) => {
      emitted.push(literal)
    })

    await capture.consume('整段回复。\n// 结尾的自问')
    const result = await capture.finish()

    expect(emitted.join('')).toBe('整段回复。\n')
    expect(result.prompt).toBe('结尾的自问')
  })

  // ROOT CAUSE:
  //
  // The previous filter buffered every trailing line until stream completion,
  // even after its first character proved it could not be a `//` marker. A
  // network failure before finish() therefore hid the whole line (or the whole
  // response when it contained no newline).
  //
  // The streaming filter now retains only a still-possible marker prefix or an
  // actual trailing `//` candidate and emits ordinary prose immediately.
  it('emits an ordinary trailing line before the stream finishes', async () => {
    const emitted: string[] = []
    const capture = createSelfPromptCapture((literal) => {
      emitted.push(literal)
    })

    await capture.consume('single-line response still streaming')

    expect(emitted.join('')).toBe('single-line response still streaming')
  })

  it('flushes a self-prompt candidate when capture is disabled', async () => {
    const emitted: string[] = []
    const capture = createSelfPromptCapture((literal) => {
      emitted.push(literal)
    })

    await capture.consume('visible\n// incomplete candidate')
    const result = await capture.finish({ allowCapture: false })

    expect(emitted.join('')).toBe('visible\n// incomplete candidate')
    expect(result.prompt).toBeUndefined()
  })
})

import type { Tool } from '@xsai/shared-chat'

import { describe, expect, it, vi } from 'vitest'

import { resolveLlmTools, toolNameFrom } from './llm-tool-resolver'

function createTool(name: string, description = `${name} description`): Tool {
  return {
    execute: vi.fn(),
    function: {
      description,
      name,
      parameters: {
        additionalProperties: false,
        properties: {},
        required: [],
        type: 'object',
      },
    },
    type: 'function',
  } as Tool
}

describe('toolNameFrom', () => {
  it('reads function.name', () => {
    expect(toolNameFrom(createTool('runtime_read_context'))).toBe('runtime_read_context')
  })
})

describe('resolveLlmTools', () => {
  it('prefers a later runtime tool with the same name over an earlier built-in tool', async () => {
    const builtInTool = createTool('duplicate_tool', 'Built-in version.')
    const runtimeTool = createTool('duplicate_tool', 'Runtime version.')

    const tools = await resolveLlmTools({
      activeTools: [runtimeTool],
      builtInTools: [builtInTool],
      debugTools: [],
      sparkCommandTools: [],
    })

    expect(tools).toHaveLength(1)
    expect(tools[0]).toBe(runtimeTool)
  })

  it('places custom tools before active runtime tools so runtime tools can win by name', async () => {
    const builtInTool = createTool('built_in_tool')
    const customTool = createTool('duplicate_tool', 'Custom version.')
    const runtimeTool = createTool('duplicate_tool', 'Runtime version.')

    const tools = await resolveLlmTools({
      activeTools: [runtimeTool],
      builtInTools: [builtInTool],
      customTools: [customTool],
      debugTools: [],
      sparkCommandTools: [],
    })

    expect(tools).toEqual([builtInTool, runtimeTool])
  })
})

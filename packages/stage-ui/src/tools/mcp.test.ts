import type { JsonSchema } from 'xsschema'

import type { McpToolDescriptor, McpToolRuntime } from './mcp'

import { describe, expect, it, vi } from 'vitest'

import { createMcpDirectTools, desanitizeMcpToolName, mcp, sanitizeMcpToolName } from './mcp'

describe('tools mcp schema', () => {
  it('emits strict parameter objects', async () => {
    const tools = await mcp()
    for (const name of ['builtIn_mcpListTools', 'builtIn_mcpCallTool']) {
      const t = tools.find(entry => entry.function.name === name)
      expect(t, `missing tool: ${name}`).toBeDefined()
      expect(t?.function.parameters.additionalProperties).toBe(false)
    }
  })

  it('builtIn_mcpCallTool uses flat name+arguments schema', async () => {
    const tools = await mcp()
    const callTool = tools.find(entry => entry.function.name === 'builtIn_mcpCallTool')
    expect(callTool).toBeDefined()

    const props = (callTool!.function.parameters as JsonSchema).properties!
    expect((props.name as JsonSchema).type).toBe('string')
    expect((props.arguments as JsonSchema).type).toBe('string')
  })
})

describe('sanitizeMcpToolName', () => {
  it('replaces :: with __', () => {
    expect(sanitizeMcpToolName('coding-agent::git_status')).toBe('coding-agent__git_status')
  })

  it('matches the provider naming pattern ^[a-zA-Z0-9_-]+$', () => {
    const sanitized = sanitizeMcpToolName('coding-agent::git_status')
    expect(sanitized).toMatch(/^[\w-]+$/)
  })

  it('handles names with multiple :: separators', () => {
    expect(sanitizeMcpToolName('a::b::c')).toBe('a__b__c')
  })

  it('leaves names without :: unchanged', () => {
    expect(sanitizeMcpToolName('builtIn_mcpCallTool')).toBe('builtIn_mcpCallTool')
  })
})

describe('desanitizeMcpToolName', () => {
  it('replaces the first __ with ::', () => {
    expect(desanitizeMcpToolName('coding-agent__git_status')).toBe('coding-agent::git_status')
  })

  it('only replaces the first __ to preserve tool names with __', () => {
    expect(desanitizeMcpToolName('server__tool__sub')).toBe('server::tool__sub')
  })

  it('returns the name unchanged when no __ is present', () => {
    expect(desanitizeMcpToolName('builtIn-mcpCallTool')).toBe('builtIn-mcpCallTool')
  })
})

describe('createMcpDirectTools', () => {
  const toolOptions = {} as Parameters<import('@xsai/shared-chat').Tool['execute']>[1]

  function makeRuntime(descriptors: McpToolDescriptor[], callToolFn?: McpToolRuntime['callTool']): McpToolRuntime {
    return {
      callTool: callToolFn ?? vi.fn(async () => ({ content: [{ text: 'ok', type: 'text' }] })),
      listTools: async () => descriptors,
    }
  }

  const sampleDescriptor: McpToolDescriptor = {
    description: 'Get git repository status.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        path: { description: 'Repository path', type: 'string' },
      },
      required: ['path'],
      type: 'object',
    },
    name: 'coding-agent::git_status',
    serverName: 'coding-agent',
    toolName: 'git_status',
  }

  it('returns one direct tool per descriptor with the sanitized name', async () => {
    const runtime = makeRuntime([sampleDescriptor])
    const tools = await createMcpDirectTools(runtime)
    expect(tools).toHaveLength(1)
    // Provider-facing name is sanitized (:: → __)
    expect(tools[0].function.name).toBe('coding-agent__git_status')
    expect(tools[0].function.name).toMatch(/^[\w-]+$/)
    expect(tools[0].function.description).toBe('Get git repository status.')
    expect(tools[0].type).toBe('function')
  })

  it('preserves the MCP inputSchema as the tool parameters', async () => {
    const runtime = makeRuntime([sampleDescriptor])
    const tools = await createMcpDirectTools(runtime)
    expect(tools[0].function.parameters).toEqual({
      additionalProperties: false,
      properties: { path: { description: 'Repository path', type: 'string' } },
      required: ['path'],
      type: 'object',
    })
  })

  it('adds type: object when inputSchema omits it', async () => {
    const noType: McpToolDescriptor = {
      inputSchema: { properties: {} },
      name: 'server::paramless',
      serverName: 'server',
      toolName: 'paramless',
    }
    const tools = await createMcpDirectTools(makeRuntime([noType]))
    expect(tools[0].function.parameters).toEqual({ properties: {}, type: 'object' })
  })

  it('defaults to { type: object } when inputSchema is missing or malformed', async () => {
    const bad: McpToolDescriptor = {
      inputSchema: undefined as unknown as Record<string, unknown>,
      name: 'server::bad',
      serverName: 'server',
      toolName: 'bad',
    }
    const tools = await createMcpDirectTools(makeRuntime([bad]))
    expect(tools[0].function.parameters).toEqual({ type: 'object' })
  })

  it('forwards parsed arguments to runtime.callTool with the original qualified name', async () => {
    const callTool = vi.fn(async () => ({ content: [{ text: 'clean', type: 'text' }] }))
    const tools = await createMcpDirectTools(makeRuntime([sampleDescriptor], callTool))
    await tools[0].execute({ path: '/repo' }, toolOptions)
    // Execute uses descriptor.name (original with "::") for MCP dispatch
    expect(callTool).toHaveBeenCalledWith({ arguments: { path: '/repo' }, name: 'coding-agent::git_status' })
  })

  it('forwards undefined arguments when input is not a plain object', async () => {
    const callTool = vi.fn(async () => ({ content: [{ text: 'ok', type: 'text' }] }))
    const tools = await createMcpDirectTools(makeRuntime([sampleDescriptor], callTool))
    await tools[0].execute('not-an-object', toolOptions)
    expect(callTool).toHaveBeenCalledWith({ arguments: undefined, name: 'coding-agent::git_status' })
  })

  it('returns MCP-style error result when callTool throws', async () => {
    const callTool = vi.fn(async () => {
      throw new Error('server crashed')
    })
    const tools = await createMcpDirectTools(makeRuntime([sampleDescriptor], callTool))
    const result = await tools[0].execute({}, toolOptions)
    expect(result).toEqual({
      content: [{ text: 'server crashed', type: 'text' }],
      isError: true,
    })
  })

  it('returns empty array when listTools throws', async () => {
    const runtime: McpToolRuntime = {
      callTool: vi.fn(),
      listTools: async () => { throw new Error('unavailable') },
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const tools = await createMcpDirectTools(runtime)
    expect(tools).toEqual([])
    warnSpy.mockRestore()
  })
})

import type { ElectronMcpStdioConfigFile } from '../../shared/eventa'

import { describe, expect, it } from 'vitest'

import { applyWorkspaceToMcpConfig } from './agent-workspace'

const serviceDirectory = '/repo/services/coding-agent'

describe('applyWorkspaceToMcpConfig', () => {
  it('creates the coding-agent entry scoped to the workspace', () => {
    const config: ElectronMcpStdioConfigFile = { mcpServers: {} }

    const next = applyWorkspaceToMcpConfig(config, '/home/me/project', serviceDirectory)

    expect(next.mcpServers['coding-agent']).toEqual({
      args: ['exec', 'tsx', 'src/index.ts'],
      command: 'pnpm',
      cwd: serviceDirectory,
      env: { CODING_AGENT_WORKDIR: '/home/me/project' },
    })
    // The source config is not mutated in place.
    expect(config.mcpServers['coding-agent']).toBeUndefined()
  })

  it('keeps operator edits to the existing entry and only rewrites the workdir', () => {
    const config: ElectronMcpStdioConfigFile = {
      mcpServers: {
        'coding-agent': {
          args: ['run', 'custom.ts'],
          command: 'node',
          env: { EXTRA: '1' },
        },
      },
    }

    const next = applyWorkspaceToMcpConfig(config, '/home/me/other', serviceDirectory)

    expect(next.mcpServers['coding-agent']).toEqual({
      args: ['run', 'custom.ts'],
      command: 'node',
      cwd: serviceDirectory,
      env: { CODING_AGENT_WORKDIR: '/home/me/other', EXTRA: '1' },
    })
  })

  it('removes the entry when the workspace is cleared', () => {
    const config: ElectronMcpStdioConfigFile = {
      mcpServers: {
        'coding-agent': { command: 'pnpm' },
        'other': { command: 'node' },
      },
    }

    const next = applyWorkspaceToMcpConfig(config, undefined, serviceDirectory)

    expect(next.mcpServers['coding-agent']).toBeUndefined()
    expect(next.mcpServers.other).toEqual({ command: 'node' })
  })

  it('leaves an unrelated config untouched when nothing was ever selected', () => {
    const config: ElectronMcpStdioConfigFile = { mcpServers: { other: { command: 'node' } } }

    expect(applyWorkspaceToMcpConfig(config, undefined, serviceDirectory)).toEqual(config)
  })
})

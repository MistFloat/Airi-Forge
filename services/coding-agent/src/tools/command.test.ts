import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { runCommandTool } from './command'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-command-tool-'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('runCommandTool', () => {
  it('returns command output once instead of duplicating it in structured content', async () => {
    // ROOT CAUSE:
    //
    // stdout and stderr previously appeared in both MCP `content` and
    // `structuredContent`. The whole result object becomes the LLM tool result,
    // so every byte was duplicated before later tool rounds replayed it again.
    //
    // We fixed this by keeping human-readable output in `content` and retaining
    // only compact status metadata in `structuredContent`.
    const result = await runCommandTool({
      args: ['-e', 'process.stdout.write("unique-command-output")'],
      command: process.execPath.includes('node') ? process.execPath : 'node',
    }, { workdir: createWorkdir(root) })

    expect(result.content[0]?.text).toContain('unique-command-output')
    expect(result.structuredContent).not.toHaveProperty('stdout')
    expect(result.structuredContent).not.toHaveProperty('stderr')
    expect(result.structuredContent).toMatchObject({
      exitCode: 0,
      stderrTruncated: false,
      stdoutTruncated: false,
      timedOut: false,
    })
  })
})

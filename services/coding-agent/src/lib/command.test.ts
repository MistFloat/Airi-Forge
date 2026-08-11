import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCommand } from './command'
import { createWorkdir } from './workdir'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-command-'))
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

describe('runCommand', () => {
  it('captures stdout from a successful command', async () => {
    const result = await runCommand({
      args: ['-e', 'console.log("hello")'],
      command: process.execPath.includes('node') ? process.execPath : 'node',
    }, createWorkdir(root))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.timedOut).toBe(false)
  })

  it('captures stderr from a failing command', async () => {
    const result = await runCommand({
      args: ['-e', 'process.stderr.write("boom\\n"); process.exit(2)'],
      command: process.execPath.includes('node') ? process.execPath : 'node',
    }, createWorkdir(root))
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('boom')
  })

  it('uses the workdir as cwd', async () => {
    writeFileSync(join(root, 'marker.txt'), 'here\n')
    const result = await runCommand({
      args: ['marker.txt'],
      command: process.platform === 'win32' ? 'cmd' : 'cat',
      // cmd /c type marker.txt on Windows; cat marker.txt on Unix.
      ...(process.platform === 'win32' ? { args: ['/c', 'type', 'marker.txt'] } : {}),
    }, createWorkdir(root))
    expect(result.stdout).toContain('here')
  })

  it('reports a non-existent command as exitCode -1', async () => {
    const result = await runCommand({
      command: 'this-command-does-not-exist-xyz',
    }, createWorkdir(root))
    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain('this-command-does-not-exist-xyz')
  })

  it('times out and kills the child', async () => {
    const result = await runCommand({
      args: ['-e', 'setInterval(() => {}, 1000)'],
      command: process.execPath.includes('node') ? process.execPath : 'node',
      timeoutMs: 2_000,
    }, createWorkdir(root))
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(null)
  }, 15_000)

  it('pipes stdin to the child', async () => {
    const result = await runCommand({
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      command: process.execPath.includes('node') ? process.execPath : 'node',
      stdin: 'piped-input\n',
    }, createWorkdir(root))
    expect(result.stdout).toContain('piped-input')
  })

  it('caps noisy command output before it can flood later agent-loop requests', async () => {
    // ROOT CAUSE:
    //
    // Tool results are replayed with the conversation on every later model
    // request. The previous 256 KiB per-stream cap let one noisy command add
    // millions of cumulative prompt tokens across a multi-tool turn.
    //
    // We fixed this by enforcing a model-context-oriented 16 KiB ceiling and
    // retaining an explicit truncation marker that tells the model to narrow
    // its next command.
    const result = await runCommand({
      args: ['-e', 'process.stdout.write("x".repeat(64 * 1024))'],
      command: process.execPath.includes('node') ? process.execPath : 'node',
    }, createWorkdir(root))

    expect(result.exitCode).toBe(0)
    expect(result.stdoutTruncated).toBe(true)
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(17 * 1024)
    expect(result.stdout).toContain('[truncated at 16384 bytes]')
  })
})

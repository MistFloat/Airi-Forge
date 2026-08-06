import type { Workdir } from './workdir'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'

/**
 * Subprocess execution primitives for the coding-agent MCP server.
 *
 * The agent loop drives commands like `npm test`, `pnpm lint`, `git log`, or
 * arbitrary shell work. We do not run a shell (`shell: false`): the caller
 * supplies the binary name and an argv array. This keeps command injection
 * surface minimal — the agent cannot smuggle `&&` or `;` past an argv token
 * boundary the way it could through a single shell string.
 *
 * A second layer of defense is the workdir jail: every command runs with
 * `cwd: workdir.root`, and shell built-ins that would let the agent escape
 * (`cd` is a no-op for child processes; the spawn doesn't carry over) cannot
 * change that for subsequent calls.
 *
 * Output is captured with a hard ceiling so a noisy `tsc --listFiles` or a
 * runaway `pnpm install` cannot OOM the server or push the agent's context
 * past its budget. Both `stdout` and `stderr` are capped independently; when
 * truncated, a marker line is appended so the agent can tell.
 */

export interface RunCommandArgs {
  /** Argv passed to the executable. */
  args?: string[]
  /** Executable name (resolved against PATH). Shell built-ins (`cd`) are rejected by the caller, not here. */
  command: string
  /**
   * Extra environment variables to merge with `process.env`. Use sparingly —
   * most config should ride on the workdir's existing environment. To unset
   * an inherited variable, pass the empty string; Node's spawn treats
   * `undefined` values from the merged record as "not set", but the MCP
   * input schema only accepts strings (JSON Schema cannot represent
   * `undefined`), so empty string is the documented unsetter.
   */
  env?: Record<string, string>
  /** Optional text piped to the child's stdin. */
  stdin?: string
  /** Maximum wall-clock time, in milliseconds, before the child is killed. Default 60_000. */
  timeoutMs?: number
}

export interface RunCommandResult {
  /** Combined exit information; `null` when the process was killed by signal. */
  exitCode: null | number
  /** Signal that killed the process (e.g. `SIGTERM`), when applicable. */
  signal: NodeJS.Signals | null
  /** Truncated stderr output, with a marker when the cap was hit. */
  stderr: string
  /** Whether stderr was truncated. */
  stderrTruncated: boolean
  /** Truncated stdout output, with a marker when the cap was hit. */
  stdout: string
  /** Whether stdout was truncated. */
  stdoutTruncated: boolean
  /** True when the child exited with a non-zero status or was killed by signal. */
  timedOut: boolean
}

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_STDOUT_BYTES = 256 * 1024
const MAX_STDERR_BYTES = 256 * 1024

/**
 * Runs `command args...` inside the workdir with stdin piped in. Returns
 * captured stdout/stderr (truncated to a safe ceiling), the exit code, and
 * timeout/signal flags. Never throws — failures surface as `exitCode: -1`
 * with the message in `stderr`, so the agent can react to them.
 */
export function runCommand(args: RunCommandArgs, workdir: Workdir): Promise<RunCommandResult> {
  const timeoutMs = Math.max(1_000, Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 600_000))
  return new Promise((resolve) => {
    // Empty-string env values are treated as "unset" — the MCP input schema
    // only accepts strings, so callers signal "remove this inherited var"
    // by passing an empty string rather than `undefined`.
    const env: NodeJS.ProcessEnv = { ...process.env }
    if (args.env) {
      for (const [key, value] of Object.entries(args.env)) {
        if (value === '')
          delete env[key]
        else
          env[key] = value
      }
    }
    let child
    try {
      child = spawn(args.command, args.args ?? [], {
        cwd: workdir.root,
        env,
        // NOTICE: `shell: false` keeps argv as tokens — there is no shell
        // metacharacter interpretation. The agent cannot use `&&` or `;` to
        // chain commands; it must call `run_command` separately for each.
        // This is the primary command-injection defense.
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    }
    catch (error) {
      resolve({
        exitCode: -1,
        signal: null,
        stderr: `Failed to spawn ${args.command}: ${errorMessageFromValue(error)}`,
        stderrTruncated: false,
        stdout: '',
        stdoutTruncated: false,
        timedOut: false,
      })
      return
    }

    const stdoutBuf: Buffer[] = []
    const stderrBuf: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutCapped = false
    let stderrCapped = false
    let timedOut = false
    let timer: NodeJS.Timeout | undefined

    const resetTimer = () => {
      if (timer)
        clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        // Give the child a grace period to clean up after SIGTERM before
        // escalating to SIGKILL. 2s matches Node's default for graceful exit.
        setTimeout(() => {
          if (!child.killed)
            child.kill('SIGKILL')
        }, 2_000).unref?.()
      }, timeoutMs)
    }
    resetTimer()

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutCapped)
        return
      const remaining = MAX_STDOUT_BYTES - stdoutBytes
      if (chunk.length >= remaining) {
        if (remaining > 0) {
          stdoutBuf.push(chunk.subarray(0, remaining))
          stdoutBytes += remaining
        }
        stdoutCapped = true
      }
      else {
        stdoutBuf.push(chunk)
        stdoutBytes += chunk.length
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrCapped)
        return
      const remaining = MAX_STDERR_BYTES - stderrBytes
      if (chunk.length >= remaining) {
        if (remaining > 0) {
          stderrBuf.push(chunk.subarray(0, remaining))
          stderrBytes += remaining
        }
        stderrCapped = true
      }
      else {
        stderrBuf.push(chunk)
        stderrBytes += chunk.length
      }
    })

    child.on('close', (code, signal) => {
      if (timer)
        clearTimeout(timer)
      resolve({
        exitCode: code,
        signal: signal ?? null,
        stderr: formatBuffer(stderrBuf, stderrCapped, MAX_STDERR_BYTES),
        stderrTruncated: stderrCapped,
        stdout: formatBuffer(stdoutBuf, stdoutCapped, MAX_STDOUT_BYTES),
        stdoutTruncated: stdoutCapped,
        timedOut,
      })
    })

    child.on('error', (error) => {
      if (timer)
        clearTimeout(timer)
      resolve({
        exitCode: -1,
        signal: null,
        stderr: `${errorMessageFromValue(error)}`,
        stderrTruncated: false,
        stdout: '',
        stdoutTruncated: false,
        timedOut,
      })
    })

    if (args.stdin !== undefined) {
      // NOTICE: writing stdin can race with process exit if the child reads
      // nothing (e.g. `git log`). We swallow EPIPE/Esrch — the close handler
      // already captured the real outcome.
      try {
        child.stdin?.end(args.stdin)
      }
      catch {
        // ignore
      }
    }
    else {
      child.stdin?.end()
    }
  })
}

function errorMessageFromValue(error: unknown): string {
  if (error instanceof Error)
    return error.message
  if (typeof error === 'string')
    return error
  return JSON.stringify(error)
}

function formatBuffer(parts: Buffer[], capped: boolean, max: number): string {
  if (parts.length === 0)
    return ''
  const buf = Buffer.concat(parts)
  let text = buf.toString('utf8')
  if (capped) {
    // NOTICE: append a marker so the agent knows the output was truncated
    // and can rerun with a narrower argv or write to a file and read it
    // back via read_file.
    text += `\n... [truncated at ${max} bytes]\n`
  }
  return text
}

import type { RunCommandResult } from './command'
import type { Workdir } from './workdir'

import { runCommand } from './command'

/**
 * Test runner for the coding-agent MCP server.
 *
 * Unlike aider's hardcoded `--test-cmd`, we accept a command + argv so the
 * agent can adapt to the project's actual test runner (`pnpm test`,
 * `pytest`, `cargo test`, etc.). The server never picks a runner by itself
 * — guessing `npm test` on a Cargo project is worse than asking the agent.
 *
 * Non-zero exit code is NOT an error from the tool's perspective: it is a
 * signal to the agent that the tests failed and the output should be
 * inspected. The agent's own retry loop takes over from there.
 */

export interface RunTestsArgs {
  /** Args for the test command (e.g. `['-F', '@proj-airi/coding-agent', 'test']`). */
  args?: string[]
  /** Test command (e.g. `pnpm`, `pytest`). */
  command: string
  /** Extra environment variables (empty string unsets an inherited var). */
  env?: Record<string, string>
  /**
   * Restrict to a specific test path or pattern. Appended to `args` as-is
   * (no shell expansion), so the caller must use the test runner's own
   * filter syntax (e.g. `['path/to/file.test.ts']` for vitest).
   */
  filter?: string
  /** Optional stdin to pipe in. */
  stdin?: string
  /** Maximum runtime in ms (default 120_000 — tests are slower than shells). */
  timeoutMs?: number
}

export interface RunTestsResult {
  exitCode: null | number
  /** True when tests ran and exited non-zero or were killed. */
  failed: boolean
  /** True when tests ran and exited 0. */
  passed: boolean
  signal: NodeJS.Signals | null
  stderr: string
  stderrTruncated: boolean
  stdout: string
  stdoutTruncated: boolean
  timedOut: boolean
}

const DEFAULT_TEST_TIMEOUT_MS = 120_000

/**
 * Runs a test command and surfaces a structured `passed`/`failed` flag in
 * addition to the raw `RunCommandResult`. The agent reads `passed` to decide
 * whether to inspect the output, and `failed` to drive its retry loop.
 */
export async function runTests(args: RunTestsArgs, workdir: Workdir): Promise<RunTestsResult> {
  const fullArgs = [...(args.args ?? [])]
  if (args.filter)
    fullArgs.push(args.filter)

  const result: RunCommandResult = await runCommand({
    args: fullArgs,
    command: args.command,
    env: args.env,
    stdin: args.stdin,
    timeoutMs: args.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
  }, workdir)

  // exitCode 0 with no timeout → passed. Anything else → failed. We do not
  // treat a timeout as "passed=false with caveats"; the agent needs a clear
  // signal, and a timed-out test is a failure that needs investigation.
  const passed = !result.timedOut && result.exitCode === 0
  return {
    exitCode: result.exitCode,
    failed: !passed,
    passed,
    signal: result.signal,
    stderr: result.stderr,
    stderrTruncated: result.stderrTruncated,
    stdout: result.stdout,
    stdoutTruncated: result.stdoutTruncated,
    timedOut: result.timedOut,
  }
}

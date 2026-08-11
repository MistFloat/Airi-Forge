import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { runCommand } from '../lib/command'
import { lintFile } from '../lib/lint'
import { runTests } from '../lib/tests'
import { errorMessageFromValue, errorResult, textResult } from './types'

export interface CommandToolsContext {
  workdir: Workdir
}

export interface LintFilesArgs {
  paths: string[]
}

export interface RunCommandArgs {
  args?: string[]
  command: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export interface RunTestsToolArgs {
  args?: string[]
  command: string
  env?: Record<string, string>
  filter?: string
  stdin?: string
  timeoutMs?: number
}

/**
 * Lints files using the built-in structural linter. For per-language
 * project linters (eslint, ruff, golangci-lint), call `run_command`
 * with the appropriate tool — this tool only provides cheap, always-on
 * structural checks that catch syntax errors without any setup.
 */
export async function lintFilesTool(args: LintFilesArgs, ctx: CommandToolsContext): Promise<McpToolResult> {
  if (args.paths.length === 0)
    return errorResult('lint_files requires at least one path')

  const results = []
  let totalIssues = 0
  for (const path of args.paths) {
    try {
      const result = await lintFile({ path }, ctx.workdir)
      totalIssues += result.issues.length
      results.push(result)
    }
    catch (error) {
      results.push({
        issues: [{ column: 0, line: 0, message: errorMessageFromValue(error), rule: 'lint-error', severity: 'error' as const }],
        language: 'unknown',
        lineCount: 0,
        path,
      })
    }
  }

  const text = results
    .map((r) => {
      if (r.issues.length === 0)
        return `${r.path}: clean (${r.language}, ${r.lineCount} lines)`
      const issues = r.issues
        .map(i => `  ${r.path}:${i.line}:${i.column} [${i.severity}] ${i.rule}: ${i.message}`)
        .join('\n')
      return `${r.path}: ${r.issues.length} issue(s)\n${issues}`
    })
    .join('\n\n')

  return textResult(text, { files: results, totalIssues })
}

/**
 * Runs an arbitrary shell command inside the workdir. The command is run
 * without a shell (`shell: false`), so the agent cannot use `&&`, `;`, or
 * `|` to chain commands — it must call `run_command` separately for each.
 *
 * This is the primary escape hatch for operations not covered by the
 * dedicated tools: running tests, linters, formatters, build commands, or
 * inspecting the workdir via `ls`, `cat`, etc. The dedicated tools
 * (`lint_files`, `run_tests`, `git_*`) should be preferred when they fit.
 */
export async function runCommandTool(args: RunCommandArgs, ctx: CommandToolsContext): Promise<McpToolResult> {
  if (!args.command || args.command.trim() === '')
    return errorResult('run_command requires a non-empty `command`')

  const result = await runCommand({
    args: args.args ?? [],
    command: args.command,
    env: args.env,
    stdin: args.stdin,
    timeoutMs: args.timeoutMs,
  }, ctx.workdir)

  const summary = result.timedOut
    ? ` (timed out after ${args.timeoutMs ?? 60_000}ms)`
    : result.signal
      ? ` (killed by ${result.signal})`
      : result.exitCode === null
        ? ' (no exit code)'
        : ''

  const text = [
    `$ ${args.command} ${(args.args ?? []).join(' ')}`.trim(),
    `exit: ${result.exitCode ?? 'none'}${summary}`,
    result.stdout === '' ? null : `--- stdout ---\n${result.stdout}`,
    result.stderr === '' ? null : `--- stderr ---\n${result.stderr}`,
  ].filter(Boolean).join('\n')

  return textResult(text, {
    exitCode: result.exitCode,
    signal: result.signal,
    stderrTruncated: result.stderrTruncated,
    stdoutTruncated: result.stdoutTruncated,
    timedOut: result.timedOut,
  })
}

/**
 * Runs a test command and surfaces a structured `passed`/`failed` flag.
 * Non-zero exit code is NOT an error from the tool's perspective — it is
 * a signal to the agent that the tests failed and the output should be
 * inspected. The agent's own retry loop takes over from there.
 */
export async function runTestsTool(args: RunTestsToolArgs, ctx: CommandToolsContext): Promise<McpToolResult> {
  if (!args.command || args.command.trim() === '')
    return errorResult('run_tests requires a non-empty `command`')

  const result = await runTests({
    args: args.args ?? [],
    command: args.command,
    env: args.env,
    filter: args.filter,
    stdin: args.stdin,
    timeoutMs: args.timeoutMs,
  }, ctx.workdir)

  const summary = result.timedOut
    ? ` (timed out after ${args.timeoutMs ?? 120_000}ms)`
    : result.signal
      ? ` (killed by ${result.signal})`
      : result.passed
        ? ' (passed)'
        : ` (exit ${result.exitCode ?? 'none'})`

  const text = [
    `$ ${args.command} ${(args.args ?? []).join(' ')}${args.filter ? ` ${args.filter}` : ''}`.trim(),
    `result: ${result.passed ? 'PASSED' : 'FAILED'}${summary}`,
    result.stdout === '' ? null : `--- stdout ---\n${result.stdout}`,
    result.stderr === '' ? null : `--- stderr ---\n${result.stderr}`,
  ].filter(Boolean).join('\n')

  return textResult(text, {
    exitCode: result.exitCode,
    failed: result.failed,
    passed: result.passed,
    signal: result.signal,
    stderrTruncated: result.stderrTruncated,
    stdoutTruncated: result.stdoutTruncated,
    timedOut: result.timedOut,
  })
}

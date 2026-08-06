import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { CONVENTIONS_FILES, readAllConventions, readConventionsFile, readDefaultConventions, readPackageJsonScripts } from '../lib/conventions'
import { errorMessageFromValue, errorResult, textResult } from './types'

export interface ConventionsContext {
  workdir: Workdir
}

export interface ReadConventionsArgs {
  /** When true, also returns the test/lint scripts from package.json. */
  includeScripts?: boolean
  /**
   * When provided, read only this specific conventions file. When omitted,
   * reads all known conventions files (AGENTS.md, .cursorrules, etc.) and
   * returns them concatenated.
   */
  name?: string
}

/**
 * Reads project conventions files. The agent should call this once at the
 * start of a session to load coding standards, agent instructions, and the
 * project's own lint/test commands.
 *
 * Well-known files (in priority order): AGENTS.md, .cursorrules,
 * CONVENTIONS.md, CLAUDE.md, COPILOT.md, CODEX.md, .aider.conf.yml,
 * .editorconfig.
 */
export async function readConventionsTool(args: ReadConventionsArgs, ctx: ConventionsContext): Promise<McpToolResult> {
  if (args.name) {
    try {
      const result = await readConventionsFile(args.name, ctx.workdir)
      return textResult(`# ${result.path}\n\n${result.content}`, {
        files: [{ path: result.path, size: result.size }],
      })
    }
    catch (error) {
      return errorResult(`read_conventions: file "${args.name}" not found or unreadable: ${errorMessageFromValue(error)}`)
    }
  }

  const results = await readAllConventions(ctx.workdir)
  if (results.length === 0) {
    return textResult(
      `(no conventions files found; tried: ${CONVENTIONS_FILES.join(', ')})`,
      { files: [] },
    )
  }

  const blocks = results.map(r => `# ${r.path}\n\n${r.content}`)
  let text = blocks.join('\n\n---\n\n')

  if (args.includeScripts) {
    const scripts = await readPackageJsonScripts(ctx.workdir)
    const scriptBlock = Object.entries(scripts)
      .map(([name, cmd]) => `  ${name}: ${cmd}`)
      .join('\n')
    text += `\n\n---\n\n# package.json scripts\n\n${scriptBlock || '(no scripts)'}`
  }

  return textResult(text, {
    files: results.map(r => ({ path: r.path, size: r.size })),
    scripts: args.includeScripts ? await readPackageJsonScripts(ctx.workdir) : undefined,
  })
}

/** Re-exported so callers can read the default conventions file list. */
export { CONVENTIONS_FILES, readDefaultConventions }

import type { FileSession } from '../lib/session'
import type { Workdir } from '../lib/workdir'
import type { McpToolResult } from './types'

import { getRepoMap } from '../lib/repomap'
import { textResult } from './types'

export interface GetRepoMapArgs {
  focusPaths?: string[]
  includeAll?: boolean
  maxFiles?: number
  tokenBudget?: number
}

export interface RepoMapToolsContext {
  /** Optional session for default `focusPaths` (editable files). */
  session?: FileSession
  workdir: Workdir
}

/**
 * Builds a ranked, token-budgeted repo map. Files are ranked by
 * personalized PageRank over the symbol-reference graph; the personalization
 * vector biases toward `focusPaths` (or the session's editable files when
 * no explicit focus is given).
 *
 * The output is a tree-of-symbols string in aider's format, trimmed to fit
 * the token budget. The agent should call this once at the start of a
 * session to get an overview, then re-call when the editable set changes
 * significantly (e.g. after `add_file` / `drop_file`).
 */
export async function getRepoMapTool(args: GetRepoMapArgs, ctx: RepoMapToolsContext): Promise<McpToolResult> {
  const focusPaths = args.focusPaths ?? ctx.session?.editablePaths()
  const result = await getRepoMap({
    focusPaths,
    includeAll: args.includeAll,
    maxFiles: args.maxFiles,
    tokenBudget: args.tokenBudget,
  }, ctx.workdir)

  return textResult(result.rendered || '(no symbols found in the workdir)', {
    entries: result.entries,
    estimatedTokens: result.estimatedTokens,
    includedFiles: result.includedFiles,
    skippedFiles: result.skippedFiles,
    totalFiles: result.totalFiles,
    totalSymbols: result.totalSymbols,
  })
}

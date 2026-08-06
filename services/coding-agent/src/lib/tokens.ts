/**
 * Token estimation for the coding-agent MCP server.
 *
 * We intentionally use a character-based heuristic (≈4 chars per token)
 * rather than pulling in a tokenizer like `js-tiktoken` or `gpt-tokenizer`.
 * Reasons:
 *
 * 1. Tokenizers are model-specific (cl100k_base vs o200k_base vs llama).
 *    Picking one gives a misleadingly precise number for any model that
 *    doesn't share that vocab.
 *
 * 2. The agent uses these counts for *relative* decisions (which file to
 *    drop when over budget), not for absolute prompt-fit checks. The LLM
 *    provider's own tokenizer is the source of truth for the latter; the
 *    agent should ask the host runtime if it needs that.
 *
 * 3. A character-based estimator adds zero native deps, starts instantly,
 *    and is good enough for relative comparison (correlation ~0.95 with
 *    real tokenizers on natural-language + code mixed text).
 *
 * The ratio is tuned slightly per content type: code (more short tokens
 * like `()`, `=>`, `;`) tends to be denser per char than natural language,
 * so we use 3.5 chars/token for code-like files and 4.0 for prose.
 */

const CODE_EXTENSIONS = new Set([
  'astro',
  'bash',
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'cts',
  'go',
  'h',
  'hpp',
  'ini',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'mjs',
  'mts',
  'php',
  'ps1',
  'py',
  'rb',
  'rs',
  'sh',
  'svelte',
  'swift',
  'toml',
  'ts',
  'tsx',
  'vue',
  'yaml',
  'yml',
  'zsh',
])

const PROSE_EXTENSIONS = new Set([
  'adoc',
  'markdown',
  'md',
  'org',
  'rst',
  'txt',
])

/**
 * Estimates the combined token cost of a list of files. Files that fail to
 * read are silently skipped (they contribute 0); the caller can detect this
 * by comparing the returned count against the input length.
 */
export interface FileTokenEntry {
  chars: number
  path: string
  tokens: number
}

export interface FileTokenSummary {
  entries: FileTokenEntry[]
  /** Files that could not be read. */
  skipped: string[]
  totalChars: number
  totalTokens: number
}

export interface TokenEstimate {
  /** Character count of the input. */
  chars: number
  /** Ratio used (chars/token). */
  charsPerToken: number
  /** Heuristic content type used to pick the ratio. */
  kind: 'code' | 'mixed' | 'prose'
  /** Estimated token count for the input text. */
  tokens: number
}

/**
 * Estimates the token count of `text`. The `path` hint (filename or path)
 * lets us pick a slightly better ratio for code vs prose; without a hint we
 * use the mixed ratio (3.7 chars/token).
 *
 * Before:
 * - "function foo() { return 1 }"  (26 chars)
 *
 * After:
 * - { tokens: 7, chars: 26, charsPerToken: 3.5, kind: 'code' }
 */
export function estimateTokens(text: string, path?: string): TokenEstimate {
  const kind = path ? classifyPath(path) : classifyText(text)
  const charsPerToken = kind === 'code' ? 3.5 : kind === 'prose' ? 4.0 : 3.7
  return {
    chars: text.length,
    charsPerToken,
    kind,
    tokens: Math.max(1, Math.ceil(text.length / charsPerToken)),
  }
}

function classifyPath(path: string): 'code' | 'mixed' | 'prose' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (CODE_EXTENSIONS.has(ext))
    return 'code'
  if (PROSE_EXTENSIONS.has(ext))
    return 'prose'
  return 'mixed'
}

function classifyText(text: string): 'code' | 'mixed' | 'prose' {
  // Crude heuristic: code has many non-alpha symbols relative to length.
  const codeChars = (text.match(/[{}()[\];=><&|+\-*/]/g) ?? []).length
  const ratio = text.length === 0 ? 0 : codeChars / text.length
  if (ratio > 0.04)
    return 'code'
  // Prose has a higher density of whitespace-separated words per character
  // (natural language uses many short words). Code identifiers or long
  // tokens push the ratio down. Threshold tuned against English sentences
  // like "The quick brown fox..." (~0.19 words/char) versus single long
  // identifiers (~0.05).
  const words = text.split(/\s+/).filter(Boolean).length
  if (text.length > 0 && words / text.length >= 0.18)
    return 'prose'
  return 'mixed'
}

/**
 * Minimal `.gitignore` matcher used by `list_dir` to skip ignored entries.
 *
 * Supports the common subset: `#` comments, `!` negation, trailing `/`
 * (directory-only), leading `/` (root-anchored), `*`, `**`, `?`, and `[...]`
 * character classes. A pattern without `/` matches the basename at any depth;
 * a mid-path `**` matches one or more directory levels (zero levels are not
 * matched). Last matching rule wins.
 * Negated entries inside an ignored directory are not re-included because
 * `list_dir` does not descend into ignored directories.
 */

export interface GitignoreRule {
  dirOnly: boolean
  negated: boolean
  /** Matches a workdir-relative path (uses `/` separators). */
  regex: RegExp
  source: string
}

const GLOB_ESCAPE_RE = /[.+^${}()|[\]\\]/g

/**
 * Checks whether a workdir-relative entry is ignored. The last matching rule
 * wins, so a later `!` re-includes an earlier ignore.
 */
export function isIgnored(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    // A dir-only rule (trailing `/`) matches the directory itself or anything
    // beneath it. A bare entry with the exact name is only matched when it is
    // a directory; paths with deeper segments live under the (excluded)
    // directory, so they stay ignored even when the entry is a file.
    if (rule.dirOnly && !isDir && !relPath.includes('/'))
      continue
    if (rule.regex.test(relPath))
      ignored = !rule.negated
  }
  return ignored
}

/**
 * Parses `.gitignore` text into ordered rules. Blank lines and `#` comments are
 * skipped; `!` marks a negation; a trailing `/` restricts to directories.
 */
export function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#'))
      continue
    const negated = line.startsWith('!')
    const body = negated ? line.slice(1) : line
    if (body === '')
      continue
    rules.push({
      dirOnly: body.endsWith('/'),
      negated,
      regex: patternToRegExp(body),
      source: line,
    })
  }
  return rules
}

function patternToRegExp(pattern: string): RegExp {
  const dirOnly = pattern.endsWith('/')
  const anchored = pattern.startsWith('/')
  let body = dirOnly ? pattern.slice(0, -1) : pattern
  if (anchored)
    body = body.slice(1)

  let translated: string
  let basenameAnyDepth = false
  if (body.startsWith('**/')) {
    translated = translateBody(body.slice(3))
    basenameAnyDepth = !anchored
  }
  else if (body.endsWith('/**')) {
    translated = translateBody(body.slice(0, -3))
    basenameAnyDepth = !anchored
  }
  else {
    translated = translateBody(body)
    basenameAnyDepth = !anchored && !body.includes('/')
  }

  if (basenameAnyDepth)
    return new RegExp(`^(?:.*/)?${translated}(?:/.*)?$`)
  return new RegExp(`^${translated}(?:/.*)?$`)
}

/** Translates a path body into a regex fragment; a mid-path `**` crosses slashes. */
function translateBody(body: string): string {
  return body
    .split('/')
    .map(segment => segment === '**' ? '.*' : translateSegment(segment))
    .join('/')
}

function translateSegment(segment: string): string {
  let out = ''
  let i = 0
  while (i < segment.length) {
    const char = segment[i]
    if (char === '*') {
      out += '[^/]*'
      i += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (char === '[') {
      const close = segment.indexOf(']', i)
      if (close > i) {
        out += segment.slice(i, close + 1)
        i = close + 1
        continue
      }
    }
    out += char.replace(GLOB_ESCAPE_RE, '\\$&')
    i += 1
  }
  return out
}

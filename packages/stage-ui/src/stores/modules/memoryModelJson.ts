/**
 * Normalizes a model's JSON response by removing one complete Markdown fence.
 *
 * Before:
 * - "```json\n{\"ok\":true}\n```"
 *
 * After:
 * - "{\"ok\":true}"
 */
export function stripModelJsonFence(content: string): string {
  if (!content.startsWith('```'))
    return content
  const lines = content.split(/\r?\n/)
  if (lines.length < 3 || lines.at(-1)?.trim() !== '```')
    return content
  return lines.slice(1, -1).join('\n').trim()
}

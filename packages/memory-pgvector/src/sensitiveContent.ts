/**
 * Matches credential-shaped text that must never leave the desktop process or
 * enter long-term memory.
 *
 * This is the single source of truth shared by the renderer extractor guard and
 * the store-level `ingestEvidence` filter. Keep the patterns conservative:
 * ordinary durable profile statements must keep passing.
 */
export function containsSensitiveSecret(content: string): boolean {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\b(?:api[_ -]?key|password|passwd|secret|token)\s*[:=]\s*\S{8,}/i,
    /\b(?:sk|jina|ik_live)_[\w-]{12,}\b/,
  ].some(pattern => pattern.test(content))
}

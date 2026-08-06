export type PredicateCardinality = 'set' | 'single' | 'temporal_single' | 'unknown'
/**
 * Fixed importance bounds from code policy (PRD v2 §6.3).
 *
 * Importance is only trusted from two sources: an explicit user edit, or this
 * policy. `min`/`max` clamp the [0,1] canonical importance; `conflictSeverity`
 * is the only place the auto conflict worker may fill the
 * normal/important/critical column without a user decision.
 */
export interface PredicateImportancePolicy {
  /** Fixed conflict severity; undefined means the worker must not guess it. */
  conflictSeverity?: 'critical' | 'important' | 'normal'
  /** Highest [0,1] importance a predicate may carry (e.g. one-off state <= normal). */
  max?: number
  /** Lowest [0,1] importance a predicate may carry (e.g. identity >= important). */
  min?: number
}

export type PredicateSensitivity = 'personal' | 'public' | 'sensitive'

interface PredicateDefinition {
  aliases: string[]
  cardinality: PredicateCardinality
  /**
   * Whether an `implicit` preference may be promoted without user confirmation.
   * Promotion still requires `kind = preference`; the allow-list lives here so
   * the renderer never guesses policy from raw model output.
   */
  implicitPromotion: boolean
  /** Optional fixed importance policy (see {@link PredicateImportancePolicy}). */
  importance?: PredicateImportancePolicy
  name: string
  /**
   * Higher-sensitivity predicates must never be auto-activated; they wait for
   * the user even when the assertion is explicit (PRD v2: address may be
   * important but is sensitive, so it cannot auto-activate).
   */
  sensitivity?: PredicateSensitivity
  /** Normalizes a raw value before it is stored (e.g. 上海市 -> 上海). */
  valueNormalizer?: (value: string) => string
}

/** Versioned in code so a changed alias cannot silently rewrite existing fact keys. */
export const PREDICATE_REGISTRY_VERSION = 'predicate-v1'

const definitions: PredicateDefinition[] = [
  { aliases: ['lives_in', 'location', '居住地', '住在'], cardinality: 'temporal_single', implicitPromotion: false, importance: { conflictSeverity: 'important', min: 0.6 }, name: 'residence_city', sensitivity: 'sensitive', valueNormalizer: normalizeChinesePlace },
  { aliases: ['favorite_music', 'music_preference', '喜欢的音乐'], cardinality: 'set', implicitPromotion: true, importance: { conflictSeverity: 'normal', max: 0.5 }, name: 'favorite_music' },
  { aliases: ['preferred_language', 'language_preference', '偏好语言'], cardinality: 'set', implicitPromotion: true, importance: { conflictSeverity: 'normal', max: 0.5 }, name: 'preferred_language' },
  { aliases: ['display_name', '姓名', '名字'], cardinality: 'single', implicitPromotion: false, importance: { conflictSeverity: 'important', min: 0.7 }, name: 'display_name', sensitivity: 'personal' },
  { aliases: ['timezone', '时区'], cardinality: 'single', implicitPromotion: false, importance: { conflictSeverity: 'normal' }, name: 'timezone' },
  // The extractor prompt uses uses_service for service adoption examples
  // (Spotify/Apple Music). Registered as a set so separate services coexist
  // while a positive/negative flip of one value still becomes a conflict.
  { aliases: ['uses_service', '使用服务'], cardinality: 'set', implicitPromotion: false, importance: { conflictSeverity: 'normal' }, name: 'uses_service' },
]

export function cardinalityFor(predicate: string): PredicateCardinality {
  return definitionFor(predicate)?.cardinality ?? 'unknown'
}

/**
 * Returns the fixed conflict severity for a predicate, or `null` when no policy
 * exists. The auto worker must not guess criticality (PRD v2 §6.3), so callers
 * persist `null` (leaving the column empty) instead of inventing a value.
 */
export function conflictSeverityFor(predicate: string): 'critical' | 'important' | 'normal' | null {
  return definitionFor(predicate)?.importance?.conflictSeverity ?? null
}

export function implicitPromotionFor(predicate: string): boolean {
  return definitionFor(predicate)?.implicitPromotion ?? false
}

export function importancePolicyFor(predicate: string): PredicateImportancePolicy {
  return definitionFor(predicate)?.importance ?? {}
}

/** Normalizes model output through a finite alias registry before building a stable key. */
export function normalizeFactIdentity(input: { predicate: string, scope: string, subject: string }): {
  cardinality: PredicateCardinality
  factKey: string
  predicate: string
  scope: string
  subject: string
} {
  const sourcePredicate = token(input.predicate)
  const definition = definitionFor(input.predicate)
  const predicate = definition?.name ?? sourcePredicate
  const subject = token(input.subject) || 'user'
  const scope = token(input.scope) || 'global'
  return {
    cardinality: definition?.cardinality ?? 'unknown',
    factKey: `${subject}/${predicate}/${scope}`,
    predicate,
    scope,
    subject,
  }
}

/** Normalizes a raw value through the predicate's policy, falling back to a plain trim. */
export function normalizeValueFor(predicate: string, value: string): string {
  return definitionFor(predicate)?.valueNormalizer?.(value) ?? value.trim()
}

export function sensitivityFor(predicate: string): PredicateSensitivity {
  return definitionFor(predicate)?.sensitivity ?? 'public'
}

function definitionFor(predicate: string): PredicateDefinition | undefined {
  const sourcePredicate = token(predicate)
  return definitions.find(item => item.name === sourcePredicate || item.aliases.some(alias => token(alias) === sourcePredicate))
}

/**
 * Normalizes common Chinese place names so 上海市 and 上海 collapse to one value.
 *
 * Before:
 * - "上海市"
 * - "广东省"
 *
 * After:
 * - "上海"
 * - "广东"
 */
function normalizeChinesePlace(value: string): string {
  return value.trim().replace(/(?:省|市|自治区|特别行政区)$/u, '')
}

/**
 * Normalizes predicate-key tokens.
 *
 * Before:
 * - " Residence City "
 * - "居住 地"
 *
 * After:
 * - "residence_city"
 * - "居住_地"
 */
function token(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s/]+/g, '_').replace(/[^\p{L}\p{N}_-]/gu, '')
}

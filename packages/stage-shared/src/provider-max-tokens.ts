/** Default output budget used when a provider has no project override. */
export const DEFAULT_PROVIDER_MAX_TOKENS = 16384

/**
 * Portable output-token policy shared by desktop persistence and renderer stores.
 *
 * Provider keys are stable provider definition IDs such as `deepseek` or `openai`,
 * rather than transient UI instance IDs.
 */
export interface ProviderMaxTokensConfig {
  /** Output budget used when `providers` has no entry for the active provider. */
  default: number
  /** Positive integer output budgets indexed by provider definition ID. */
  providers: Record<string, number>
  /** Persisted schema version. */
  version: 1
}

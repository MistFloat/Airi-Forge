import type { ProviderMaxTokensConfig } from '@proj-airi/stage-shared'

import { DEFAULT_PROVIDER_MAX_TOKENS, isStageTamagotchi } from '@proj-airi/stage-shared'
import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

/** Persistence boundary used to keep platform-specific file IO outside stage-ui. */
export interface ProviderMaxTokensPersistence {
  /** Loads the authoritative provider policy. */
  load: () => Promise<ProviderMaxTokensConfig>
  /** Persists one provider update and returns the authoritative snapshot. */
  set: (payload: { maxTokens?: number, providerId: string }) => Promise<ProviderMaxTokensConfig>
}

function createDefaultConfig(): ProviderMaxTokensConfig {
  return {
    default: DEFAULT_PROVIDER_MAX_TOKENS,
    providers: {},
    version: 1,
  }
}

export const useProviderMaxTokensStore = defineStore('provider-max-tokens', () => {
  // Desktop installs a project-file bridge during renderer startup. Other stage
  // surfaces retain browser persistence because they cannot write a project path.
  const config = isStageTamagotchi()
    ? shallowRef<ProviderMaxTokensConfig>(createDefaultConfig())
    : useLocalStorage<ProviderMaxTokensConfig>('settings/providers/max-tokens', createDefaultConfig())

  let initializePromise: Promise<void> | undefined
  let persistence: ProviderMaxTokensPersistence | undefined

  function applyConfig(next: ProviderMaxTokensConfig) {
    config.value = {
      default: next.default,
      providers: { ...next.providers },
      version: 1,
    }
  }

  /** Installs the Electron project-file bridge before {@link initialize}. */
  function configurePersistence(nextPersistence: ProviderMaxTokensPersistence) {
    persistence = nextPersistence
    initializePromise = undefined
  }

  /** Loads the authoritative project configuration once for this renderer. */
  async function initialize(): Promise<void> {
    if (!persistence)
      return

    initializePromise ??= persistence.load().then(applyConfig)
    await initializePromise
  }

  /** Reloads project persistence so separate Electron windows see recent edits. */
  async function refresh(): Promise<void> {
    if (!persistence)
      return

    applyConfig(await persistence.load())
  }

  function getProviderMaxTokensOverride(providerId: string): number | undefined {
    return config.value.providers[providerId]
  }

  /** Resolves a provider override, falling back to the portable project default. */
  function getProviderMaxTokens(providerId: string): number {
    return getProviderMaxTokensOverride(providerId) ?? config.value.default
  }

  /** Updates one provider without replacing concurrent settings from another window. */
  async function setProviderMaxTokens(providerId: string, maxTokens: number | undefined): Promise<void> {
    await initialize()

    const normalizedMaxTokens = typeof maxTokens === 'number'
      && Number.isFinite(maxTokens)
      && maxTokens > 0
      ? Math.floor(maxTokens)
      : undefined
    const previous = config.value
    const providers = { ...previous.providers }
    if (normalizedMaxTokens === undefined)
      delete providers[providerId]
    else
      providers[providerId] = normalizedMaxTokens
    applyConfig({ ...previous, providers })

    if (!persistence)
      return

    try {
      applyConfig(await persistence.set({ maxTokens: normalizedMaxTokens, providerId }))
    }
    catch (error) {
      applyConfig(previous)
      throw error
    }
  }

  /**
   * Moves the former provider-local field into centralized persistence.
   *
   * The old field is removed only after the project file accepts the value, so
   * a filesystem failure cannot silently discard a user's configured limit.
   */
  async function migrateProviderConfig(providerId: string, providerConfig: Record<string, unknown>): Promise<boolean> {
    if (!('maxTokens' in providerConfig))
      return false

    await initialize()
    const legacyValue = providerConfig.maxTokens
    const normalizedLegacyValue = typeof legacyValue === 'number'
      && Number.isFinite(legacyValue)
      && legacyValue > 0
      ? Math.floor(legacyValue)
      : undefined

    if (normalizedLegacyValue !== undefined && getProviderMaxTokensOverride(providerId) === undefined)
      await setProviderMaxTokens(providerId, normalizedLegacyValue)

    delete providerConfig.maxTokens
    return true
  }

  return {
    configurePersistence,
    getProviderMaxTokens,
    getProviderMaxTokensOverride,
    initialize,
    migrateProviderConfig,
    refresh,
    setProviderMaxTokens,
  }
})

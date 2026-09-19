import type { InferenceServiceProvider } from '../models/inference-service-providers'

import { nanoid } from 'nanoid'

import { getDefinedProvider, listProviders } from '../libs/providers/providers'

/**
 * Inference service provider domain operations used by controller stores.
 *
 * Provider configuration is local to this desktop app: this service builds and
 * describes configs, and the provider catalog model owns persistence.
 */
export interface InferenceServiceProvidersService {
  /** Builds a local provider config from a built-in definition. */
  buildLocal: (definitionId: string, initialConfig?: Record<string, unknown>) => InferenceServiceProvider
  /** Gets one built-in provider definition. */
  getDefinition: (definitionId: string) => ReturnType<typeof getDefinedProvider>
  /** Lists built-in provider definitions. */
  listDefinitions: typeof listProviders
}

/**
 * Provider config validation state carried by one config commit.
 */
export interface PatchConfigParams {
  /** Whether the provider config has passed validation. */
  validated: boolean
  /** Whether validation was intentionally bypassed by the user. */
  validationBypassed: boolean
}

/**
 * Creates the inference service provider facade consumed by controller stores.
 *
 * Use when:
 * - Wiring controller stores to provider domain operations.
 * - Tests need to replace the whole service surface with one mock object.
 *
 * Returns:
 * - A stable object containing provider domain operations.
 */
export function createInferenceServiceProvidersService(): InferenceServiceProvidersService {
  function getDefinition(definitionId: string) {
    return getDefinedProvider(definitionId)
  }

  function listDefinitions() {
    return listProviders()
  }

  function buildLocal(definitionId: string, initialConfig: Record<string, unknown> = {}): InferenceServiceProvider {
    const definition = getDefinition(definitionId)
    if (!definition)
      throw new Error(`Provider definition with id "${definitionId}" not found.`)

    return {
      config: initialConfig,
      definitionId,
      id: nanoid(),
      name: definition.name,
      validated: false,
      validationBypassed: false,
    }
  }

  return {
    buildLocal,
    getDefinition,
    listDefinitions,
  }
}

export const inferenceServiceProvidersService = createInferenceServiceProvidersService()

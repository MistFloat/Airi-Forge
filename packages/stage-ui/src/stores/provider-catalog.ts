import type { Ref } from 'vue'

import type { InferenceServiceProvider } from '../models/inference-service-providers'
import type { PatchConfigParams } from '../services/inference-service-providers'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { inferenceServiceProvidersModel as model } from '../models/inference-service-providers'
import { inferenceServiceProvidersService as service } from '../services/inference-service-providers'

/**
 * Builds the controller consumed by the provider catalog store.
 *
 * Provider configuration is stored locally by `model`; this store used to also
 * mirror it to a hosted backend, which this desktop app no longer has.
 */
export function createProviderCatalogStoreController(params: {
  configs: Ref<Record<string, InferenceServiceProvider>>
  model: Pick<typeof model, 'list' | 'remove' | 'upsert'>
  service: Pick<typeof service, 'buildLocal' | 'getDefinition' | 'listDefinitions'>
}) {
  const { configs, model: modelPort, service: servicePort } = params
  const defs = computed(() => servicePort.listDefinitions())

  /** Loads the locally persisted provider configs. */
  async function fetchList() {
    configs.value = await modelPort.list()
    return configs.value
  }

  async function addProvider(definitionId: string, initialConfig: Record<string, unknown> = {}) {
    const provider = servicePort.buildLocal(definitionId, initialConfig)
    configs.value[provider.id] = provider
    await modelPort.upsert(provider)
    return provider
  }

  async function removeProvider(providerId: string) {
    if (!configs.value[providerId])
      return

    delete configs.value[providerId]
    await modelPort.remove(providerId)
  }

  async function commitProviderConfig(providerId: string, newConfig: Record<string, unknown>, options: PatchConfigParams) {
    const provider = configs.value[providerId]
    if (!provider)
      return

    const next = {
      ...provider,
      config: { ...newConfig },
      validated: options.validated,
      validationBypassed: options.validationBypassed,
    }
    configs.value[providerId] = next
    await modelPort.upsert(next)
    return next
  }

  return {
    addProvider,
    commitProviderConfig,
    configs,
    defs,
    fetchList,
    getDefinedProvider: servicePort.getDefinition,
    removeProvider,
  }
}

export const useProviderCatalogStore = defineStore('provider-catalog', () => {
  const configs = ref<Record<string, InferenceServiceProvider>>({})

  return createProviderCatalogStoreController({
    configs,
    model,
    service,
  })
})

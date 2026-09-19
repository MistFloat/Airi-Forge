import type { InferenceServiceProvider, InferenceServiceProvidersModel } from '../models/inference-service-providers'
import type { InferenceServiceProvidersService } from '../services/inference-service-providers'

import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { providerOpenAICompatible } from '../libs/providers/providers/openai-compatible'
import { createProviderCatalogStoreController } from './provider-catalog'

const localProvider = {
  config: {},
  definitionId: providerOpenAICompatible.id,
  id: 'local-provider',
  name: 'OpenAI Compatible',
  validated: false,
  validationBypassed: false,
} satisfies InferenceServiceProvider

function setupController() {
  const model: Pick<InferenceServiceProvidersModel, 'list' | 'remove' | 'upsert'> = {
    list: vi.fn(async () => ({})),
    remove: vi.fn(async () => {}),
    upsert: vi.fn(async () => {}),
  }
  const service: Pick<InferenceServiceProvidersService, 'buildLocal' | 'getDefinition' | 'listDefinitions'> = {
    buildLocal: vi.fn(() => localProvider),
    getDefinition: vi.fn(() => providerOpenAICompatible),
    listDefinitions: vi.fn(() => [providerOpenAICompatible]),
  }
  const controller = createProviderCatalogStoreController({
    configs: ref<Record<string, InferenceServiceProvider>>({}),
    model,
    service,
  })

  return { controller, model, service }
}

/**
 * @example
 * describe('store provider-catalog controller', () => {})
 */
describe('store provider-catalog controller', () => {
  it('fetchList loads the locally persisted configs', async () => {
    const { controller, model } = setupController()
    vi.mocked(model.list).mockResolvedValueOnce({ 'local-id': { ...localProvider, id: 'local-id' } })

    await expect(controller.fetchList()).resolves.toEqual({ 'local-id': { ...localProvider, id: 'local-id' } })
    expect(controller.configs.value['local-id']).toBeDefined()
  })

  it('adds a provider locally and persists it', async () => {
    const { controller, model, service } = setupController()

    await expect(controller.addProvider(providerOpenAICompatible.id, { apiKey: 'sk-test' })).resolves.toEqual(localProvider)

    expect(service.buildLocal).toHaveBeenCalledWith(providerOpenAICompatible.id, { apiKey: 'sk-test' })
    expect(controller.configs.value[localProvider.id]).toEqual(localProvider)
    expect(model.upsert).toHaveBeenCalledWith(localProvider)
  })

  it('commits a config change locally and persists it', async () => {
    const { controller, model } = setupController()
    controller.configs.value[localProvider.id] = localProvider

    const committed = await controller.commitProviderConfig(
      localProvider.id,
      { apiKey: 'sk-test' },
      { validated: true, validationBypassed: false },
    )

    expect(committed).toEqual({
      ...localProvider,
      config: { apiKey: 'sk-test' },
      validated: true,
    })
    expect(controller.configs.value[localProvider.id]).toEqual(committed)
    expect(model.upsert).toHaveBeenCalledWith(committed)
  })

  it('ignores a config commit for a provider it does not hold', async () => {
    const { controller, model } = setupController()

    await expect(controller.commitProviderConfig('missing-provider', {}, { validated: false, validationBypassed: false }))
      .resolves
      .toBeUndefined()
    expect(model.upsert).not.toHaveBeenCalled()
  })

  it('removes a provider locally and persists the removal', async () => {
    const { controller, model } = setupController()
    controller.configs.value[localProvider.id] = localProvider

    await controller.removeProvider(localProvider.id)

    expect(controller.configs.value[localProvider.id]).toBeUndefined()
    expect(model.remove).toHaveBeenCalledWith(localProvider.id)
  })

  it('exposes the built-in definitions', () => {
    const { controller } = setupController()

    expect(controller.defs.value.map(definition => definition.id)).toEqual([providerOpenAICompatible.id])
    expect(controller.getDefinedProvider(providerOpenAICompatible.id)).toBe(providerOpenAICompatible)
  })
})

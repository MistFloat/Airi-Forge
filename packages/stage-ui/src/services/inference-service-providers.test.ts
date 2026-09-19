import { describe, expect, it } from 'vitest'

import { providerOpenAICompatible } from '../libs/providers/providers/openai-compatible'
import { inferenceServiceProvidersService } from './inference-service-providers'

/**
 * @example
 * describe('services inference-service-providers', () => {})
 */
describe('services inference-service-providers', () => {
  /**
   * @example
   * const provider = inferenceServiceProvidersService.buildLocal('openai-compatible')
   */
  it('builds a local provider from a known definition', () => {
    const provider = inferenceServiceProvidersService.buildLocal(providerOpenAICompatible.id, {})

    expect(provider.id).toBeDefined()
    expect(provider.definitionId).toBe(providerOpenAICompatible.id)
    expect(provider.name).toBe('OpenAI Compatible')
    expect(provider.config).toEqual({})
    expect(provider.validated).toBe(false)
    expect(provider.validationBypassed).toBe(false)
  })

  /**
   * @example
   * expect(() => inferenceServiceProvidersService.buildLocal('missing')).toThrow()
   */
  it('rejects unknown provider definitions', () => {
    expect(() => inferenceServiceProvidersService.buildLocal('missing-definition', {})).toThrow('Provider definition with id "missing-definition" not found.')
  })

  /**
   * @example
   * inferenceServiceProvidersService.getDefinition('openai-compatible')
   */
  it('resolves one definition and lists every definition', () => {
    expect(inferenceServiceProvidersService.getDefinition(providerOpenAICompatible.id)?.id)
      .toBe(providerOpenAICompatible.id)
    expect(inferenceServiceProvidersService.getDefinition('missing-definition')).toBeUndefined()
    expect(inferenceServiceProvidersService.listDefinitions().map(definition => definition.id))
      .toContain(providerOpenAICompatible.id)
  })
})

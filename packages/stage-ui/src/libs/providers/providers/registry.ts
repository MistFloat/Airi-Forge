import type { ComposerTranslation } from 'vue-i18n'
import type { $ZodType } from 'zod/v4/core'

import type { ProviderDefinition } from '../types'

import { orderBy } from 'es-toolkit'

const providerRegistry = new Map<string, ProviderDefinition>()

export function defineProvider<T>(definition: { createProviderConfig: (contextOptions: { t: ComposerTranslation }) => $ZodType<T> } & ProviderDefinition<T>): ProviderDefinition<T> {
  const provider = {
    ...definition,
  }

  providerRegistry.set(definition.id, definition)

  return provider
}

export function getDefinedProvider(id: string): ProviderDefinition | undefined {
  if (isOfficialServiceProvider(id))
    return undefined
  return providerRegistry.get(id)
}

export function listProviders(): ProviderDefinition[] {
  const providerDefs = Array.from(providerRegistry.values())
    .filter(def => !isOfficialServiceProvider(def.id))
    .map(def => ({ order: 99999, ...def }))
  const sorted = orderBy(providerDefs, [p => p.order, 'name'], ['asc', 'asc'])
  return sorted
}

function isOfficialServiceProvider(id: string): boolean {
  return id.startsWith('official-provider') || id.startsWith('vision-official-provider')
}

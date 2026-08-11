import type { ProviderMaxTokensConfig } from '@proj-airi/stage-shared'

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { DEFAULT_PROVIDER_MAX_TOKENS } from '@proj-airi/stage-shared'
import { integer, literal, minValue, number, object, pipe, record, safeParse, string } from 'valibot'

const configSchema = object({
  default: pipe(number(), integer(), minValue(1)),
  providers: record(string(), pipe(number(), integer(), minValue(1))),
  version: literal(1),
})

/** Filesystem boundary for the portable provider output-token policy. */
export interface ProviderMaxTokensConfigRepository {
  /** Reads and validates the complete project policy. */
  read: () => Promise<ProviderMaxTokensConfig>
  /** Sets or removes one provider override and returns the persisted snapshot. */
  set: (providerId: string, maxTokens: number | undefined) => Promise<ProviderMaxTokensConfig>
}

/**
 * Creates an atomic JSON repository for provider output limits.
 *
 * Writes use a sibling temporary file followed by rename so an interrupted save
 * cannot leave the portable configuration half-written.
 */
export function createProviderMaxTokensConfigRepository(configPath: string): ProviderMaxTokensConfigRepository {
  let updateQueue = Promise.resolve()

  async function writeConfig(config: ProviderMaxTokensConfig): Promise<void> {
    await mkdir(dirname(configPath), { recursive: true })
    const temporaryPath = `${configPath}.${randomUUID()}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, configPath)
  }

  async function read(): Promise<ProviderMaxTokensConfig> {
    let raw: string
    try {
      raw = await readFile(configPath, 'utf8')
    }
    catch (error) {
      if (!isMissingFile(error))
        throw error

      const fallback = createDefaultConfig()
      await writeConfig(fallback)
      return fallback
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      await copyFile(configPath, `${configPath}.bak`)
      const fallback = createDefaultConfig()
      await writeConfig(fallback)
      return fallback
    }

    const result = safeParse(configSchema, parsed)
    if (result.success)
      return result.output

    await copyFile(configPath, `${configPath}.bak`)
    const fallback = createDefaultConfig()
    await writeConfig(fallback)
    return fallback
  }

  async function set(providerId: string, maxTokens: number | undefined): Promise<ProviderMaxTokensConfig> {
    const normalizedProviderId = providerId.trim()
    if (!normalizedProviderId)
      throw new Error('Provider ID is required when updating max tokens.')
    if (maxTokens !== undefined && (!Number.isFinite(maxTokens) || maxTokens <= 0))
      throw new RangeError('Provider max tokens must be a positive finite number.')

    let result = createDefaultConfig()
    const update = updateQueue.then(async () => {
      const current = await read()
      const providers = { ...current.providers }
      if (maxTokens === undefined)
        delete providers[normalizedProviderId]
      else
        providers[normalizedProviderId] = Math.floor(maxTokens)

      result = { ...current, providers }
      await writeConfig(result)
    })
    updateQueue = update.catch(() => {})
    await update
    return result
  }

  return { read, set }
}

/**
 * Resolves the portable config beside `pnpm-workspace.yaml`.
 *
 * The Electron dev command may start from either the monorepo root or
 * `apps/stage-tamagotchi`; walking upward keeps both entrypoints on the same file.
 * If no workspace marker exists (for example an unpacked portable copy), the
 * supplied working directory remains the ownership root.
 */
export function resolveProviderMaxTokensConfigPath(startDirectory: string): string {
  const fallbackRoot = resolve(startDirectory)
  let current = fallbackRoot

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml')))
      return join(current, '.airi', 'provider-max-tokens.json')

    const parent = dirname(current)
    if (parent === current)
      return join(fallbackRoot, '.airi', 'provider-max-tokens.json')
    current = parent
  }
}

function createDefaultConfig(): ProviderMaxTokensConfig {
  return {
    default: DEFAULT_PROVIDER_MAX_TOKENS,
    providers: {},
    version: 1,
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT'
}

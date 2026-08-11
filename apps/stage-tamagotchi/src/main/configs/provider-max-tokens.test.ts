import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createProviderMaxTokensConfigRepository,
  resolveProviderMaxTokensConfigPath,
} from './provider-max-tokens'

describe('provider max tokens project config', () => {
  it('stores every provider override in one readable project-local JSON file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airi-provider-max-tokens-'))
    const path = join(directory, '.airi', 'provider-max-tokens.json')
    const repository = createProviderMaxTokensConfigRepository(path)

    await repository.set('deepseek', 65536)
    await repository.set('openai', 32768)

    expect(await repository.read()).toEqual({
      default: 16384,
      providers: {
        deepseek: 65536,
        openai: 32768,
      },
      version: 1,
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      default: 16384,
      providers: {
        deepseek: 65536,
        openai: 32768,
      },
      version: 1,
    })
  })

  it('removes a provider override without removing the shared default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airi-provider-max-tokens-'))
    const repository = createProviderMaxTokensConfigRepository(join(directory, 'provider-max-tokens.json'))

    await repository.set('deepseek', 65536)
    await repository.set('deepseek', undefined)

    expect(await repository.read()).toEqual({
      default: 16384,
      providers: {},
      version: 1,
    })
  })

  it('resolves the config from the monorepo root instead of the current app directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'airi-provider-max-tokens-root-'))
    const nestedDirectory = join(directory, 'apps', 'stage-tamagotchi')
    await mkdir(nestedDirectory, { recursive: true })
    await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n')

    expect(resolveProviderMaxTokensConfigPath(nestedDirectory)).toBe(
      join(directory, '.airi', 'provider-max-tokens.json'),
    )
  })
})

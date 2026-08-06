import { describe, expect, it, vi } from 'vitest'

import { setupBuiltInServer } from './index'

describe('setupBuiltInServer', () => {
  it('starts registered adapters during setup', async () => {
    const auth = { key: 'auth', start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const assets = { key: 'assets', start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }

    await setupBuiltInServer({
      authServer: auth,
      staticAssetServer: assets,
    })

    expect(auth.start).toHaveBeenCalledOnce()
    expect(assets.start).toHaveBeenCalledOnce()
  })
})

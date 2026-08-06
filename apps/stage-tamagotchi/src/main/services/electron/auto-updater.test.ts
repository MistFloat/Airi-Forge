import { describe, expect, it, vi } from 'vitest'

import { setupAutoUpdater } from './auto-updater'

describe('setupAutoUpdater', () => {
  it('keeps every updater operation disabled without touching network APIs', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const service = setupAutoUpdater()

    await service.checkForUpdates()
    await service.downloadUpdate()
    await service.quitAndInstall()

    expect(service.state).toEqual({ status: 'disabled' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('preserves preferences for the existing settings IPC contract', async () => {
    const persist = vi.fn()
    const service = setupAutoUpdater({
      getStoredUpdateLane: () => 'beta',
      setStoredUpdateLane: persist,
    })

    expect(service.getPreferredUpdateLane()).toBe('beta')
    await service.setPreferredUpdateLane('stable')
    expect(service.getPreferredUpdateLane()).toBe('stable')
    expect(persist).toHaveBeenCalledWith('stable')
  })

  it('immediately reports the disabled state to subscribers', () => {
    const subscriber = vi.fn()
    const service = setupAutoUpdater()

    const dispose = service.subscribe(subscriber)

    expect(subscriber).toHaveBeenCalledWith({ status: 'disabled' })
    expect(dispose).toEqual(expect.any(Function))
  })
})

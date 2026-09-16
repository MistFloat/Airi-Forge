import { number, object } from 'valibot'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * @example
 * describe('createConfig', () => {
 *   it('persists configuration data', async () => {
 *     // assertions
 *   })
 * })
 */
describe('createConfig', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  /**
   * @example
   * it('uses a unique temp file per save to avoid concurrent rename collisions', async () => {
   *   await vi.waitFor(() => {
   *     expect(renameMock).toHaveBeenCalledTimes(2)
   *   })
   * })
   *
   * Failed to save config Error: ENOENT: no such file or directory, rename '/path/to/the/electron/app/data/app-config.json.tmp' -> '/path/to/the/electron/app/data/app-config.json'
   *   at async rename (node:internal/fs/promises:785:10)
   *   at async file://./airi/apps/stage-tamagotchi/out/main/index.js:3327:4 {
   *     errno: -2,
   *     code: 'ENOENT',
   *     syscall: 'rename',
   *     path: '/path/to/the/electron/app/data/app-config.json.tmp',
   *     dest: '/path/to/the/electron/app/data/app-config.json'
   *   }
   *
   * ROOT CAUSE:
   *
   * If concurrent save calls share one temporary file path, one rename removes the file first.
   * This causes a second rename attempt to fail with ENOENT, and the save path logs an error.
   *
   * We fixed this by asserting each save operation writes and renames a distinct temp file path.
   */
  it('serializes atomic saves so an older snapshot cannot overwrite a newer one', async () => {
    const appMock = {
      getPath: vi.fn(() => '/tmp/airi-user-data'),
    }
    const mkdirMock = vi.fn(async () => {})
    const existingTempFiles = new Set<string>()
    const renameMock = vi.fn(async (from: string) => {
      if (!existingTempFiles.has(from)) {
        const error = new Error(`ENOENT: no such file or directory, rename '${from}'`) as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      existingTempFiles.delete(from)
    })
    const firstWrite = Promise.withResolvers<void>()
    const writeFileMock = vi.fn(async (path: string) => {
      existingTempFiles.add(path)
      if (writeFileMock.mock.calls.length === 1)
        await firstWrite.promise
    })

    vi.doMock('electron', () => ({
      app: appMock,
    }))
    vi.doMock('es-toolkit', () => ({
      throttle: (handler: (...args: unknown[]) => unknown) => handler,
    }))
    vi.doMock('node:fs', () => ({
      existsSync: () => false,
      readFileSync: () => '',
    }))
    vi.doMock('node:fs/promises', () => ({
      copyFile: vi.fn(async () => {}),
      mkdir: mkdirMock,
      rename: renameMock,
      writeFile: writeFileMock,
    }))

    const { createConfig } = await import('./persistence')
    const schema = object({ value: number() })
    const config = createConfig('windows-widgets', 'config.json', schema, { default: { value: 0 } })
    const saveErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    config.setup()
    config.update({ value: 1 })
    config.update({ value: 2 })

    await vi.waitFor(() => {
      expect(writeFileMock).toHaveBeenCalledTimes(1)
    })
    expect(renameMock).not.toHaveBeenCalled()
    firstWrite.resolve()

    /**
     * @example
     * expect(renameMock).toHaveBeenCalledTimes(2)
     * expect(saveErrorSpy).not.toHaveBeenCalledWith('Failed to save config', expect.anything())
     * expect(new Set(renameMock.mock.calls.map(([from]) => from)).size).toBe(2)
     */
    await vi.waitFor(() => {
      expect(renameMock).toHaveBeenCalledTimes(2)
    })

    expect(saveErrorSpy).not.toHaveBeenCalledWith('Failed to save config', expect.anything())
    expect(new Set(renameMock.mock.calls.map(([from]) => from)).size).toBe(2)
    saveErrorSpy.mockRestore()
  })

  it('flush waits until the latest in-memory snapshot is atomically persisted', async () => {
    const appMock = {
      getPath: vi.fn(() => '/tmp/airi-user-data'),
    }
    const writeGate = Promise.withResolvers<void>()
    const writeFileMock = vi.fn(async () => {
      await writeGate.promise
    })
    const renameMock = vi.fn(async () => {})

    vi.doMock('electron', () => ({ app: appMock }))
    vi.doMock('es-toolkit', () => ({
      throttle: () => Object.assign(() => {}, {
        cancel: vi.fn(),
        flush: vi.fn(),
      }),
    }))
    vi.doMock('node:fs', () => ({
      existsSync: () => false,
      readFileSync: () => '',
    }))
    vi.doMock('node:fs/promises', () => ({
      copyFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => {}),
      rename: renameMock,
      writeFile: writeFileMock,
    }))

    const { createConfig } = await import('./persistence')
    const config = createConfig(
      'agent-runtime',
      'turns.json',
      object({ value: number() }),
      { default: { value: 0 } },
    )
    config.setup()
    config.update({ value: 2 })

    const flushed = config.flush()
    await vi.waitFor(() => {
      expect(writeFileMock).toHaveBeenCalledWith(
        expect.any(String),
        JSON.stringify({ value: 2 }),
      )
    })
    expect(renameMock).not.toHaveBeenCalled()

    writeGate.resolve()
    await flushed
    expect(renameMock).toHaveBeenCalledTimes(1)
  })
})

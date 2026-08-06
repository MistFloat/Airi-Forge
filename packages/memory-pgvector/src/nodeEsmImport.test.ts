import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('memory package native ESM boundary', () => {
  it('loads the source export without a Vite resolver', () => {
    // ROOT CAUSE:
    //
    // Electron externalizes this workspace package and Node loads store.ts directly.
    // Extensionless imports worked in Vitest/Vite but failed during application startup.
    // The child process deliberately bypasses Vite so this boundary cannot regress silently.
    const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', 'await import("./packages/memory-pgvector/src/store.ts"); process.stdout.write("ok")'],
      { cwd: workspaceRoot, encoding: 'utf8' },
    )

    expect(output).toBe('ok')
  })
})

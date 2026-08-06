import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createWorkdir } from '../lib/workdir'
import { gitAddTool, gitCommitTool, gitDiffTool, gitLogTool, gitPushTool, gitRawTool, gitStatusTool, gitUndoTool } from './git'

const execFileAsync = promisify(execFile)

// Detect git synchronously at collection time; `describe.skipIf` is evaluated
// before `beforeAll` runs, so an async probe would always skip.
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  }
  catch {
    return false
  }
})()

let root: string
let workdir: ReturnType<typeof createWorkdir>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coding-agent-git-'))
  workdir = createWorkdir(root)
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n')
})

afterEach(() => {
  rmSync(root, { force: true, recursive: true })
})

async function initRepo(): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: root })
  await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: root })
}

describe.skipIf(!gitAvailable)('git tools', () => {
  it('git_status reports a clean tree and branch', async () => {
    await initRepo()
    const result = await gitStatusTool({}, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ branch: expect.stringMatching(/^(main|master)$/) })
  })

  it('git_status reports untracked and modified files', async () => {
    await initRepo()
    writeFileSync(join(root, 'untracked.txt'), 'x')
    writeFileSync(join(root, 'a.txt'), 'one\nCHANGED\n')

    const result = await gitStatusTool({}, { enableCommit: true, workdir })
    const entries = result.structuredContent?.entries as Array<{ path: string, status: string }>
    expect(entries).toEqual(expect.arrayContaining([
      { path: 'a.txt', status: ' M' },
      { path: 'untracked.txt', status: '??' },
    ]))
  })

  it('git_diff shows unstaged changes', async () => {
    await initRepo()
    writeFileSync(join(root, 'a.txt'), 'one\nCHANGED\n')
    const result = await gitDiffTool({}, { enableCommit: true, workdir })
    expect(result.content[0].text).toContain('+CHANGED')
    expect(result.content[0].text).toContain('-two')
  })

  it('git_diff --staged shows staged changes', async () => {
    await initRepo()
    writeFileSync(join(root, 'b.txt'), 'new\n')
    await execFileAsync('git', ['add', 'b.txt'], { cwd: root })
    const result = await gitDiffTool({ staged: true }, { enableCommit: true, workdir })
    expect(result.content[0].text).toContain('b.txt')
    expect(result.content[0].text).toContain('+new')
  })

  it('git_commit refuses when disabled', async () => {
    const result = await gitCommitTool({ message: 'wip' }, { enableCommit: false, workdir })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('disabled')
  })

  it('git_commit commits staged changes when enabled', async () => {
    await initRepo()
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root })

    const result = await gitCommitTool({ message: 'add three' }, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    const log = (await execFileAsync('git', ['log', '--oneline'], { cwd: root })).stdout
    expect(log).toContain('add three')
  })

  it('git_commit requires a non-empty message', async () => {
    const result = await gitCommitTool({ message: '   ' }, { enableCommit: true, workdir })
    expect(result.isError).toBe(true)
  })

  it('git_add stages explicit paths only', async () => {
    await initRepo()
    writeFileSync(join(root, 'a.txt'), 'one\nCHANGED\n')
    writeFileSync(join(root, 'untracked.txt'), 'x')

    const result = await gitAddTool({ paths: ['a.txt'] }, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    const status = (await execFileAsync('git', ['status', '--short'], { cwd: root })).stdout
    expect(status).toContain('M  a.txt')
    expect(status).toContain('?? untracked.txt')
  })

  it('git_add without paths stages every change including deletions', async () => {
    await initRepo()
    writeFileSync(join(root, 'b.txt'), 'new\n')
    rmSync(join(root, 'a.txt'))

    const result = await gitAddTool({}, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    const status = (await execFileAsync('git', ['status', '--short'], { cwd: root })).stdout
    expect(status).toContain('D  a.txt')
    expect(status).toContain('A  b.txt')
  })

  it('git_add rejects paths outside the workdir', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'coding-agent-outside-'))
    try {
      const result = await gitAddTool({ paths: [outside] }, { enableCommit: true, workdir })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('outside the workdir')
    }
    finally {
      rmSync(outside, { force: true, recursive: true })
    }
  })

  it('git_push rejects invalid remote or branch names', async () => {
    const badRemote = await gitPushTool({ remote: 'bad remote; rm -rf' }, { enableCommit: true, workdir })
    expect(badRemote.isError).toBe(true)
    expect(badRemote.content[0].text).toContain('Invalid git remote name')

    const badBranch = await gitPushTool({ branch: 'a b' }, { enableCommit: true, workdir })
    expect(badBranch.isError).toBe(true)
    expect(badBranch.content[0].text).toContain('Invalid git branch name')
  })

  it('git_push pushes the current branch to a local bare remote', async () => {
    await initRepo()
    await execFileAsync('git', ['init', '--bare', '-q', join(root, 'remote.git')], { cwd: root })
    await execFileAsync('git', ['remote', 'add', 'origin', join(root, 'remote.git')], { cwd: root })
    await execFileAsync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: root })
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root })
    await execFileAsync('git', ['commit', '-q', '-m', 'bump'], { cwd: root })

    const result = await gitPushTool({}, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    const refs = (await execFileAsync('git', ['for-each-ref'], { cwd: join(root, 'remote.git') })).stdout
    expect(refs).toMatch(/refs\/heads\/(main|master)/)
  })
})

describe.skipIf(!gitAvailable)('git_undo', () => {
  it('undoes the most recent agent-made commit', async () => {
    await initRepo()
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root })
    await gitCommitTool({ message: 'agent edit' }, { enableCommit: true, workdir })

    const result = await gitUndoTool({}, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    const log = (await execFileAsync('git', ['log', '--oneline'], { cwd: root })).stdout
    expect(log).not.toContain('agent edit')
  })

  it('refuses to undo a user-made commit', async () => {
    await initRepo()
    // Make a commit without the aider-mcp committer marker (simulating the user).
    await execFileAsync('git', ['config', 'user.name', 'real-user'], { cwd: root })
    await execFileAsync('git', ['config', 'user.email', 'real@user'], { cwd: root })
    writeFileSync(join(root, 'user.txt'), 'x\n')
    await execFileAsync('git', ['add', 'user.txt'], { cwd: root })
    await execFileAsync('git', ['commit', '-q', '-m', 'user commit'], { cwd: root })

    const result = await gitUndoTool({}, { enableCommit: true, workdir })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not made by the coding agent')
  })

  it('hard-resets the working tree when hard: true', async () => {
    await initRepo()
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    await execFileAsync('git', ['add', 'a.txt'], { cwd: root })
    await gitCommitTool({ message: 'agent edit' }, { enableCommit: true, workdir })

    const result = await gitUndoTool({ hard: true }, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    // After hard reset, the file should be back to the initial state.
    // Git on Windows may check out with CRLF depending on `core.autocrlf`,
    // so normalize before comparing.
    const content = await import('node:fs/promises').then(fs => fs.readFile(join(root, 'a.txt'), 'utf8'))
    expect(content.replace(/\r\n/g, '\n')).toBe('one\ntwo\n')
  })
})

describe.skipIf(!gitAvailable)('git_log', () => {
  it('shows commit history in oneline format', async () => {
    await initRepo()
    const result = await gitLogTool({}, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('initial')
  })

  it('respects the limit option', async () => {
    await initRepo()
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, `f${i}.txt`), `file ${i}\n`)
      await execFileAsync('git', ['add', `f${i}.txt`], { cwd: root })
      await execFileAsync('git', ['commit', '-q', '-m', `commit ${i}`], { cwd: root })
    }
    const result = await gitLogTool({ limit: 2 }, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    const lines = (result.content[0].text as string).split('\n').filter(l => l.trim())
    // Each commit shows on one line in oneline format.
    expect(lines.length).toBeLessThanOrEqual(2)
  })

  it('restricts to commits touching a path', async () => {
    await initRepo()
    writeFileSync(join(root, 'touched.txt'), 'x\n')
    await execFileAsync('git', ['add', 'touched.txt'], { cwd: root })
    await execFileAsync('git', ['commit', '-q', '-m', 'touch'], { cwd: root })
    const result = await gitLogTool({ paths: ['touched.txt'] }, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('touch')
  })
})

describe.skipIf(!gitAvailable)('git_raw', () => {
  it('runs an arbitrary git subcommand', async () => {
    await initRepo()
    const result = await gitRawTool({ args: ['log', '--oneline'] }, { enableCommit: true, workdir })
    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('initial')
  })

  it('rejects destructive patterns without CODING_AGENT_ENABLE_GIT_FORCE', async () => {
    const result = await gitRawTool({ args: ['push', '--force'] }, { enableCommit: true, workdir })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('destructive')
  })

  it('requires at least one arg', async () => {
    const result = await gitRawTool({ args: [] }, { enableCommit: true, workdir })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('requires at least one arg')
  })
})

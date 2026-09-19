import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseSkillDocument, readSkillDocument, resolveSkillRoots, scanSkillRoots } from './skills'

const createdDirectories: string[] = []

function createTemporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  createdDirectories.push(directory)
  return directory
}

function writeSkill(root: string, id: string, content: string, references: Record<string, string> = {}) {
  const skillDirectory = join(root, id)
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, 'SKILL.md'), content)

  for (const [reference, body] of Object.entries(references)) {
    const target = join(skillDirectory, 'references', reference)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, body)
  }
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true })
})

describe('resolveSkillRoots', () => {
  it('reports bundled, user, and workspace roots in ascending precedence', () => {
    const appPath = createTemporaryDirectory('airi-skills-app-')
    const resourcesPath = createTemporaryDirectory('airi-skills-resources-')
    const userDataPath = createTemporaryDirectory('airi-skills-user-')
    const monorepoRoot = createTemporaryDirectory('airi-skills-workspace-')

    const roots = resolveSkillRoots({ appPath, monorepoRoot, resourcesPath, userDataPath })

    expect(roots).toEqual([
      { path: join(appPath, 'resources', 'skills'), source: 'bundled' },
      { path: join(userDataPath, 'skills'), source: 'user' },
      { path: join(monorepoRoot, '.airi', 'skills'), source: 'workspace' },
    ])
  })

  it('prefers the packaged resource directory when the in-app one is absent', () => {
    const appPath = createTemporaryDirectory('airi-skills-app-')
    const resourcesPath = createTemporaryDirectory('airi-skills-resources-')
    mkdirSync(join(resourcesPath, 'skills'), { recursive: true })

    const roots = resolveSkillRoots({
      appPath,
      monorepoRoot: createTemporaryDirectory('airi-skills-workspace-'),
      resourcesPath,
      userDataPath: createTemporaryDirectory('airi-skills-user-'),
    })

    expect(roots[0]).toEqual({ path: join(resourcesPath, 'skills'), source: 'bundled' })
  })
})

describe('parseSkillDocument', () => {
  it('reads name and description from frontmatter', () => {
    const parsed = parseSkillDocument([
      '---',
      'name: Release notes',
      'description: Writes grouped release notes.',
      '---',
      '',
      '# Release notes',
      '',
      'Body text.',
    ].join('\n'), 'release-notes')

    expect(parsed.name).toBe('Release notes')
    expect(parsed.description).toBe('Writes grouped release notes.')
    expect(parsed.body).toBe('# Release notes\n\nBody text.')
  })

  it('reads folded block scalars used by existing skill files', () => {
    const parsed = parseSkillDocument([
      '---',
      'name: pnpm',
      'description: >-',
      '  Package manager guidance for',
      '  workspaces and catalogs.',
      '---',
      'Body.',
    ].join('\n'), 'pnpm')

    expect(parsed.description).toBe('Package manager guidance for workspaces and catalogs.')
    expect(parsed.body).toBe('Body.')
  })

  it('falls back to the directory name and first body line without frontmatter', () => {
    const parsed = parseSkillDocument('# Heading\n\nRest of the body.', 'untitled-skill')

    expect(parsed.name).toBe('untitled-skill')
    expect(parsed.description).toBe('# Heading')
  })

  it('keeps the body when frontmatter is malformed', () => {
    const parsed = parseSkillDocument('---\nname: [unclosed\n---\nBody only.', 'broken-skill')

    expect(parsed.body).toBe('Body only.')
    expect(parsed.name).toBe('broken-skill')
    expect(parsed.description).toBe('Body only.')
  })
})

describe('scanSkillRoots', () => {
  it('lets a later root override an earlier skill with the same id', () => {
    const userRoot = createTemporaryDirectory('airi-skills-user-')
    const workspaceRoot = createTemporaryDirectory('airi-skills-workspace-')
    writeSkill(userRoot, 'shared', '---\nname: User version\ndescription: From user root.\n---\nUser body.')
    writeSkill(workspaceRoot, 'shared', '---\nname: Workspace version\ndescription: From workspace.\n---\nWorkspace body.')

    const snapshot = scanSkillRoots([
      { path: userRoot, source: 'user' },
      { path: workspaceRoot, source: 'workspace' },
    ])

    expect(snapshot.skills).toEqual([
      expect.objectContaining({
        description: 'From workspace.',
        id: 'shared',
        name: 'Workspace version',
        source: 'workspace',
      }),
    ])
  })

  it('lists nested references and ignores directories without a SKILL.md', () => {
    const root = createTemporaryDirectory('airi-skills-root-')
    writeSkill(root, 'browser', '---\nname: Browser\ndescription: Drives a browser.\n---\nBody.', {
      'authentication.md': 'auth',
      'guides/proxies.md': 'proxies',
    })
    mkdirSync(join(root, 'not-a-skill'), { recursive: true })

    const snapshot = scanSkillRoots([{ path: root, source: 'bundled' }])

    expect(snapshot.skills).toHaveLength(1)
    expect(snapshot.skills[0]?.references).toEqual(['references/authentication.md', 'references/guides/proxies.md'])
  })

  it('keeps reporting missing roots without failing the scan', () => {
    const root = createTemporaryDirectory('airi-skills-root-')
    writeSkill(root, 'only', '---\ndescription: Only skill.\n---\nBody.')

    const snapshot = scanSkillRoots([
      { path: join(root, 'missing'), source: 'bundled' },
      { path: root, source: 'workspace' },
    ])

    expect(snapshot.directories).toHaveLength(2)
    expect(snapshot.skills.map(skill => skill.id)).toEqual(['only'])
    expect(snapshot.skills[0]?.name).toBe('only')
  })
})

describe('readSkillDocument', () => {
  function createSnapshot() {
    const root = createTemporaryDirectory('airi-skills-read-')
    writeSkill(root, 'browser', '---\nname: Browser\ndescription: Drives a browser.\n---\nUse the CLI.\n', {
      'commands.md': '# Commands',
    })
    return { root, snapshot: scanSkillRoots([{ path: root, source: 'bundled' }]) }
  }

  it('reads the body without frontmatter', () => {
    const { snapshot } = createSnapshot()

    expect(readSkillDocument(snapshot, { id: 'browser' })).toEqual({
      content: 'Use the CLI.',
      id: 'browser',
      kind: 'skill',
      path: expect.stringContaining('SKILL.md'),
    })
  })

  it('reads an advertised reference document', () => {
    const { snapshot } = createSnapshot()

    expect(readSkillDocument(snapshot, { id: 'browser', reference: 'references/commands.md' })).toEqual({
      content: '# Commands',
      id: 'browser',
      kind: 'reference',
      path: expect.stringContaining('commands.md'),
      reference: 'references/commands.md',
    })
  })

  it('rejects an unknown skill and names the available ones', () => {
    const { snapshot } = createSnapshot()

    expect(() => readSkillDocument(snapshot, { id: 'missing' }))
      .toThrow('Unknown skill "missing". Available skills: browser')
  })

  it('rejects a reference that the listing never advertised', () => {
    const { snapshot } = createSnapshot()

    expect(() => readSkillDocument(snapshot, { id: 'browser', reference: '../../secret.txt' }))
      .toThrow('Unknown reference "../../secret.txt" for skill "browser". Available references: references/commands.md')
  })
})

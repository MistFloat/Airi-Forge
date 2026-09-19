import type { Dirent } from 'node:fs'

import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { SkillReadInput, SkillReadResult, SkillSnapshot, SkillSource, SkillSummary } from '@proj-airi/stage-shared'
import type { BrowserWindow } from 'electron'

import process from 'node:process'

import { existsSync, readdirSync, readFileSync, watch } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { SKILL_FILE_NAME, SKILL_REFERENCES_DIRECTORY } from '@proj-airi/stage-shared'
import { app } from 'electron'
import { parse as parseYaml } from 'yaml'

import { electronSkillsChanged, electronSkillsList, electronSkillsRead } from '../../../shared/eventa'
import { findMonorepoRoot } from './app'

/** Parsed content of one `SKILL.md`. */
export interface ParsedSkillDocument {
  /** Body text with the frontmatter block removed. */
  body: string
  /** Frontmatter description, or the first non-empty body line. */
  description: string
  /** Frontmatter name, or the supplied fallback. */
  name: string
}

/** One directory whose direct children may be skills. */
export interface SkillRoot {
  path: string
  source: SkillSource
}

/** Host inputs needed to locate skill roots; injected so tests avoid Electron. */
export interface SkillRootInput {
  /** Directory of the running app (dev: the app package, packaged: the asar). */
  appPath: string
  /** Monorepo root of a development checkout. */
  monorepoRoot: string
  /** Electron's `process.resourcesPath`, where `extraResources` land. */
  resourcesPath: string
  /** Electron's per-user data directory. */
  userDataPath: string
}

const SKILL_WATCH_DEBOUNCE_MS = 250

/** Host-facing handle returned by {@link createSkillsService}. */
export interface SkillsService {
  /** Removes this window's handlers and watcher registration. */
  dispose: () => void
  /** Re-scans the roots and returns the current snapshot. */
  rescan: () => SkillSnapshot
}

interface SkillsServiceState {
  contexts: Set<ReturnType<typeof createContext>['context']>
  disposers: Set<() => void>
  snapshot: SkillSnapshot
  watchers: ReturnType<typeof watch>[]
  watchTimer?: ReturnType<typeof setTimeout>
}

/**
 * Parses one `SKILL.md` into its frontmatter fields and body.
 *
 * Parsing never throws: a missing or malformed frontmatter block still yields a
 * usable document, because a skill with a broken header should stay visible
 * (and fixable) instead of disappearing from the listing.
 */
export function parseSkillDocument(raw: string, fallbackName: string): ParsedSkillDocument {
  const { body, data } = readFrontmatter(raw)
  const name = readFrontmatterString(data?.name) ?? fallbackName
  const description = readFrontmatterString(data?.description) ?? firstNonEmptyLine(body)

  return { body: body.trim(), description, name }
}

/**
 * Reads one skill body or one of its reference documents.
 *
 * Only the reference names advertised by {@link SkillSummary.references} are
 * accepted, so a caller cannot walk out of the skill directory.
 */
export function readSkillDocument(snapshot: SkillSnapshot, input: SkillReadInput): SkillReadResult {
  const skill = snapshot.skills.find(item => item.id === input.id)
  if (!skill) {
    const available = snapshot.skills.map(item => item.id).join(', ') || 'none'
    throw new Error(`Unknown skill "${input.id}". Available skills: ${available}`)
  }

  if (!input.reference) {
    const parsed = parseSkillDocument(readFileSync(skill.path, 'utf-8'), skill.id)
    return { content: parsed.body, id: skill.id, kind: 'skill', path: skill.path }
  }

  const reference = skill.references.find(item => item === input.reference)
  if (!reference) {
    const available = skill.references.join(', ') || 'none'
    throw new Error(`Unknown reference "${input.reference}" for skill "${skill.id}". Available references: ${available}`)
  }

  const target = join(dirname(skill.path), reference)
  return {
    content: readFileSync(target, 'utf-8'),
    id: skill.id,
    kind: 'reference',
    path: target,
    reference,
  }
}

/**
 * Locates the skill roots in ascending precedence.
 *
 * Bundled skills ship with the app, so the packaged location next to the asar
 * is checked after the in-app `resources` directory. Missing roots are still
 * reported in the snapshot so diagnostics can show what would have been scanned.
 */
export function resolveSkillRoots(input: SkillRootInput): SkillRoot[] {
  const bundledCandidates = [
    join(input.appPath, 'resources', 'skills'),
    join(input.resourcesPath, 'skills'),
  ]
  const bundled = bundledCandidates.find(existsSync) ?? bundledCandidates[0]

  return [
    { path: bundled, source: 'bundled' },
    { path: join(input.userDataPath, 'skills'), source: 'user' },
    { path: join(input.monorepoRoot, '.airi', 'skills'), source: 'workspace' },
  ]
}

/**
 * Scans skill roots into a snapshot.
 *
 * Roots are read in the order given, and a later root replaces an earlier skill
 * with the same directory name, which is how a workspace skill overrides a
 * bundled one without renaming it.
 */
export function scanSkillRoots(roots: readonly SkillRoot[]): SkillSnapshot {
  const skillsById = new Map<string, SkillSummary>()

  for (const root of roots) {
    if (!existsSync(root.path))
      continue

    let entries: Dirent[]
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    }
    catch (error) {
      console.warn(`[Skills] Failed to read skill root ${root.path}:`, error)
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory())
        continue

      const skillFile = join(root.path, entry.name, SKILL_FILE_NAME)
      if (!existsSync(skillFile))
        continue

      let parsed: ParsedSkillDocument = { body: '', description: '', name: entry.name }
      try {
        parsed = parseSkillDocument(readFileSync(skillFile, 'utf-8'), entry.name)
      }
      catch (error) {
        console.warn(`[Skills] Failed to read ${skillFile}:`, error)
      }

      skillsById.set(entry.name, {
        description: parsed.description,
        id: entry.name,
        name: parsed.name,
        path: skillFile,
        references: listSkillReferences(join(root.path, entry.name)),
        source: root.source,
      })
    }
  }

  return {
    directories: roots.map(root => ({ path: root.path, source: root.source })),
    skills: [...skillsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
  }
}

let sharedState: SkillsServiceState | undefined

/**
 * Registers the skill IPC surface for one renderer window.
 *
 * The scan and its file watchers are process-wide: the first window starts
 * them, later windows reuse the snapshot, and every change is broadcast to all
 * registered windows. Each registration disposes only its own handlers.
 */
export function createSkillsService(params: {
  context: ReturnType<typeof createContext>['context']
  window?: BrowserWindow
}): SkillsService {
  const state = sharedState ??= createSharedState()

  state.contexts.add(params.context)
  const dispose = () => {
    state.contexts.delete(params.context)
    state.disposers.delete(dispose)
    if (state.contexts.size === 0)
      stopSharedState(state)
  }
  state.disposers.add(dispose)

  defineInvokeHandler(params.context, electronSkillsList, () => state.snapshot)
  defineInvokeHandler(params.context, electronSkillsRead, input => readSkillDocument(state.snapshot, input))

  params.window?.once('closed', dispose)

  return { dispose, rescan: () => refreshSharedState(state) }
}

function createSharedState(): SkillsServiceState {
  const state: SkillsServiceState = {
    contexts: new Set(),
    disposers: new Set(),
    snapshot: { directories: [], skills: [] },
    watchers: [],
  }

  refreshSharedState(state)
  startWatching(state)
  return state
}

function currentSkillRoots(): SkillRoot[] {
  return resolveSkillRoots({
    appPath: app.getAppPath(),
    monorepoRoot: findMonorepoRoot(process.cwd()),
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  })
}

function firstNonEmptyLine(body: string): string {
  return body
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ''
}

function listSkillReferences(skillDirectory: string): string[] {
  const referencesDirectory = join(skillDirectory, SKILL_REFERENCES_DIRECTORY)
  if (!existsSync(referencesDirectory))
    return []

  const references: string[] = []
  const walk = (directory: string) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    }
    catch (error) {
      console.warn(`[Skills] Failed to read ${directory}:`, error)
      return
    }

    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      if (!entry.isFile())
        continue

      // Reference paths are handed back to the renderer and must stay relative
      // so they survive a moved skill root and cannot address the filesystem.
      references.push(relative(skillDirectory, absolute).split(sep).join('/'))
    }
  }

  walk(referencesDirectory)
  return references.sort()
}

function readFrontmatter(raw: string): { body: string, data?: Record<string, unknown> } {
  const normalized = raw.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---'))
    return { body: normalized }

  const end = normalized.indexOf('\n---', 3)
  if (end === -1)
    return { body: normalized }

  const block = normalized.slice(3, end)
  const bodyStart = normalized.indexOf('\n', end + 1)
  const body = bodyStart === -1 ? '' : normalized.slice(bodyStart + 1)

  try {
    const parsed: unknown = parseYaml(block)
    if (parsed !== null && typeof parsed === 'object')
      return { body, data: parsed as Record<string, unknown> }
  }
  catch (error) {
    console.warn('[Skills] Failed to parse skill frontmatter:', error)
  }

  // A malformed header is still a header: the body must not leak YAML into the
  // model context just because parsing failed.
  return { body }
}

function readFrontmatterString(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function refreshSharedState(state: SkillsServiceState): SkillSnapshot {
  state.snapshot = scanSkillRoots(currentSkillRoots())
  state.contexts.forEach(context => context.emit(electronSkillsChanged, state.snapshot))
  return state.snapshot
}

function scheduleRescan(state: SkillsServiceState) {
  if (state.watchTimer)
    clearTimeout(state.watchTimer)

  // Editors write several times per save, so the rescan waits for the burst to
  // settle before re-reading the skill directories.
  state.watchTimer = setTimeout(() => {
    state.watchTimer = undefined
    refreshSharedState(state)
  }, SKILL_WATCH_DEBOUNCE_MS)
}

function startWatching(state: SkillsServiceState) {
  for (const root of currentSkillRoots()) {
    if (!existsSync(root.path))
      continue

    try {
      state.watchers.push(watch(root.path, { persistent: false, recursive: true }, () => scheduleRescan(state)))
    }
    catch (error) {
      console.warn(`[Skills] Failed to watch ${root.path}:`, error)
    }
  }
}

function stopSharedState(state: SkillsServiceState) {
  for (const watcher of state.watchers)
    watcher.close()
  state.watchers = []

  if (state.watchTimer) {
    clearTimeout(state.watchTimer)
    state.watchTimer = undefined
  }

  sharedState = undefined
}

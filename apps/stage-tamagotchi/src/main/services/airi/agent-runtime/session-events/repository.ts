import type { AgentSessionEvent } from '@proj-airi/core-agent'

import { Buffer } from 'node:buffer'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip, gunzipSync } from 'node:zlib'

import { app } from 'electron'

import { createConfig } from '../../../../libs/electron/persistence'
import { agentSessionEventStateSchema, isKnownAgentSessionEventType, parseAgentSessionEvents } from './schemas'

/** One semantic-consumer boundary that permits older hot events to become cold. */
export interface AgentSessionEventCompaction {
  /** Event identities that must remain resident for state recovery or recent UI replay. */
  retainedSequences: readonly number[]
  /** Session whose closed segments may be archived. */
  sessionId: string
  /** Highest sequence successfully consumed by the memory projection. */
  throughSequence: number
}

/** Legacy full-document format retained only as a migration source. */
export interface AgentSessionEventPersistenceState {
  /** Complete ordered event arrays keyed by session ID. */
  sessions: Record<string, AgentSessionEvent[]>
}

/** Filesystem and segmentation policy for the append-only repository. */
export interface AgentSessionEventRepositoryOptions {
  /** Validated old snapshot read during first migration. */
  legacyStore?: LegacyAgentSessionEventStore
  /** Maximum target size of one JSONL segment. @default 8 MiB */
  maxSegmentBytes?: number
  /** Directory that owns per-session JSONL segments. */
  rootDirectory?: string
}

/** Read-only legacy snapshot boundary used for one-time event-log migration. */
export interface LegacyAgentSessionEventStore {
  /** Returns the validated legacy snapshot. */
  get: () => AgentSessionEventPersistenceState | undefined
  /** Loads and validates the legacy snapshot file. */
  setup: () => unknown
}

interface ActiveSegment {
  index: number
  size: number
}

interface EventSegment extends ActiveSegment {
  events: AgentSessionEvent[]
  path: string
  sessionId: string
}

interface PendingSegmentWrite {
  data: string
  path: string
}

interface ReplayDependency {
  beforeSequence: number
  key: string
}

/**
 * Creates a per-session append-only event repository with bounded hot replay.
 *
 * Ordinary appends only touch the active JSONL segment. Once memory has
 * consumed a cursor, complete older segments are compressed into immutable
 * cold archives. A small atomically replaced checkpoint retains only current
 * control state and recent UI facts, so startup cost does not grow with the
 * full conversation history.
 */
export function createAgentSessionEventRepository(
  options: AgentSessionEventRepositoryOptions = {},
) {
  const rootDirectory = options.rootDirectory
    ?? join(app.getPath('userData'), 'agent-runtime-session-events')
  const maxSegmentBytes = options.maxSegmentBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes <= 0)
    throw new Error('Agent session event segment size must be a positive safe integer')

  mkdirSync(rootDirectory, { recursive: true })
  const legacyStore = options.legacyStore ?? createConfig(
    'agent-runtime',
    'session-events.json',
    agentSessionEventStateSchema,
    { default: { sessions: {} } },
  )
  migrateLegacySnapshot(rootDirectory, maxSegmentBytes, legacyStore)

  const checkpointEvents = new Map<string, AgentSessionEvent[]>()
  const segments = new Map<string, EventSegment[]>()
  loadRepositoryState(rootDirectory, checkpointEvents, segments)
  const pendingCheckpointRepairs = repairReplayDependenciesFromArchives(
    rootDirectory,
    checkpointEvents,
    segments,
  )

  let pendingWrites: PendingSegmentWrite[] = []
  let writeQueue = Promise.resolve()

  const flush = () => {
    const batch = pendingWrites
    const checkpointRepairBatch = [...pendingCheckpointRepairs]
    pendingWrites = []
    pendingCheckpointRepairs.clear()
    if (batch.length === 0 && checkpointRepairBatch.length === 0)
      return writeQueue

    const write = writeQueue.then(async () => {
      for (const sessionId of checkpointRepairBatch)
        await replaceCheckpoint(rootDirectory, sessionId, checkpointEvents.get(sessionId) ?? [])
      for (const entry of batch) {
        const handle = await open(entry.path, 'a')
        try {
          await handle.appendFile(entry.data, { encoding: 'utf8' })
          await handle.sync()
        }
        finally {
          await handle.close()
        }
      }
    })
    // Keep later flushes operational after a failed write while still
    // returning the original rejection to the durability barrier caller.
    writeQueue = write.catch(() => {})
    return write
  }

  const compact = async (input: AgentSessionEventCompaction): Promise<AgentSessionEvent[]> => {
    if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 1)
      throw new Error('Agent session compaction cursor must be a positive safe integer')
    await flush()

    const operation = writeQueue.then(async () => {
      const sessionSegments = segments.get(input.sessionId) ?? []
      const activeIndex = sessionSegments.at(-1)?.index
      const candidates = sessionSegments.filter((segment) => {
        const lastSequence = segment.events.at(-1)?.sequence ?? 0
        return segment.index !== activeIndex && lastSequence <= input.throughSequence
      })
      const archivedIndexes = new Set(candidates.map(segment => segment.index))
      const remainingSegments = sessionSegments.filter(segment => !archivedIndexes.has(segment.index))
      const retained = new Set(input.retainedSequences)
      const checkpointSource = deduplicateEvents([
        ...(checkpointEvents.get(input.sessionId) ?? []),
        ...candidates.flatMap(segment => segment.events),
      ])
      const requestedCheckpoint = checkpointSource.filter(event => retained.has(event.sequence))
      const nextCheckpoint = retainReplayDependencies(
        requestedCheckpoint,
        remainingSegments.flatMap(segment => segment.events),
        checkpointSource,
      )

      await replaceCheckpoint(rootDirectory, input.sessionId, nextCheckpoint)
      for (const segment of candidates)
        await archiveSegment(rootDirectory, segment)

      checkpointEvents.set(input.sessionId, nextCheckpoint)
      segments.set(input.sessionId, remainingSegments)
    })
    writeQueue = operation.catch(() => {})
    await operation
    return loadSessionEvents(input.sessionId, checkpointEvents, segments)
  }

  return {
    append(event: AgentSessionEvent) {
      const snapshot = structuredClone(event)
      const line = `${JSON.stringify(snapshot)}\n`
      const byteLength = Buffer.byteLength(line)
      const sessionSegments = segments.get(event.sessionId) ?? []
      const current = sessionSegments.at(-1) ?? {
        events: [],
        index: 1,
        path: segmentPath(rootDirectory, event.sessionId, 1),
        sessionId: event.sessionId,
        size: 0,
      }
      const segment = current.size > 0 && current.size + byteLength > maxSegmentBytes
        ? {
            events: [],
            index: current.index + 1,
            path: segmentPath(rootDirectory, event.sessionId, current.index + 1),
            sessionId: event.sessionId,
            size: 0,
          }
        : current
      if (segment !== current || sessionSegments.length === 0) {
        sessionSegments.push(segment)
        segments.set(event.sessionId, sessionSegments)
      }

      const lastWrite = pendingWrites.at(-1)
      if (lastWrite?.path === segment.path)
        lastWrite.data += line
      else
        pendingWrites.push({ data: line, path: segment.path })

      segment.events.push(snapshot)
      segment.size += byteLength
    },
    compact,
    flush,
    load: () => loadAllEvents(checkpointEvents, segments),
  }
}

function archivePath(rootDirectory: string, segment: EventSegment): string {
  return join(
    rootDirectory,
    'archive',
    encodeSessionId(segment.sessionId),
    `${String(segment.index).padStart(8, '0')}.jsonl.gz`,
  )
}

async function archiveSegment(rootDirectory: string, segment: EventSegment) {
  const destination = archivePath(rootDirectory, segment)
  const archiveDirectory = dirname(destination)
  const temporary = `${destination}.tmp`
  assertOwnedPath(rootDirectory, segment.path)
  assertOwnedPath(rootDirectory, destination)
  assertOwnedPath(rootDirectory, temporary)
  mkdirSync(archiveDirectory, { recursive: true })

  if (!existsSync(destination)) {
    await unlinkIfPresent(temporary)
    await pipeline(
      createReadStream(segment.path),
      createGzip(),
      createWriteStream(temporary, { flags: 'wx' }),
    )
    // Windows requires a writable file descriptor for fsync even though the
    // archive bytes are already complete, so reopen with read/write access.
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    }
    finally {
      await handle.close()
    }
    await rename(temporary, destination)
  }

  // The compressed final path is published before the hot source is removed.
  // A crash between these operations causes a harmless overlap that startup
  // deduplicates by the immutable session sequence.
  await unlink(segment.path)
}

function assertOwnedPath(rootDirectory: string, targetPath: string) {
  const relativePath = relative(resolve(rootDirectory), resolve(targetPath))
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    throw new Error(`Refusing Agent event file operation outside repository: ${targetPath}`)
}

function checkpointPath(rootDirectory: string, sessionId: string): string {
  return join(rootDirectory, `${encodeSessionId(sessionId)}--compacted.jsonl`)
}

function deduplicateEvents(events: readonly AgentSessionEvent[]): AgentSessionEvent[] {
  const bySequence = new Map<number, AgentSessionEvent>()
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const existing = bySequence.get(event.sequence)
    if (existing && JSON.stringify(existing) !== JSON.stringify(event))
      throw new Error(`Agent event sequence ${event.sequence} has conflicting durable facts`)
    bySequence.set(event.sequence, structuredClone(event))
  }
  return [...bySequence.values()]
}

function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadAllEvents(
  checkpointEvents: Map<string, AgentSessionEvent[]>,
  segments: Map<string, EventSegment[]>,
): AgentSessionEvent[] {
  const sessionIds = new Set([...checkpointEvents.keys(), ...segments.keys()])
  return [...sessionIds]
    .sort((left, right) => left.localeCompare(right))
    .flatMap(sessionId => loadSessionEvents(sessionId, checkpointEvents, segments))
}

function loadArchivedReplayAdmissions(
  rootDirectory: string,
  sessionId: string,
  dependencies: ReadonlyMap<string, ReplayDependency>,
): AgentSessionEvent[] {
  const unresolved = new Map(dependencies)
  const recovered: AgentSessionEvent[] = []
  const encodedSession = encodeSessionId(sessionId)
  const archiveDirectory = join(rootDirectory, 'archive', encodedSession)
  if (!existsSync(archiveDirectory))
    throw new Error(`Agent session ${sessionId} is missing replay admissions and has no cold archive`)

  const archives = readdirSync(archiveDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{8}\.jsonl\.gz$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left))
  for (const name of archives) {
    const path = join(archiveDirectory, name)
    assertOwnedPath(rootDirectory, path)
    // Cold segments are read one at a time and only when an older compactor
    // left a replay transition without its causal admission in the hot log.
    const buffer = gunzipSync(readFileSync(path))
    const rawLines = buffer.toString('utf8').split('\n').filter(Boolean)
    const events = rawLines.flatMap(line => parseEventLine(line) ?? [])
    const archiveSessionId = validateSegmentEvents(name, encodedSession, events)
    if (archiveSessionId !== undefined && archiveSessionId !== sessionId)
      throw new Error(`Agent event archive ${name} does not match session ${sessionId}`)

    for (const event of events.toReversed()) {
      const key = replayAdmissionKey(event)
      if (!key)
        continue
      const dependency = unresolved.get(key)
      if (!dependency || event.sequence >= dependency.beforeSequence)
        continue
      recovered.push(event)
      unresolved.delete(key)
    }
    if (unresolved.size === 0)
      break
  }

  if (unresolved.size > 0)
    throw new Error(`Agent session ${sessionId} has ${unresolved.size} replay admissions missing from hot and cold storage`)
  return recovered
}

function loadCheckpointFiles(rootDirectory: string, checkpointEvents: Map<string, AgentSessionEvent[]>) {
  const checkpoints = readdirSync(rootDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && parseCheckpointName(entry.name) !== undefined)
  for (const checkpoint of checkpoints) {
    const encodedSession = parseCheckpointName(checkpoint.name)
    if (!encodedSession)
      throw new Error(`Invalid Agent event checkpoint name: ${checkpoint.name}`)
    const buffer = readFileSync(join(rootDirectory, checkpoint.name))
    const rawLines = buffer.toString('utf8').split('\n').filter(Boolean)
    const events = rawLines.flatMap(line => parseEventLine(line) ?? [])
    const sessionId = validateSegmentEvents(checkpoint.name, encodedSession, events)
    if (sessionId)
      checkpointEvents.set(sessionId, deduplicateEvents(events))
  }
}

function loadRepositoryState(
  rootDirectory: string,
  checkpointEvents: Map<string, AgentSessionEvent[]>,
  segments: Map<string, EventSegment[]>,
) {
  loadCheckpointFiles(rootDirectory, checkpointEvents)
  const files = readdirSync(rootDirectory, { withFileTypes: true })
    .filter(entry => entry.isFile() && parseSegmentName(entry.name) !== undefined)
    .map((entry) => {
      const parsed = parseSegmentName(entry.name)
      if (!parsed)
        throw new Error(`Invalid Agent event segment name: ${entry.name}`)
      return { ...parsed, name: entry.name }
    })
    .sort((left, right) => left.encodedSession.localeCompare(right.encodedSession) || left.index - right.index)

  for (const file of files) {
    const path = join(rootDirectory, file.name)
    const buffer = readCompleteSegment(path)
    const rawLines = buffer.toString('utf8').split('\n').filter(Boolean)
    const events = rawLines.flatMap(line => parseEventLine(line) ?? [])
    const sessionId = validateSegmentEvents(file.name, file.encodedSession, events)
    if (!sessionId)
      continue
    const sessionSegments = segments.get(sessionId) ?? []
    sessionSegments.push({
      events,
      index: file.index,
      path,
      sessionId,
      size: buffer.byteLength,
    })
    segments.set(sessionId, sessionSegments)
  }

  // A crash after publishing a compact checkpoint but before deleting its hot
  // segment temporarily leaves duplicate sequences. Conflicting duplicates are
  // rejected, while identical overlap is safe and removed from resident replay.
  for (const sessionId of new Set([...checkpointEvents.keys(), ...segments.keys()]))
    loadSessionEvents(sessionId, checkpointEvents, segments)
}

function loadSessionEvents(
  sessionId: string,
  checkpointEvents: Map<string, AgentSessionEvent[]>,
  segments: Map<string, EventSegment[]>,
): AgentSessionEvent[] {
  return deduplicateEvents([
    ...(checkpointEvents.get(sessionId) ?? []),
    ...(segments.get(sessionId) ?? []).flatMap(segment => segment.events),
  ])
}

function migrateLegacySnapshot(
  rootDirectory: string,
  maxSegmentBytes: number,
  legacyStore: LegacyAgentSessionEventStore,
) {
  const hasSegments = readdirSync(rootDirectory, { withFileTypes: true })
    .some(entry => entry.isFile() && parseSegmentName(entry.name) !== undefined)
  if (hasSegments)
    return

  legacyStore.setup()
  const sessions = legacyStore.get()?.sessions ?? {}
  for (const [sessionId, sessionEvents] of Object.entries(sessions)) {
    let segment: ActiveSegment = { index: 1, size: 0 }
    for (const event of sessionEvents) {
      const line = `${JSON.stringify(event)}\n`
      const byteLength = Buffer.byteLength(line)
      if (segment.size > 0 && segment.size + byteLength > maxSegmentBytes)
        segment = { index: segment.index + 1, size: 0 }
      writeFileSync(segmentPath(rootDirectory, sessionId, segment.index), line, { flag: 'a' })
      segment.size += byteLength
    }
  }
}

function missingReplayDependencies(events: readonly AgentSessionEvent[]): Map<string, ReplayDependency> {
  const admissions = new Set<string>()
  const missing = new Map<string, ReplayDependency>()
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const dependencyKey = replayDependencyKey(event)
    if (dependencyKey && !admissions.has(dependencyKey) && !missing.has(dependencyKey)) {
      missing.set(dependencyKey, {
        beforeSequence: event.sequence,
        key: dependencyKey,
      })
    }

    const admissionKey = replayAdmissionKey(event)
    if (admissionKey)
      admissions.add(admissionKey)
  }
  return missing
}

function parseCheckpointName(name: string): string | undefined {
  return /^([\w-]+)--compacted\.jsonl$/.exec(name)?.[1]
}

/**
 * Parses one JSONL event record, dropping events from subsystems that later
 * refactors removed from the durable contract.
 *
 * Files written by older builds may retain retired event types (for example
 * `task.changed` from the autonomy runtime removed by the de-experimentalized
 * fork). Those orphans have no consumers and never appear in replay dependency
 * keys, so dropping them keeps the surviving monotonic sequence safe for
 * replay and compaction. Records of known types that fail payload validation
 * are still fatal.
 */
function parseEventLine(rawLine: string): AgentSessionEvent | undefined {
  const value: unknown = JSON.parse(rawLine)
  const type = isRecord(value) ? value.type : undefined
  if (!isKnownAgentSessionEventType(type)) {
    console.warn(`Dropped an Agent session event of retired type ${JSON.stringify(type)}`)
    return undefined
  }
  return parseAgentSessionEvents([value])[0]
}

function parseSegmentName(name: string): undefined | { encodedSession: string, index: number } {
  const match = /^([\w-]+)--(\d{8})\.jsonl$/.exec(name)
  if (!match)
    return undefined
  return { encodedSession: match[1], index: Number(match[2]) }
}

function readCompleteSegment(path: string): Buffer {
  const buffer = readFileSync(path)
  if (buffer.length === 0 || buffer.at(-1) === 0x0A)
    return buffer

  const lastNewline = buffer.lastIndexOf(0x0A)
  const completeLength = lastNewline < 0 ? 0 : lastNewline + 1
  // NOTICE:
  // A process or machine crash can stop an append between JSON bytes.
  // JSONL makes only the final unterminated record ambiguous; earlier lines
  // were already synced by a completed durability barrier.
  // Source/context: Node.js `fsPromises` operations are not synchronized and
  // `FileHandle.sync()` is the explicit storage flush boundary.
  // Removal condition: when records gain checksummed frames with independent
  // recovery of partial writes.
  truncateSync(path, completeLength)
  console.warn(`Discarded an incomplete Agent event tail from ${path}`)
  return buffer.subarray(0, completeLength)
}

function repairReplayDependenciesFromArchives(
  rootDirectory: string,
  checkpointEvents: Map<string, AgentSessionEvent[]>,
  segments: Map<string, EventSegment[]>,
): Set<string> {
  const repairedSessions = new Set<string>()
  const sessionIds = new Set([...checkpointEvents.keys(), ...segments.keys()])
  for (const sessionId of sessionIds) {
    const residentEvents = loadSessionEvents(sessionId, checkpointEvents, segments)
    const missing = missingReplayDependencies(residentEvents)
    if (missing.size === 0)
      continue

    const recovered = loadArchivedReplayAdmissions(rootDirectory, sessionId, missing)
    const nextCheckpoint = deduplicateEvents([
      ...(checkpointEvents.get(sessionId) ?? []),
      ...recovered,
    ])
    const repairedEvents = deduplicateEvents([
      ...nextCheckpoint,
      ...(segments.get(sessionId) ?? []).flatMap(segment => segment.events),
    ])
    const unresolved = missingReplayDependencies(repairedEvents)
    if (unresolved.size > 0)
      throw new Error(`Agent session ${sessionId} still has ${unresolved.size} invalid replay dependencies after archive repair`)

    checkpointEvents.set(sessionId, nextCheckpoint)
    repairedSessions.add(sessionId)
    console.warn(`Recovered ${recovered.length} Agent replay admissions from cold archive for session ${sessionId}`)
  }
  return repairedSessions
}

async function replaceCheckpoint(
  rootDirectory: string,
  sessionId: string,
  events: readonly AgentSessionEvent[],
) {
  const destination = checkpointPath(rootDirectory, sessionId)
  const temporary = `${destination}.tmp`
  assertOwnedPath(rootDirectory, destination)
  assertOwnedPath(rootDirectory, temporary)
  await unlinkIfPresent(temporary)

  const handle = await open(temporary, 'wx')
  try {
    const contents = events.map(event => `${JSON.stringify(event)}\n`).join('')
    await handle.writeFile(contents, { encoding: 'utf8' })
    await handle.sync()
  }
  finally {
    await handle.close()
  }
  await rename(temporary, destination)
}

function replayAdmissionKey(event: AgentSessionEvent): string | undefined {
  if (event.type === 'tool.call-started')
    return `tool\u0000${event.payload.turnId}\u0000${event.payload.callId}`
  if (event.type === 'turn.admitted')
    return `turn\u0000${event.payload.turnId}`
  return undefined
}

function replayDependencyKey(event: AgentSessionEvent): string | undefined {
  if (event.type === 'tool.call-reconciled' || event.type === 'tool.call-settled')
    return `tool\u0000${event.payload.turnId}\u0000${event.payload.callId}`
  switch (event.type) {
    case 'turn.cancellation-requested':
    case 'turn.closed':
    case 'turn.interrupted':
    case 'turn.recovery-acknowledged':
      return `turn\u0000${event.payload.turnId}`
    case 'turn.checkpointed':
      return `turn\u0000${event.payload.checkpoint.turnId}`
    default:
      return undefined
  }
}

function retainReplayDependencies(
  checkpoint: readonly AgentSessionEvent[],
  remainingSegmentEvents: readonly AgentSessionEvent[],
  source: readonly AgentSessionEvent[],
): AgentSessionEvent[] {
  const missing = missingReplayDependencies(deduplicateEvents([
    ...checkpoint,
    ...remainingSegmentEvents,
  ]))
  if (missing.size === 0)
    return deduplicateEvents(checkpoint)

  const prerequisites: AgentSessionEvent[] = []
  for (const dependency of missing.values()) {
    const prerequisite = source.findLast(event => (
      event.sequence < dependency.beforeSequence
      && replayAdmissionKey(event) === dependency.key
    ))
    if (!prerequisite)
      throw new Error(`Agent hot replay is missing causal admission ${dependency.key}`)
    prerequisites.push(prerequisite)
  }

  const nextCheckpoint = deduplicateEvents([...checkpoint, ...prerequisites])
  const unresolved = missingReplayDependencies(deduplicateEvents([
    ...nextCheckpoint,
    ...remainingSegmentEvents,
  ]))
  if (unresolved.size > 0)
    throw new Error(`Agent hot replay still has ${unresolved.size} invalid causal dependencies`)
  return nextCheckpoint
}

function segmentPath(rootDirectory: string, sessionId: string, index: number): string {
  return join(rootDirectory, `${encodeSessionId(sessionId)}--${String(index).padStart(8, '0')}.jsonl`)
}

async function unlinkIfPresent(path: string) {
  try {
    await unlink(path)
  }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
      throw error
  }
}

function validateSegmentEvents(
  name: string,
  encodedSession: string,
  events: readonly AgentSessionEvent[],
): string | undefined {
  let sessionId: string | undefined
  let previousSequence = 0
  for (const event of events) {
    sessionId ??= event.sessionId
    if (event.sessionId !== sessionId)
      throw new Error(`Agent event file ${name} mixes multiple sessions`)
    if (encodeSessionId(event.sessionId) !== encodedSession)
      throw new Error(`Agent event file ${name} does not match its session owner`)
    if (event.sequence <= previousSequence)
      throw new Error(`Agent event sequence ${event.sequence} is not monotonic in ${name}`)
    previousSequence = event.sequence
  }
  return sessionId
}

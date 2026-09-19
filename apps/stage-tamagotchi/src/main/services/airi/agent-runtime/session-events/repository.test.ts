import type { AgentSessionEvent } from '@proj-airi/core-agent'

import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentSessionEventRepository } from './repository'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    const resolved = resolve(directory)
    if (!resolved.startsWith(resolve(tmpdir())))
      throw new Error(`Refusing to remove unexpected test directory: ${resolved}`)
    rmSync(resolved, { force: true, recursive: true })
  }
})

describe('agent session event repository', () => {
  it('migrates the legacy snapshot and appends without rewriting old records', async () => {
    const rootDirectory = createTemporaryDirectory()
    const first = event({ occurredAt: 90, sequence: 1, sessionId: 'session-a', turnId: 'turn-a' })
    const legacyStore = {
      get: vi.fn(() => ({ sessions: { 'session-a': [first] } })),
      setup: vi.fn(),
    }
    const repository = createAgentSessionEventRepository({ legacyStore, rootDirectory })
    const second = event({ occurredAt: 100, sequence: 2, sessionId: 'session-a', turnId: 'turn-b' })

    expect(repository.load()).toEqual([first])
    repository.append(second)
    await repository.flush()

    const segmentPath = join(rootDirectory, readdirSync(rootDirectory)[0])
    const lines = readFileSync(segmentPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toEqual([first, second])
    expect(repository.load()).toEqual([first, second])
    expect(legacyStore.setup).toHaveBeenCalledOnce()
  })

  it('rolls a session into bounded segments while preserving replay order', async () => {
    const rootDirectory = createTemporaryDirectory()
    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      maxSegmentBytes: 1,
      rootDirectory,
    })
    const first = event({ occurredAt: 90, sequence: 1, sessionId: 'session-a', turnId: 'turn-a' })
    const second = event({ occurredAt: 100, sequence: 2, sessionId: 'session-a', turnId: 'turn-b' })

    repository.append(first)
    repository.append(second)
    await repository.flush()

    expect(readdirSync(rootDirectory)).toHaveLength(2)
    const reloaded = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      maxSegmentBytes: 1,
      rootDirectory,
    })
    expect(reloaded.load()).toEqual([first, second])
  })

  it('archives consumed segments while retaining a bounded hot replay checkpoint', async () => {
    const rootDirectory = createTemporaryDirectory()
    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      maxSegmentBytes: 1,
      rootDirectory,
    })
    const first = event({ occurredAt: 90, sequence: 1, sessionId: 'session-a', turnId: 'turn-a' })
    const second = event({ occurredAt: 100, sequence: 2, sessionId: 'session-a', turnId: 'turn-b' })
    const third = event({ occurredAt: 110, sequence: 3, sessionId: 'session-a', turnId: 'turn-c' })
    repository.append(first)
    repository.append(second)
    repository.append(third)
    await repository.flush()

    await expect(repository.compact({
      retainedSequences: [1],
      sessionId: 'session-a',
      throughSequence: 2,
    })).resolves.toEqual([first, third])

    const archiveRoot = join(rootDirectory, 'archive')
    const archiveOwner = readdirSync(archiveRoot)[0]
    if (!archiveOwner)
      throw new Error('Expected a session archive owner')
    const coldEvents = readdirSync(join(archiveRoot, archiveOwner))
      .sort()
      .flatMap((name) => {
        const contents = gunzipSync(readFileSync(join(archiveRoot, archiveOwner, name))).toString('utf8')
        return contents.trim().split('\n').map(line => JSON.parse(line))
      })
    expect(coldEvents).toEqual([first, second])

    await expect(repository.compact({
      retainedSequences: [1],
      sessionId: 'session-a',
      throughSequence: 2,
    })).resolves.toEqual([first, third])

    const reloaded = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      maxSegmentBytes: 1,
      rootDirectory,
    })
    expect(reloaded.load()).toEqual([first, third])

    const fourth = event({ occurredAt: 120, sequence: 4, sessionId: 'session-a', turnId: 'turn-d' })
    reloaded.append(fourth)
    await reloaded.flush()
    expect(reloaded.load()).toEqual([first, third, fourth])
  })

  it('keeps a tool admission when its settlement remains in the active segment', async () => {
    // ROOT CAUSE:
    //
    // Compaction selected events only by semantic retention policy. When a
    // segment boundary fell between `tool.call-started` and its settlement,
    // the admission was archived while the active segment kept the settlement.
    // Startup replay then rejected the now-orphaned terminal transition.
    //
    // The checkpoint now closes over replay prerequisites before archiving.
    const rootDirectory = createTemporaryDirectory()
    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      maxSegmentBytes: 1,
      rootDirectory,
    })
    const started = toolCallStarted(1)
    const settled = toolCallSettled(2)
    repository.append(started)
    repository.append(settled)
    await repository.flush()

    await expect(repository.compact({
      retainedSequences: [],
      sessionId: started.sessionId,
      throughSequence: settled.sequence,
    })).resolves.toEqual([started, settled])

    const reloaded = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      maxSegmentBytes: 1,
      rootDirectory,
    })
    expect(reloaded.load()).toEqual([started, settled])
  })

  it('repairs hot turn and tool transitions whose admissions were archived by an older compactor', async () => {
    // ROOT CAUSE:
    //
    // Repositories already compacted by the old policy have no admission in
    // their hot files, so fixing future compaction alone cannot make them
    // bootable. Startup now retrieves only the missing causal anchors from
    // cold archives and persists them into the next checkpoint flush.
    const rootDirectory = createTemporaryDirectory()
    const admitted = turnAdmitted(1)
    const started = toolCallStarted(2)
    const checkpointed = turnCheckpointed(3)
    const settled = toolCallSettled(4)
    const encodedSessionId = Buffer.from(started.sessionId, 'utf8').toString('base64url')
    const archiveDirectory = join(rootDirectory, 'archive', encodedSessionId)
    mkdirSync(archiveDirectory, { recursive: true })
    writeFileSync(
      join(archiveDirectory, '00000001.jsonl.gz'),
      gzipSync(`${JSON.stringify(admitted)}\n${JSON.stringify(started)}\n`),
    )
    writeFileSync(
      join(rootDirectory, `${encodedSessionId}--00000002.jsonl`),
      `${JSON.stringify(checkpointed)}\n${JSON.stringify(settled)}\n`,
    )

    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      rootDirectory,
    })

    expect(repository.load()).toEqual([admitted, started, checkpointed, settled])
    await repository.flush()

    const checkpoint = readFileSync(
      join(rootDirectory, `${encodedSessionId}--compacted.jsonl`),
      'utf8',
    ).trim().split('\n').map(line => JSON.parse(line))
    expect(checkpoint).toEqual([admitted, started])
  })

  it('loads a segment that still contains events from a removed subsystem', async () => {
    const rootDirectory = createTemporaryDirectory()
    const first = event({ occurredAt: 90, sequence: 1, sessionId: 'session-a', turnId: 'turn-a' })
    const third = event({ occurredAt: 110, sequence: 3, sessionId: 'session-a', turnId: 'turn-c' })
    const orphan = {
      occurredAt: 100,
      payload: { task: { id: 'task-a', objective: 'cleanup', revision: 1, state: 'queued', updatedAt: 100 } },
      sequence: 2,
      sessionId: 'session-a',
      type: 'task.changed',
    }
    const encodedSessionId = Buffer.from(first.sessionId, 'utf8').toString('base64url')
    writeFileSync(
      join(rootDirectory, `${encodedSessionId}--00000001.jsonl`),
      `${JSON.stringify(first)}\n${JSON.stringify(orphan)}\n${JSON.stringify(third)}\n`,
    )

    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      rootDirectory,
    })

    expect(repository.load()).toEqual([first, third])
    const fourth = event({ occurredAt: 120, sequence: 4, sessionId: 'session-a', turnId: 'turn-d' })
    repository.append(fourth)
    await repository.flush()
    expect(repository.load()).toEqual([first, third, fourth])
  })

  it('drops orphaned events from a compacted checkpoint before rewriting it', async () => {
    const rootDirectory = createTemporaryDirectory()
    const first = event({ occurredAt: 90, sequence: 1, sessionId: 'session-a', turnId: 'turn-a' })
    const orphan = {
      occurredAt: 100,
      payload: { task: { id: 'task-a', objective: 'cleanup', revision: 1, state: 'queued', updatedAt: 100 } },
      sequence: 2,
      sessionId: 'session-a',
      type: 'task.changed',
    }
    const encodedSessionId = Buffer.from(first.sessionId, 'utf8').toString('base64url')
    writeFileSync(
      join(rootDirectory, `${encodedSessionId}--compacted.jsonl`),
      `${JSON.stringify(first)}\n${JSON.stringify(orphan)}\n`,
    )

    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      rootDirectory,
    })
    expect(repository.load()).toEqual([first])

    await repository.compact({
      retainedSequences: [1],
      sessionId: 'session-a',
      throughSequence: 1,
    })

    const checkpoint = readFileSync(
      join(rootDirectory, `${encodedSessionId}--compacted.jsonl`),
      'utf8',
    ).trim().split('\n').map(line => JSON.parse(line))
    expect(checkpoint).toEqual([first])
  })
})

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'airi-agent-events-'))
  temporaryDirectories.push(directory)
  return directory
}

function event(input: {
  occurredAt: number
  sequence: number
  sessionId: string
  turnId: string
}): AgentSessionEvent {
  return {
    occurredAt: input.occurredAt,
    payload: { source: 'text', turnId: input.turnId },
    sequence: input.sequence,
    sessionId: input.sessionId,
    type: 'turn.started',
  }
}

function toolCallSettled(sequence: number): AgentSessionEvent {
  return {
    occurredAt: 100,
    payload: {
      callId: 'call-a',
      durationMs: 10,
      output: { ok: true },
      status: 'completed',
      toolName: 'read-file',
      turnId: 'turn-a',
    },
    sequence,
    sessionId: 'session-a',
    type: 'tool.call-settled',
  }
}

function toolCallStarted(sequence: number): AgentSessionEvent {
  return {
    occurredAt: 90,
    payload: {
      callId: 'call-a',
      input: { path: 'notes.txt' },
      toolName: 'read-file',
      turnId: 'turn-a',
    },
    sequence,
    sessionId: 'session-a',
    type: 'tool.call-started',
  }
}

function turnAdmitted(sequence: number): AgentSessionEvent {
  return {
    occurredAt: 80,
    payload: {
      assistantMessageId: 'assistant-a',
      ownerId: 'renderer-a',
      sessionId: 'session-a',
      source: 'text',
      turnId: 'turn-a',
      userMessage: {
        content: 'hello',
        id: 'user-a',
        role: 'user',
      },
      userMessageId: 'user-a',
      userText: 'hello',
    },
    sequence,
    sessionId: 'session-a',
    type: 'turn.admitted',
  }
}

function turnCheckpointed(sequence: number): AgentSessionEvent {
  return {
    occurredAt: 95,
    payload: {
      checkpoint: {
        assistantMessageId: 'assistant-a',
        assistantText: 'partial',
        revision: 1,
        sessionId: 'session-a',
        turnId: 'turn-a',
      },
    },
    sequence,
    sessionId: 'session-a',
    type: 'turn.checkpointed',
  }
}

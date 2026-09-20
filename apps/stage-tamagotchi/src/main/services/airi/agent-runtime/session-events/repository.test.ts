import type { AgentSessionEvent } from '@proj-airi/core-agent'

import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAgentSessionEventRepository } from './repository'

/**
 * Authored message of a retired self-prompt turn.
 *
 * The self-prompt loop is gone, but its messages are already part of the
 * session's visible history, so only the turn chain around them is retired.
 */
const selfPromptMessage = {
  occurredAt: 101,
  payload: {
    message: { content: 'review the failing test', id: 'user-self', role: 'user' },
    messageId: 'user-self',
    role: 'user',
    status: 'complete',
    turnId: 'turn-self',
  },
  sequence: 3,
  sessionId: 'session-a',
  type: 'message.appended',
} as const

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

  it('retires the turn chain of a persisted self-prompt admission', async () => {
    // ROOT CAUSE:
    //
    // The self-prompt loop removed by c5eacfba4 wrote `turn.admitted` with
    // `source: 'self'`. 194d21245 then removed that origin from the durable
    // contract, so loading a log that still contains such an admission threw a
    // ValiError during repository bootstrap and the desktop app could not start.
    //
    // Retiring only the admission is not enough: `turn.checkpointed`,
    // `turn.closed` and tool settlements resolve against their admission in the
    // replay dependency checks and in turn-runner projection, so every record
    // that carries the retired turn id has to be retired with it. Authored
    // `message.appended` records survive because they are the visible
    // conversation history and take part in no turn dependency.
    const rootDirectory = createTemporaryDirectory()
    const before = event({ occurredAt: 90, sequence: 1, sessionId: 'session-a', turnId: 'turn-a' })
    const selfPrompts = selfTurnRecords(2)
    const after = event({ occurredAt: 200, sequence: 8, sessionId: 'session-a', turnId: 'turn-c' })
    const encodedSessionId = Buffer.from(before.sessionId, 'utf8').toString('base64url')
    writeFileSync(
      join(rootDirectory, `${encodedSessionId}--00000001.jsonl`),
      [...[before], ...selfPrompts, after].map(record => `${JSON.stringify(record)}\n`).join(''),
    )

    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      rootDirectory,
    })

    expect(repository.load()).toEqual([before, selfPromptMessage, after])
    const appended = event({ occurredAt: 210, sequence: 9, sessionId: 'session-a', turnId: 'turn-d' })
    repository.append(appended)
    await repository.flush()
    expect(repository.load()).toEqual([before, selfPromptMessage, after, appended])
  })

  it('retires a persisted turn.started carrying the removed self origin', async () => {
    const rootDirectory = createTemporaryDirectory()
    const before = event({ occurredAt: 90, sequence: 1, sessionId: 'session-a', turnId: 'turn-a' })
    const retiredStart = {
      occurredAt: 100,
      payload: { source: 'self', turnId: 'turn-self' },
      sequence: 2,
      sessionId: 'session-a',
      type: 'turn.started',
    }
    const after = event({ occurredAt: 110, sequence: 3, sessionId: 'session-a', turnId: 'turn-c' })
    const encodedSessionId = Buffer.from(before.sessionId, 'utf8').toString('base64url')
    writeFileSync(
      join(rootDirectory, `${encodedSessionId}--00000001.jsonl`),
      [before, retiredStart, after].map(record => `${JSON.stringify(record)}\n`).join(''),
    )

    const repository = createAgentSessionEventRepository({
      legacyStore: { get: () => ({ sessions: {} }), setup: vi.fn() },
      rootDirectory,
    })

    expect(repository.load()).toEqual([before, after])
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

/**
 * Turn records exactly as the removed self-prompt loop persisted them.
 *
 * `source: 'self'` is no longer expressible by the durable contract, which is
 * why these are untyped literals rather than `AgentSessionEvent` values.
 */
function selfTurnRecords(firstSequence: number): unknown[] {
  const turnId = 'turn-self'
  return [
    {
      occurredAt: 100,
      payload: {
        assistantMessageId: 'assistant-self',
        ownerId: 'renderer-a',
        sessionId: 'session-a',
        source: 'self',
        turnId,
        userMessage: { content: 'review the failing test', id: 'user-self', role: 'user' },
        userMessageId: 'user-self',
        userText: 'review the failing test',
      },
      sequence: firstSequence,
      sessionId: 'session-a',
      type: 'turn.admitted',
    },
    selfPromptMessage,
    {
      occurredAt: 102,
      payload: {
        checkpoint: {
          assistantMessageId: 'assistant-self',
          assistantText: 'partial',
          revision: 1,
          sessionId: 'session-a',
          turnId,
        },
      },
      sequence: firstSequence + 2,
      sessionId: 'session-a',
      type: 'turn.checkpointed',
    },
    {
      occurredAt: 103,
      payload: { reason: 'host-restarted', turnId },
      sequence: firstSequence + 3,
      sessionId: 'session-a',
      type: 'turn.interrupted',
    },
    {
      occurredAt: 104,
      payload: { callId: 'call-self', input: { path: 'notes.txt' }, toolName: 'read-file', turnId },
      sequence: firstSequence + 4,
      sessionId: 'session-a',
      type: 'tool.call-started',
    },
    {
      occurredAt: 105,
      payload: { callId: 'call-self', durationMs: 10, output: { ok: true }, status: 'completed', toolName: 'read-file', turnId },
      sequence: firstSequence + 5,
      sessionId: 'session-a',
      type: 'tool.call-settled',
    },
  ]
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

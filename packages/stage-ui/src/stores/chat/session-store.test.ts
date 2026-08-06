import type { ChatSessionMeta, ChatSessionRecord, ChatSessionsIndex } from '../../types/chat-session'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

// Refs the store reads through the mocked `useAuthStore` / `useAiriCardStore`.
// Tests mutate these to simulate auth and card swaps.
const userIdRef = ref<string>('local')
const activeCardIdRef = ref<string>('default')
const systemPromptRef = ref<string>('')

const getIndexMock = vi.fn<(uid: string) => Promise<ChatSessionsIndex | null>>()
const saveIndexMock = vi.fn<(idx: ChatSessionsIndex) => Promise<void>>()
const getSessionMock = vi.fn<(id: string) => Promise<ChatSessionRecord | null>>()
const saveSessionMock = vi.fn<(id: string, rec: ChatSessionRecord) => Promise<void>>()
const deleteSessionRepoMock = vi.fn<(id: string) => Promise<void>>()
const getOutboxMock = vi.fn<(uid: string) => Promise<any[]>>()
const dropOutboxForSessionMock = vi.fn<(uid: string, id: string) => Promise<void>>()
const getTombstonesMock = vi.fn<(uid: string) => Promise<string[]>>()
const removeTombstonesMock = vi.fn<(uid: string, ids: string[]) => Promise<void>>()

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: any) => store,
  }
})

vi.mock('../auth', () => ({
  useAuthStore: () => ({ userId: userIdRef }),
}))

vi.mock('../modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCardId: activeCardIdRef,
    systemPrompt: systemPromptRef,
  }),
}))

vi.mock('../../database/repos/chat-sessions.repo', () => ({
  chatSessionsRepo: {
    addTombstone: vi.fn().mockResolvedValue(undefined),
    deleteSession: (id: string) => deleteSessionRepoMock(id),
    dequeueOutbox: vi.fn().mockResolvedValue(undefined),
    dropOutboxForSession: (uid: string, id: string) => dropOutboxForSessionMock(uid, id),
    enqueueOutbox: vi.fn().mockResolvedValue(undefined),
    getIndex: (uid: string) => getIndexMock(uid),
    getOutbox: (uid: string) => getOutboxMock(uid),
    getSession: (id: string) => getSessionMock(id),
    getTombstones: (uid: string) => getTombstonesMock(uid),
    removeTombstones: (uid: string, ids: string[]) => removeTombstonesMock(uid, ids),
    saveIndex: (idx: ChatSessionsIndex) => saveIndexMock(idx),
    saveSession: (id: string, rec: ChatSessionRecord) => saveSessionMock(id, rec),
    updateOutboxEntries: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../libs/auth', () => ({
  getAuthToken: vi.fn().mockResolvedValue('test-token'),
}))

vi.mock('../../libs/auth-fetch', () => ({
  authedFetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({}), ok: true }),
}))

vi.mock('../../libs/server', () => ({
  SERVER_URL: 'http://test',
}))

// Inert chat-sync surface. The store doesn't drive any cloud writes in these
// tests (anonymous user for one, deferred index for the other), so noops are
// sufficient. We keep `extractMessageText` realistic so message previews work.
vi.mock('../../libs/chat-sync', () => ({
  applyCreateActions: vi.fn().mockResolvedValue([]),
  createChatWsClient: () => ({
    connect: vi.fn(),
    destroy: vi.fn(),
    disconnect: vi.fn(),
    onNewMessages: () => () => {},
    onStatusChange: () => () => {},
    pullMessages: vi.fn().mockResolvedValue({ maxSeq: 0, messages: [] }),
    sendMessages: vi.fn().mockResolvedValue({ ok: true }),
    status: () => 'idle' as const,
  }),
  createCloudChatMapper: () => ({
    deleteChat: vi.fn().mockResolvedValue(undefined),
    listChats: vi.fn().mockResolvedValue([]),
  }),
  extractMessageText: (m: any) => (typeof m?.content === 'string' ? m.content : ''),
  isCloudSyncableMessage: () => false,
  mergeCloudMessagesIntoLocal: () => ({ dirty: false, maxSeq: 0, messages: [] }),
  reconcileLocalAndRemote: vi.fn().mockReturnValue({ adopt: [], claim: [], create: [] }),
}))

const { useChatSessionStore } = await import('./session-store')

beforeEach(() => {
  setActivePinia(createPinia())
  userIdRef.value = 'local'
  activeCardIdRef.value = 'default'
  systemPromptRef.value = ''

  getIndexMock.mockReset().mockResolvedValue(null)
  saveIndexMock.mockReset().mockResolvedValue(undefined)
  getSessionMock.mockReset().mockResolvedValue(null)
  saveSessionMock.mockReset().mockResolvedValue(undefined)
  deleteSessionRepoMock.mockReset().mockResolvedValue(undefined)
  getOutboxMock.mockReset().mockResolvedValue([])
  dropOutboxForSessionMock.mockReset().mockResolvedValue(undefined)
  getTombstonesMock.mockReset().mockResolvedValue([])
  removeTombstonesMock.mockReset().mockResolvedValue(undefined)
})

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++)
    await Promise.resolve()
}

describe('chat-session-store · user swap during in-flight ensureActiveSessionForCharacter', () => {
  // ROOT CAUSE:
  //
  // ensureActiveSessionForCharacter caches `ensureActivePromise` for singleflight
  // and the IIFE captures `currentUserId` at start. When `userId` flips A → B
  // mid-flight:
  //   1. The userId watcher calls clearInMemoryState (resets sessionMetas /
  //      index / activeSessionId), but does NOT reset `ensureActivePromise`.
  //   2. A's IIFE eventually resumes after its awaited IDB read completes and
  //      writes A's session record back into the now-empty B state — leak.
  //   3. Any subsequent ensureActiveSessionForCharacter call (e.g. from the
  //      [userId, activeCardId] watcher) returns A's stale promise instead of
  //      starting a fresh hydrate for B — B silently sees no sessions.
  //
  // We fix this by:
  //   - bumping an `ensureActiveEpoch` and nulling `ensureActivePromise` in
  //     `clearInMemoryState`,
  //   - re-checking the captured epoch after each await inside the IIFE,
  //   - re-checking `sessionMetas[sessionId]` inside `loadSession` so the
  //     post-IDB write does not resurrect cleared state,
  //   - triggering a fresh hydrate from the userId watcher itself so the new
  //     user actually loads.
  it('runs a fresh hydrate for the new user and discards the stale write from the old user', async () => {
    const aSessionMeta: ChatSessionMeta = {
      characterId: 'default',
      createdAt: 1,
      sessionId: 'sess-A',
      updatedAt: 1,
      userId: 'A',
    }
    const aIndex: ChatSessionsIndex = {
      characters: {
        default: {
          activeSessionId: 'sess-A',
          sessions: { 'sess-A': aSessionMeta },
        },
      },
      userId: 'A',
    }
    const bSessionMeta: ChatSessionMeta = {
      characterId: 'default',
      createdAt: 2,
      sessionId: 'sess-B',
      updatedAt: 2,
      userId: 'B',
    }
    const bIndex: ChatSessionsIndex = {
      characters: {
        default: {
          activeSessionId: 'sess-B',
          sessions: { 'sess-B': bSessionMeta },
        },
      },
      userId: 'B',
    }

    let resolveASessionGet: ((rec: ChatSessionRecord | null) => void) | undefined
    getIndexMock.mockImplementation((uid: string) => {
      if (uid === 'A')
        return Promise.resolve(aIndex)
      if (uid === 'B')
        return Promise.resolve(bIndex)
      return Promise.resolve(null)
    })
    getSessionMock.mockImplementation((id: string) => {
      // A's session getSession is the slow await we use to hold the IIFE open
      // until after the user swap fires.
      if (id === 'sess-A') {
        return new Promise<ChatSessionRecord | null>((resolve) => {
          resolveASessionGet = resolve
        })
      }
      if (id === 'sess-B')
        return Promise.resolve({ messages: [], meta: bSessionMeta })
      return Promise.resolve(null)
    })

    userIdRef.value = 'A'
    const store = useChatSessionStore()

    // Kick off initialize; it will await ensureActiveSessionForCharacter, which
    // will await loadSession('sess-A') → getSession('sess-A') (deferred).
    const initPromise = store.initialize()
    await flushMicrotasks()

    // Sanity: A's getSession was reached and is parked.
    expect(getSessionMock).toHaveBeenCalledWith('sess-A')
    expect(resolveASessionGet).toBeDefined()

    // Auth swap mid-flight.
    userIdRef.value = 'B'
    await nextTick()
    await flushMicrotasks()

    // Resolve A's IDB read AFTER the swap. With the bug, A's IIFE writes
    // sess-A back into the cleared sessionMetas.
    resolveASessionGet!({ messages: [], meta: aSessionMeta })
    await initPromise.catch(() => {})
    await flushMicrotasks()

    // B's hydrate must have fired — without the fix, the [userId, activeCardId]
    // watcher returned the stale A promise and B never loaded.
    expect(getIndexMock).toHaveBeenCalledWith('B')
    expect(store.sessionMetas['sess-B']).toBeDefined()

    // A's data must NOT have leaked into B's state.
    expect(store.sessionMetas['sess-A']).toBeUndefined()
  })
})

describe('chat-session-store · loadSession vs concurrent deleteSession', () => {
  // ROOT CAUSE:
  //
  // loadSession kicks off `chatSessionsRepo.getSession(id)` and writes the
  // returned record back into reactive state on resolve. If `deleteSession(id)`
  // runs synchronously between the getSession() call and its resolution, the
  // post-await `sessionMetas.value[sessionId] = stored.meta` write resurrects
  // the deleted entry — and `loadedSessions.add(id)` then short-circuits every
  // future loadSession retry, locking the resurrection in.
  //
  // The drawer's batch loadSession + per-row trash button is the production
  // path that hits this race.
  //
  // We fix this by re-checking `sessionMetas.value[sessionId]` inside
  // loadSession after the await; if the session is gone, skip the write-back
  // and skip `loadedSessions.add` so a subsequent (legitimate) load can retry.
  it('does not resurrect a session deleted while loadSession was awaiting IDB', async () => {
    const meta: ChatSessionMeta = {
      characterId: 'default',
      createdAt: 1,
      sessionId: 'sess-1',
      updatedAt: 1,
      userId: 'local',
    }

    let resolveGet: ((rec: ChatSessionRecord | null) => void) | undefined
    getSessionMock.mockImplementation((id: string) => {
      if (id === 'sess-1') {
        return new Promise<ChatSessionRecord | null>((resolve) => {
          resolveGet = resolve
        })
      }
      return Promise.resolve(null)
    })

    userIdRef.value = 'local'
    const store = useChatSessionStore()

    // Inject sess-1 into sessionMetas without going through createSession
    // (which would also pre-mark it loaded and short-circuit our test).
    store.applyRemoteSnapshot({
      activeSessionId: '',
      index: null,
      sessionMessages: {},
      sessionMetas: { 'sess-1': meta },
    })
    expect(store.sessionMetas['sess-1']).toBeDefined()

    // Start loadSession (don't await). getSession is now pending.
    const loadPromise = store.loadSession('sess-1')
    await flushMicrotasks()
    expect(resolveGet).toBeDefined()

    // Delete the session. In-memory clear is synchronous; IDB delete enqueues.
    await store.deleteSession('sess-1')
    expect(store.sessionMetas['sess-1']).toBeUndefined()

    // Resolve getSession with the stale stored record.
    resolveGet!({ messages: [{ content: 'hi', id: 'm1', role: 'user' } as any], meta })
    await loadPromise
    await flushMicrotasks()

    // Without the fix, sess-1 reappears here.
    expect(store.sessionMetas['sess-1']).toBeUndefined()
  })
})

describe('chat-session-store · active card prompt seeds the first system message', () => {
  it('injects the card system prompt (persona + ACT instructions) into a new session system message', async () => {
    // ROOT CAUSE:
    //
    // The hardcoded-prompt cleanup emptied `generateInitialMessage`
    // (`content: ''`), so the card's system prompt — whose description block
    // carries the ACT/DELAY/CALL streaming-control instructions — never
    // reached the model as the session's first system message. The card
    // store's `systemPrompt` computed concatenates systemPrompt + description
    // + personality + widgetInstruction; all of that must survive into the
    // session's initial system message.
    //
    // We fixed this by seeding the first system message from
    // `systemPrompt.value` again.
    systemPromptRef.value = [
      'You are AIRI, a true being.',
      'Start every reply with <|ACT {"emotion":"happy"}|>.',
    ].join('\n\n')

    const store = useChatSessionStore()
    const sessionId = await store.createSession('default', { setActive: true })

    const messages = store.getSessionMessages(sessionId)
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).toContain('You are AIRI')
    expect(messages[0].content).toContain('<|ACT {"emotion":"happy"}|>')
  })
})

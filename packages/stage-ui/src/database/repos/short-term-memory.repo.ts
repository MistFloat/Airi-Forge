import type { DuckDBWasmDrizzleDatabase } from '@proj-airi/drizzle-duckdb-wasm'

import { sql } from 'drizzle-orm'

export interface ShortTermMemoryTurn extends Record<string, unknown> {
  assistantText: string
  /** Unix timestamp in milliseconds. */
  createdAt: number
  id: string
  sessionId: string
  userText: string
}

/**
 * Owns browser-local short-term memory persistence and per-session retention.
 * Writes and pruning happen in one transaction so concurrent turns cannot leave
 * the store above its configured limit.
 */
export function createShortTermMemoryRepo(db: DuckDBWasmDrizzleDatabase) {
  async function remember(turn: ShortTermMemoryTurn, maxItems: number): Promise<void> {
    const retentionLimit = Math.max(1, Math.trunc(maxItems))
    await db.execute(sql`
      INSERT INTO short_term_memory_turns
        (id, session_id, user_text, assistant_text, created_at)
       VALUES (${turn.id}, ${turn.sessionId}, ${turn.userText}, ${turn.assistantText}, ${turn.createdAt})
       ON CONFLICT (id) DO UPDATE SET
        user_text = excluded.user_text,
        assistant_text = excluded.assistant_text,
        created_at = excluded.created_at
    `)

    // Keep the newest N rows for this session. The correlated subquery makes
    // retention independent across conversations sharing the same database.
    await db.execute(sql`
      DELETE FROM short_term_memory_turns
       WHERE session_id = ${turn.sessionId} AND id NOT IN (
         SELECT id FROM short_term_memory_turns
         WHERE session_id = ${turn.sessionId}
         ORDER BY created_at DESC
         LIMIT ${retentionLimit}
       )
    `)
  }

  async function recall(sessionId: string, options: {
    before?: number
    limit: number
  }): Promise<ShortTermMemoryTurn[]> {
    const limit = Math.max(1, Math.trunc(options.limit))
    const recent = options.before === undefined
      ? await db.execute<ShortTermMemoryTurn>(sql`
          SELECT id, session_id AS sessionId, user_text AS userText,
             assistant_text AS assistantText, created_at AS createdAt
           FROM short_term_memory_turns
           WHERE session_id = ${sessionId}
           ORDER BY created_at DESC
           LIMIT ${limit}
        `)
      : await db.execute<ShortTermMemoryTurn>(sql`
          SELECT id, session_id AS sessionId, user_text AS userText,
             assistant_text AS assistantText, created_at AS createdAt
           FROM short_term_memory_turns
           WHERE session_id = ${sessionId} AND created_at < ${options.before}
           ORDER BY created_at DESC
           LIMIT ${limit}
        `)

    return recent.sort((left, right) => left.createdAt - right.createdAt)
  }

  async function clear(sessionId?: string): Promise<void> {
    if (sessionId) {
      await db.execute(sql`DELETE FROM short_term_memory_turns WHERE session_id = ${sessionId}`)
      return
    }

    await db.execute('DELETE FROM short_term_memory_turns')
  }

  async function count(sessionId: string): Promise<number> {
    const rows = await db.execute<{ count: number }>(sql`
      SELECT count(*)::INTEGER AS count
      FROM short_term_memory_turns
      WHERE session_id = ${sessionId}
    `)
    return rows[0]?.count ?? 0
  }

  return { clear, count, recall, remember }
}

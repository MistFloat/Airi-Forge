import type { DuckDBWasmDrizzleDatabase } from '@proj-airi/drizzle-duckdb-wasm'

import { sql } from 'drizzle-orm'

export type SelfPromptDeliveryStatus = 'discarded' | 'pending' | 'sent'

/** A durable self-prompt row and its delivery lifecycle. */
export interface SelfPromptRecord extends Record<string, unknown> {
  createdAt: number
  deliveryStatus: SelfPromptDeliveryStatus
  discardedAt?: number
  id: string
  lastError?: string
  prompt: string
  sentAt?: number
  sessionId: string
  sourceText: string
}

/** Owns the local durable boundary for generated autonomous prompts. */
export function createSelfPromptRepo(db: DuckDBWasmDrizzleDatabase) {
  async function save(record: SelfPromptRecord): Promise<void> {
    await db.execute(sql`
      INSERT INTO self_prompt_turns (
        id, session_id, prompt, source_text, delivery_status, created_at,
        sent_at, discarded_at, last_error
      ) VALUES (
        ${record.id}, ${record.sessionId}, ${record.prompt}, ${record.sourceText},
        ${record.deliveryStatus}, ${record.createdAt}, ${record.sentAt ?? null},
        ${record.discardedAt ?? null}, ${record.lastError ?? null}
      ) ON CONFLICT (id) DO NOTHING
    `)
  }

  async function markSent(id: string, sentAt: number): Promise<void> {
    await db.execute(sql`
      UPDATE self_prompt_turns
      SET delivery_status = 'sent', sent_at = ${sentAt}, last_error = NULL
      WHERE id = ${id}
    `)
  }

  async function markFailed(id: string, error: string): Promise<void> {
    await db.execute(sql`
      UPDATE self_prompt_turns
      SET delivery_status = 'pending', last_error = ${error}
      WHERE id = ${id}
    `)
  }

  async function markDiscarded(id: string, discardedAt: number): Promise<void> {
    await db.execute(sql`
      UPDATE self_prompt_turns
      SET delivery_status = 'discarded', discarded_at = ${discardedAt}
      WHERE id = ${id}
    `)
  }

  async function list(status: 'all' | SelfPromptDeliveryStatus = 'all', limit = 100): Promise<SelfPromptRecord[]> {
    const boundedLimit = Math.min(500, Math.max(1, Math.trunc(limit)))
    return await db.execute<SelfPromptRecord>(sql`
      SELECT id, session_id AS sessionId, prompt, source_text AS sourceText,
        delivery_status AS deliveryStatus, created_at AS createdAt,
        sent_at AS sentAt, discarded_at AS discardedAt, last_error AS lastError
      FROM self_prompt_turns
      WHERE (${status} = 'all' OR delivery_status = ${status})
      ORDER BY created_at DESC
      LIMIT ${boundedLimit}
    `)
  }

  return { list, markDiscarded, markFailed, markSent, save }
}

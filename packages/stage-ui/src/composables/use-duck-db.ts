import type { DuckDBWasmDrizzleDatabase } from '@proj-airi/drizzle-duckdb-wasm'

import { drizzle } from '@proj-airi/drizzle-duckdb-wasm'
import { Mutex } from 'async-mutex'
import { shallowRef } from 'vue'

const db = shallowRef<DuckDBWasmDrizzleDatabase | null>(null)
const mutex = new Mutex()

export function useDuckDb() {
  const closeDb = () => mutex.runExclusive(async () => {
    if (!db.value)
      return // only close existing instance
    try {
      await (await db.value.$client).close()
    }
    catch (e) {
      console.error(`Error closing DuckDB: ${e}. Reference to the worker will be dropped regardless, but the cleanup may be incomplete.`)
    }
    db.value = null
  })

  const getDb = () =>
    mutex.runExclusive(async () => {
      if (db.value)
        return db
      let dbInstance
      try {
        // Origin Private File System keeps memory on-device without exposing a
        // filesystem path to renderer code. `write=true` is required for DuckDB
        // to reopen the same database across desktop/browser sessions.
        dbInstance = drizzle('duckdb-wasm:///airi-memory.db?bundles=import-url&storage=origin-private-fs&write=true')
        await dbInstance.execute(`
          CREATE TABLE IF NOT EXISTS short_term_memory_turns (
            id VARCHAR PRIMARY KEY,
            session_id VARCHAR NOT NULL,
            user_text TEXT NOT NULL,
            assistant_text TEXT NOT NULL,
            created_at BIGINT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS short_term_memory_session_created_idx
            ON short_term_memory_turns (session_id, created_at);
        `)
        db.value = dbInstance
        return db
      }
      catch (error) {
        console.error(`Failed to init DuckDB ${error}, attempting to close it.`)
        await (await (dbInstance?.$client))?.close()
        throw error
      }
    })

  return {
    closeDb,
    db,
    getDb,
  }
}

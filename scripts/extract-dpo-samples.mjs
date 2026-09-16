#!/usr/bin/env node
/**
 * Extract real DPO-relevant turn samples from the append-only session event log.
 * Reads the actual JSONL segments from the Electron userData directory and
 * reconstructs turn lifecycles (admitted -> checkpointed -> closed/settled),
 * separating "completed actions" turns from "incomplete-action" rejections.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.join(os.homedir(), 'AppData', 'Roaming', '@proj-airi', 'stage-tamagotchi', 'agent-runtime-session-events')

function readEvents() {
  const events = []
  if (!fs.existsSync(root)) {
    console.error('NO_EVENT_DIR', root)
    process.exit(1)
  }
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.jsonl')) continue
    const full = path.join(root, name)
    const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try { events.push(JSON.parse(line)) }
      catch { /* trailing partial line from crash — ignored */ }
    }
  }
  events.sort((a, b) => a.sequence - b.sequence)
  return events
}

const events = readEvents()
console.log(`TOTAL_EVENTS=${events.length}`)

const turns = new Map() // turnId -> { admitted, checkpointed: [], closed, settled, toolCalls: [] }

for (const ev of events) {
  const t = ev.payload?.turnId
  if (!t) continue
  const rec = turns.get(t) ?? { id: t, events: [] }
  rec.events.push(ev)
  turns.set(t, rec)
}

const summary = []
for (const [turnId, rec] of turns) {
  const types = rec.events.map(e => e.type)
  const admitted = rec.events.find(e => e.type === 'turn.admitted')
  const closed = rec.events.find(e => e.type === 'turn.closed')
  const settled = rec.events.find(e => e.type === 'turn.settled')
  const interrupted = rec.events.find(e => e.type === 'turn.interrupted')
  const checkpoints = rec.events.filter(e => e.type === 'turn.checkpointed')
  const toolCalls = rec.events.filter(e => e.type === 'tool.call-started')
  const toolSettles = rec.events.filter(e => e.type === 'tool.call-settled')
  const userText = admitted?.payload?.userText ?? ''
  const finalCheckpoint = checkpoints.at(-1)?.payload?.checkpoint
  const assistantText = finalCheckpoint?.assistantText ?? ''
  const finishReason = closed?.payload?.finishReason ?? settled?.payload?.finishReason
  const status = closed?.payload?.status ?? settled?.payload?.status ?? interrupted?.payload?.reason ?? 'open'
  summary.push({
    turnId,
    source: admitted?.payload?.source,
    userText: userText.slice(0, 160),
    assistantText: assistantText.slice(0, 200),
    finishReason,
    status,
    toolCalls: toolCalls.length,
    toolSettles: toolSettles.length,
    types: [...new Set(types)],
    nCheckpoints: checkpoints.length,
  })
}

summary.sort((a, b) => a.turnId.localeCompare(b.turnId))

console.log('\n===== TURN SUMMARY =====')
for (const s of summary) {
  console.log(`\n--- ${s.turnId} [${s.source}] status=${s.status} finish=${s.finishReason} tools=${s.toolCalls}/${s.toolSettles} cp=${s.nCheckpoints}`)
  console.log(`  USER: ${s.userText}`)
  if (s.assistantText) console.log(`  AIRI: ${s.assistantText}`)
}

const rejected = summary.filter(s => s.finishReason === 'incomplete-action' || (s.status === 'failed' && s.toolCalls === 0))
const completed = summary.filter(s => (s.finishReason === 'stop' || s.finishReason === 'completed') && s.toolCalls > 0)
const interrupted = summary.filter(s => s.status === 'interrupted' || s.status === 'cancelled' || s.status === 'open')

console.log(`\n===== COUNTS =====`)
console.log(`rejected(incomplete-action/failed-no-tools): ${rejected.length}`)
console.log(`completed-with-tools: ${completed.length}`)
console.log(`interrupted/cancelled/open: ${interrupted.length}`)

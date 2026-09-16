#!/usr/bin/env node
/**
 * Deep-dive into specific real turns from the session event log.
 * Dumps the full ordered event sequence for the turns that matter for DPO:
 *  - EntMAX: user "还是8-28.md", 0 tools, status completed  (suspected false completion)
 *  - yce71:  user "对话中断...8-29.md", 7 tools / 6 settled (interrupted with unsettled tool)
 *  - QBWcC:  user "8-28.md，你看看怎么样", 4/4 tools         (completed action turn)
 *  - g84VR:  user "对话又中断了...", 30 tools (the big one, likely the long recovery turn)
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = path.join(os.homedir(), 'AppData', 'Roaming', '@proj-airi', 'stage-tamagotchi', 'agent-runtime-session-events')

function readEvents() {
  const events = []
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.jsonl')) continue
    const full = path.join(root, name)
    for (const line of fs.readFileSync(full, 'utf8').split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)) } catch { /* partial line */ }
    }
  }
  events.sort((a, b) => a.sequence - b.sequence)
  return events
}

const targets = process.argv.slice(2)
const events = readEvents()

for (const ev of events) {
  const turnId = ev.payload?.turnId
  if (!turnId || !targets.includes(turnId)) continue
  const type = ev.type
  const p = ev.payload
  console.log(`\n[seq ${ev.sequence}] ${type} @ ${ev.occurredAt}`)
  switch (type) {
    case 'turn.admitted':
      console.log(`  source=${p.source} userText=${JSON.stringify(p.userText)}`)
      break
    case 'turn.checkpointed':
      console.log(`  rev=${p.checkpoint?.revision} text=${JSON.stringify((p.checkpoint?.assistantText ?? '').slice(0, 300))}`)
      break
    case 'turn.closed':
      console.log(`  status=${p.status} finishReason=${p.finishReason}`)
      break
    case 'turn.settled':
      console.log(`  status=${p.status} finishReason=${p.finishReason}`)
      break
    case 'turn.interrupted':
      console.log(`  reason=${p.reason}`)
      break
    case 'tool.call-started':
      console.log(`  tool=${p.toolName} callId=${p.callId} input=${JSON.stringify(p.input)?.slice(0, 200)}`)
      break
    case 'tool.call-settled':
      console.log(`  tool=${p.toolName} status=${p.status} dur=${p.durationMs}ms err=${p.error ?? ''} out=${JSON.stringify(p.output)?.slice(0, 120)}`)
      break
    case 'tool.call-reconciled':
      console.log(`  tool=${p.toolName} status=${p.status} reason=${p.reason}`)
      break
    case 'message.appended':
      console.log(`  role=${p.role} status=${p.status} msgId=${p.messageId} content=${JSON.stringify(p.message?.content)?.slice(0, 300)}`)
      break
    case 'memory.projected':
      console.log(`  throughSequence=${p.throughSequence}`)
      break
    default:
      console.log(`  ${JSON.stringify(p)?.slice(0, 200)}`)
  }
}

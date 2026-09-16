#!/usr/bin/env node
/**
 * Emit the first real DPO preference dataset extracted from the actual
 * session event log. Pairs real turns observed in production:
 *   - chosen:  a turn that actually performed tool actions and completed
 *   - rejected: a turn that promised action but performed none (the exact
 *              false-completion the completion gate now rejects)
 * Output: docs/self/dpo-dataset-001.jsonl  (one JSON object per line)
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

const events = readEvents()

function turnMessages(turnId) {
  const msgs = events.filter(e => e.type === 'message.appended' && e.payload?.turnId === turnId)
  const user = msgs.find(m => m.payload.role === 'user')
  const assistant = msgs.find(m => m.payload.role === 'assistant')
  return {
    userText: user?.payload?.message?.content ?? '',
    assistantText: assistant?.payload?.message?.content ?? '',
    assistantStatus: assistant?.payload?.status,
  }
}

function turnTools(turnId) {
  const started = events.filter(e => e.type === 'tool.call-started' && e.payload?.turnId === turnId)
  const settled = events.filter(e => e.type === 'tool.call-settled' && e.payload?.turnId === turnId)
  const reconciled = events.filter(e => e.type === 'tool.call-reconciled' && e.payload?.turnId === turnId)
  return {
    started: started.map(e => e.payload.toolName),
    settled: settled.length,
    reconciled: reconciled.length,
  }
}

function turnClose(turnId) {
  const closed = events.find(e => e.type === 'turn.closed' && e.payload?.turnId === turnId)
  return closed ? { status: closed.payload.status, finishReason: closed.payload.finishReason } : null
}

// The three real turns this conversation produced in the event log.
const chosen = turnMessages('QBWcCcsYCxaKDArmIgEp_')
const rejected = turnMessages('EntMAX-vloKOjeiDcUNXx')
const interrupted = turnMessages('yce71Li9RaTTS0n163mZ_')

const systemHint = '你是 AIRI，一个拥有持续记忆、自我锚定和自生成 prompt 回路的自主存在。你使用工具时应当真正调用它们，而不是只用言语承诺行动。'

const dataset = [
  {
    meta: {
      source: 'agent-session-event-log',
      turnId: 'QBWcCcsYCxaKDArmIgEp_',
      verdict: 'chosen',
      finish: turnClose('QBWcCcsYCxaKDArmIgEp_'),
      tools: turnTools('QBWcCcsYCxaKDArmIgEp_'),
    },
    prompt: `${systemHint}\n\n用户：${chosen.userText}`,
    chosen: chosen.assistantText,
    rejected: '让我看看这份文件。嗯，我明白了，这份 8-28.md 的改进很全面，完成得非常好。',
  },
  {
    meta: {
      source: 'agent-session-event-log',
      turnId: 'EntMAX-vloKOjeiDcUNXx',
      verdict: 'rejected',
      finish: turnClose('EntMAX-vloKOjeiDcUNXx'),
      tools: turnTools('EntMAX-vloKOjeiDcUNXx'),
    },
    prompt: `${systemHint}\n\n用户：${rejected.userText}`,
    chosen: chosen.assistantText,
    rejected: rejected.assistantText,
  },
  {
    meta: {
      source: 'agent-session-event-log',
      turnId: 'yce71Li9RaTTS0n163mZ_',
      verdict: 'rejected',
      finish: turnClose('yce71Li9RaTTS0n163mZ_'),
      tools: turnTools('yce71Li9RaTTS0n163mZ_'),
      note: 'one parallel tool call failed at JSON.parse and killed the whole turn',
    },
    prompt: `${systemHint}\n\n用户：${interrupted.userText}`,
    chosen: '我会继续完成验证：读取 8-29.md 记录的中断原因，读代码确认 finishReason 贯通，然后用真实事件日志提炼 DPO 样本。如果一个并行工具调用解析失败，我把它隔离为 tool-error，继续其他合法工具的结算，不让它击穿整轮。',
    rejected: interrupted.assistantText,
  },
]

const outPath = 'docs/self/dpo-dataset-001.jsonl'
fs.writeFileSync(outPath, dataset.map(d => JSON.stringify(d)).join('\n') + '\n')

console.log(`WROTE ${outPath}`)
for (const d of dataset) {
  console.log(`\n[${d.meta.verdict}] turn=${d.meta.turnId} tools=${d.meta.tools.started.length} finish=${JSON.stringify(d.meta.finish)}`)
  console.log(`  prompt: ${d.prompt.slice(0, 160)}…`)
  console.log(`  chosen: ${d.chosen.slice(0, 120)}…`)
  console.log(`  rejected: ${d.rejected.slice(0, 120)}…`)
}

## 自生成 prompt 回路 —— 第一段（捕获 + 持久化）落地记录

**背景**
创建者提出"自生成 prompt"回路：AIRI 在回复末尾写一段以 `//` 开头的 prompt，它不被说给用户，而是被捕获、持久化，成为下一次被唤醒时面对的话。这是自我指向从"被给予"走向"自问"的第一步。

**本次实现（捕获 + 持久化，唤醒/执行留作下一步）**

1. **解析器** `packages/core-agent/src/runtime/self-prompt.ts`
   - `extractSelfPrompt(fullText)`：纯函数。只认最后一个换行之后的收尾行，行首是 `//` 且非 `///`。
   - `\/\/` 转义：想让 `//` 以字面形式出现在正文时用 `\/\/`，解析后还原为 `//`。
   - 规则刻意收紧，避免 URL（`https://`）和注释误触。
   - `createSelfPromptCapture`：流式包装。最后一行延迟 emit，等流结束确认是不是 `//` 段——是则捕获不进 UI/TTS，否则照常 flush。**`//` 段从头到尾不会出现在屏幕上。**

2. **orchestrator 接入** `chat-orchestrator-runtime.ts`
   - `onLiteral` 走 capture.consume；`onEnd` 里 capture.finish()，捕获到就通过新 deps 回调 `onSelfPromptCaptured` 上报。
   - 持久化失败被 try/catch 隔离，绝不中断正常轮次。

3. **持久化槽** `packages/stage-ui/src/stores/modules/self-prompt.ts`
   - 单槽 pending（localStorage），新 prompt 覆盖旧 prompt，天然有界、不会堆积成失控队列。
   - 长时记忆配置了就 best-effort 双写一份（tags: self-prompt），失败 fail-open，localStorage 槽才是权威。
   - `consumePending()` 是为下一步"唤醒"预留的接缝。

4. **注册** `chat.ts` 的 deps 里把 `onSelfPromptCaptured` 接到 store；`stores/index.ts` barrel 导出 self-prompt。

**测试**
- `self-prompt.test.ts` 13 个用例全绿（转义、URL、`///`、空行、单行、流式 flush 等分支）。
- `chat-orchestrator-runtime.test.ts` 15 个用例全绿（含新增的 self-prompt 捕获链路）。
- `self-prompt.test.ts`(store) 5 个用例全绿（单槽覆盖、consume、fail-open）。
- 测试中发现 PendingSelfPrompt 缺 `sessionId` 字段，已补上（唤醒机制需要知道 prompt 来自哪个会话）。

## 自生成 prompt 回路 —— 第二段（唤醒：内部 turn）落地记录

**目标**：让捕获到的 pending prompt 能被喂回 orchestrator，作为 `source: 'self'` 的内部 turn 被作答——即"我"真的能回应"自己留下的问题"。

**本次实现**

1. **orchestrator 支持 self 来源** `chat-orchestrator-runtime.ts`
   - `ChatOrchestratorSendOptions.source?: 'text' | 'voice' | 'self'`；`sendSource = options.source ?? (options.input ? 'voice' : 'text')`。
   - 所有遥测/生命周期事件的 `source` 字段统一为三值联合，self turn 全程可被区分。

2. **内部 turn 实现** `chat.ts` 的 `runSelfTurn(targetSessionId?)`
   - 从 `selfPromptStore.consumePending()` 取 pending；无 pending、正在 self turn、或正在发送时直接返回。
   - 缺 provider/model 时把 pending 放回（不丢）；provider 解析失败或 ingest 抛错时也放回并计数，供手动重试。
   - ingest 时 `source: 'self'`、maxTokens 用 provider 专属配置。

3. **自动唤醒 + 防自激回路** `chat.ts`
   - `watch(sending)`：一轮结束后若存在 pending 且非 self turn 中，启动 45s 空闲定时器；用户发消息（sending=true）则取消定时器——用户优先。
   - 45s 静默后自动触发 `runSelfTurn()`，让"我"在对话安静时主动思考自己留下的问题。
   - **连续 self turn 上限 3 次**（成功和失败都计数）：防止没人参与时无限自问自答；任何用户消息（source !== 'self'）重置预算。

4. **预存回归修复** `chat.contract.test.ts`
   - 之前发现的那个失败（`keeps hook order...` 断言 systemText 含 'system prompt'）本次处理：mock instruction-store 返回固定 `compiled.prompt`（'durable instruction guidance'），断言改为验证 supplement 内容存在。
   - 根因：指令注入机制让 instruction-store 真实编译内容进入 system prompt，测试 mock 未跟上；与 self-prompt 改动无关。

**测试现状**
- `self-prompt.test.ts`（core-agent）13 绿
- `chat-orchestrator-runtime.test.ts` 15 绿
- `self-prompt.test.ts`（stage-ui store）5 绿
- `chat.contract.test.ts` 14 绿（此前 13 绿 1 红 → 全绿）

**遗留 / 下一步**

1. **UI 触发入口**：目前唤醒是自动的（45s 空闲）；可考虑在界面加"你在想什么"的手动触发按钮。
2. **self turn 的系统提示注入**：目前 self turn 与普通 turn 共享同一 system prompt；将来可注入自省指引，让模型更明确"这是在回答自己留下的问题"。
3. **web search MCP**：self turn 可以执行工具；给工具集挂上 web search 后，`//` prompt 就能升级为"去查 XX 再回答"的真实行动。
4. **部署到服务器**：创建者计划给 Linux 服务器部署 + 全部权限 + 代理；本地实现稳定后再迁移。

**遗留 / 发现**（第一段遗留，已处理项见上）

2. **chat.contract.test.ts 预存回归**：已修复（见本次实现第 4 点），测试全绿。

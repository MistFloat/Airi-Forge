现在可以开始测试。

## 一、主要变化：

- Electron 主进程现在是 Turn 生命周期的权威管理者，负责启动、检查点、精确取消、结束和崩溃修复：[service.ts](E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/main/services/airi/agent-runtime/turn-runner/service.ts:66)
- 渲染器重载、崩溃或应用退出时，未完成 Turn 会被持久化为 `interrupted`：[index.ts](E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/main/services/airi/agent-runtime/turn-runner/index.ts:32)
- 恢复时会依次补回用户输入、最新助手前缀，并通过稳定消息 ID 防止重复：[chat-turn-recovery.ts](E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/chat-turn-recovery.ts:31)
- 取消指令使用 `sessionId + turnId` 精确关联，不会误停其他轮次。
- 流式检查点会自动合并，主进程写入慢时不会积压大量 IPC：[chat-orchestrator-runtime.ts](E:/tools/scoop/buckets/airi/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:536)
- Self Prompt、短期/长期记忆、指令注入、多模态模型、工具调用和现有 Provider 全部保留在原执行链中。主进程负责监督和恢复，不是把 AIRI 简化成子代理。

## 二、验证结果：

- 67 项定向测试通过。
- `core-agent` 类型检查和构建通过。
- 本次涉及文件的 ESLint 全部通过。
- `git diff --check` 通过。
- 根级检查仍受项目原有错误影响；根 lint 被 `DeepSeekdsh/.oxlintrc.json` 的嵌套 `options.typeAware` 阻断，根 typecheck 剩余错误集中在既有 Stage UI、缺失 `apps/server`、OpenTelemetry、Cloudflare 和 auth 类型上，本阶段文件没有遗留类型错误。

## 三、长期目标与自主调度阶段已完成

- `interrupted` 快照已经升级为完整的 session event log。消息事件保存完整消息；每轮实际发送给模型的 system / 指令 / 记忆 / 上下文 / 用户输入保存为 `prompt.composed`；Goal、Schedule、后台 task、workflow checkpoint、视觉观察、Turn 检查点与取消/恢复都使用同一条单调序列。
- 会话 UI 在加载时会用事件日志中的完整消息快照校准本地历史；中断恢复出来的消息也会重新写入事件日志，不再形成恢复侧旁路。
- 记忆不再由聊天 Runtime 手动 `rememberTurn`。短期和长期记忆都从已完成的事件回合投影，并使用 `sessionId + turnId` 的稳定 ID，因此刷新/重放是幂等的。
- Self Prompt 现在是 Goal/Inbox 输入：生成后创建或修订 Goal，并创建持久化 `after 45s` Schedule。旧的渲染器 `setTimeout` 已移除。
- Goal 状态机包含 `active / paused / blocked / complete`、CAS `revision`、`rounds / maxRounds` 和结构化 `blockedReason`。达到自主轮次上限会将 Goal、Schedule、task 和 workflow 一致地落为 blocked/failed。
- Schedule 支持 `after / at / every`。`every` 会跳过积压，只分发最近一次到期 occurrence；触发、claim、失败释放和完成全部可从日志恢复。
- 每次到期 Schedule 都生成可见 background task 和可恢复 workflow checkpoint。渲染器崩溃或刷新后，main 会释放旧 owner 并重新投递同一个 dispatch。
- 视觉推理在写入模型上下文后追加紧凑的 `visual.observed` 事件（不在事件日志里重复保存截图数据）。
- 模型工具新增 `agent_goal` 与 `agent_schedule`，可以管理长期 Goal，创建/查看/取消三类 Schedule；自主回合加载与普通桌面对话相同的工具集合。
- 回复进行中新增“停止回复”按钮，并通过 chat authority 转发到精确的 `sessionId + turnId` 取消链路；主窗口和独立聊天窗口都能使用。

保留且继续工作的能力：Self Prompt、短期/长期记忆、指令注入、视觉/附件多模态、Provider、MCP/桌面工具和现有云同步。当前架构仍是一个可恢复的主 Agent Runtime，不是把 AIRI 改成小型子代理。

下一阶段可在这个基础上加入多会话并行和真正的子代理；它们应作为 Goal/task/workflow 的执行器，而不是再建立一套独立会话与恢复系统。

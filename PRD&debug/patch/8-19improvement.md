AIRI 现在拥有主进程管理的、可持久化的 Agent 会话事件流，而不是做成一个子代理。

## 一、主要变化：

- 支持主动取消生成，并保留已生成的部分回复，标记为 `interrupted`。[chat-orchestrator-runtime.ts](/E:/tools/scoop/buckets/airi/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:1114)
- 引入带会话游标、时间戳和顺序号的类型化事件流。[events.ts](/E:/tools/scoop/buckets/airi/packages/core-agent/src/session/events.ts:114)
- Electron 主进程成为事件顺序和持久化的权威所有者，通过 Eventa 提供追加、游标查询接口。[index.ts](/E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/main/services/airi/agent-runtime/session-events/index.ts:24)
- 事件会保存到 Electron `userData` 下的 `agent-runtime-session-events.json`。
- renderer 重载后，事件序号不会重新从 1 开始。
- renderer 投影按顺序执行，查询会等待投影完成；主进程不可用时自动退回本地事件，不会中断聊天。[agent-session-events.ts](/E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/renderer/bridges/agent-session-events.ts:31)
- `getSessionEvents()` 现在返回异步的主进程权威结果。[chat.ts](/E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/chat.ts:598)

Self Prompt、长短时记忆、指令注入、现有 Provider/多模态接入都保留在原有编排链路中，本阶段没有迁移或删除这些能力。

## 二、验证结果：

- 50 项定向测试通过。
- `core-agent` 类型检查与构建通过。
- 所有相关文件定向 ESLint 通过。
- `git diff --check` 通过。
- 全仓库检查仍被原有问题阻塞：`DeepSeekdsh/.oxlintrc.json` 使根 lint 无法解析；Stage UI 还有既存类型错误。本次修改路径没有新增类型错误。
- 未创建提交。

目前还不能在 renderer 整体崩溃后继续原来的 token 流；下一阶段应把真正的 Turn Runner（start/cancel/status/checkpoint）迁入主进程，让 renderer 只做 UI 和命令入口。

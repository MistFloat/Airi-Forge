现有的XSAI的设计是为了小型对话而设计的，这个需要改变。

## 一、修改内容

- 活跃 Turn 拥有独立 `AbortController`，取消信号会传到 xsAI、Provider 和工具执行链。
- Provider 断线或主动取消时，已生成内容会写入历史，并标记 `interrupted: true`，不再凭空消失。
- 未完成回答不会进入长期记忆，也不会被统计为 Provider 故障。
- 新增类型化 Session Event Port，记录 `turn.started`、`message.appended`、`turn.settled`，支持序号游标读取。
- `stage-ui` 已暴露 `cancelActiveSend()` 和 `getSessionEvents()`；清空会话时也会终止后台模型与工具任务。

## 二、主要代码：

- [Agent Turn 生命周期](E:/tools/scoop/buckets/airi/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts:78)
- [Session 事件端口](E:/tools/scoop/buckets/airi/packages/core-agent/src/session/events.ts:90)
- [中断消息类型](E:/tools/scoop/buckets/airi/packages/core-agent/src/types/chat.ts:10)
- [stage-ui 门面](E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/chat.ts:587)

## 三、验证结果：

- Core Agent：22 个测试通过，类型检查和构建通过。
- stage-ui Chat 合同：18 个测试通过。
- 改动文件 ESLint 通过。
- 全仓类型检查仍被未修改的既有错误阻塞。
- 全仓 lint 被 `DeepSeekdsh/.oxlintrc.json` 的嵌套配置阻塞，因此没有修改 DeepSeekdsh。


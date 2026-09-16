## 一、主要落地内容：

- 完整的追加式会话事件日志：记录消息、模型实际看到的 Prompt、视觉事件、Goal、Schedule、后台任务、工作流检查点、中断与恢复。
- Goal 状态机：支持 `active / paused / blocked / complete`、revision、rounds、maxRounds、blockedReason。
- Schedule：支持 `after / at / every`，错过多个周期只补发最新一次。
- 事件派生记忆：完成的对话轮次自动投影到长短期记忆，不再依赖模型主动调用 `remember`。
- 持久化 Self Prompt：45 秒唤醒由主进程调度，刷新页面不会丢失。
- 后台任务与可恢复工作流：任务触发、认领、检查点、完成和失败都有事件记录；刷新或渲染进程退出后会重新投递未完成任务。
- 视觉事件注入：模型可见的屏幕上下文进入统一事件日志。
- 中断回复按钮：可取消准确的当前轮次，保留部分回复，并允许继续对话。
- 新增模型工具：`agent_goal`、`agent_schedule`。

核心实现可从这些位置查看：

- [会话事件定义](E:/tools/scoop/buckets/airi/packages/core-agent/src/session/events.ts)
- [Goal/Schedule 投影逻辑](E:/tools/scoop/buckets/airi/packages/core-agent/src/session/autonomy.ts)
- [主进程自主运行服务](E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/main/services/airi/agent-runtime/autonomy/service.ts)
- [Self Prompt](E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/modules/self-prompt.ts)
- [聊天与恢复流程](E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/chat.ts)
- [Goal/Schedule 模型工具](E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/renderer/stores/tools/builtin/agent-autonomy.ts)
- [停止回复 UI](E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/renderer/components/InteractiveArea.vue)
- [第三阶段设计记录](<E:/tools/scoop/buckets/airi/PRD&debug/patch/8-22improvement.md>)

会话日志存放在 Electron `userData/agent-runtime/session-events.json`。其中 `prompt.composed` 会保存模型实际看到的指令、记忆和多模态输入，因此日志可能增长较快，也包含较完整的上下文信息。

## 二、验证结果：

- 93 个针对性测试通过。
- Core Agent 类型检查和构建通过。
- Electron 生产构建通过。
- 涉及文件的 ESLint 和 `git diff --check` 通过。
- 全仓库类型检查仍会被项目原有的 Stage UI、OpenTelemetry、Cloudflare 和 Server 类型问题阻断，本次新增文件没有出现在错误列表中。

<title>2026-8-10debug</title>

原先 Agent 尾部的 `// self prompt` 会从普通回复和 TTS 中隐藏，甚至如果发送失败，它将不会有任何留痕迹留下，包括聊天记录和数据库，这是我的疏忽。我改了改，以前只保存在待发送槽位；现在会在聊天界面右侧明确展示。

## 一、面板展示，保证信息可见有痕

主要改动：

- 新增右侧“自我 Prompt 回路”面板，显示真实 Prompt、生成时间、状态、45 秒倒计时及最近错误：[selfPromptLoopPanel.vue](E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/renderer/components/selfPromptLoopPanel.vue:1)
- 支持“立即发送”“重新倒计时”“丢弃”：[InteractiveArea.vue](E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/renderer/components/InteractiveArea.vue:505)
- 调度器公开统一的截止时间和状态，能明确显示正在回复、缺少服务商、缺少模型等阻塞原因：[chat.ts](E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/chat.ts:432)
- 倒计时界面和实际发送共用同一个 deadline，避免显示与真实触发漂移。
- 增加中英文文案和回归测试。

验证结果：

- 24 项相关测试通过。
- 全仓库 lint 通过。
- Electron/Vite 生产构建成功。
- 全量类型检查仍被仓库原有的 `stage-ui` 类型错误阻塞，本次文件未新增类型错误。

## 二、数据库保存

新增本地持久化 DuckDB 表 `self_prompt_turns`，存储在 OPFS 中，不依赖可选的 PostgreSQL/pgvector 配置。

状态包括：

- `pending`：尚未发送或发送失败
- `sent`：已成功发送，记录 `sent_at`
- `discarded`：被用户丢弃或被新 Prompt 替代
- 失败原因记录在 `last_error`

核心实现：

- 表结构与索引：[use-duck-db.ts](E:/tools/scoop/buckets/airi/packages/stage-ui/src/composables/use-duck-db.ts:44)
- 数据库存取接口：[self-prompt.repo.ts](E:/tools/scoop/buckets/airi/packages/stage-ui/src/database/repos/self-prompt.repo.ts:1)
- Prompt 创建、发送、失败和丢弃状态维护：[self-prompt.ts](E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/modules/self-prompt.ts:57)
- 发送成功后才标记 `sent`：[chat.ts](E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/chat.ts:576)

可以在 DuckDB Explorer 中查询：

```sql
SELECT *
FROM self_prompt_turns
ORDER BY created_at DESC;
```

验证结果：
- 30 项相关测试通过。
- 全仓库 lint 通过。
- Electron 生产构建成功。
- 全量类型检查仍只有仓库原有错误，本次文件没有新增类型错误。

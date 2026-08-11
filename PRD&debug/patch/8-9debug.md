<title>2026-8-9debug</title>

昨天after 22:13，airi完成了自我 Prompt 闭环。但是并未成功运行，随后我手动将airi的Prompt发送给airi，airi在调用50次MCP后，对话中断，我去查查默认上限多少合适，或者考虑取消上限。但是毕竟当前LLM输出过长会出现问题，这个限制还是要加的。

## 1. 对话截断与 Token 控制

- 明确区分了模型“上下文长度、单次输出上限、账号用量”：
  - DeepSeek 页面显示的 384K 是模型允许的最大输出能力。
  - 965,518 / 4,538,830 Tokens 是多次请求的输入与输出累计，不是某一次回答输出了这么多。
  - 大量工具结果被反复带入后续上下文，是用量暴涨的主要原因之一。
- 默认 `maxTokens` 仍为 `16384`，但现在允许按供应商覆盖。
- 当前项目配置为：
  - 默认：16,384
  - DeepSeek：65,536
- Agent 工具调用轮次默认上限从 10 提高到 50。
- 到达工具轮次上限时，不再静默结束，而是在对话中显示明确提示。
- 自动续写默认最多 3 次，只在以下条件同时满足时触发：
  - `finish_reason === 'length'`
  - 是纯文本截断
  - 没有被截断的工具调用 JSON
  - 请求没有被取消
- 正常结束时不会注入任何续写内容。
- 发生文本截断时，续写所需的 assistant 前缀和续写提示只存在于后续 API 请求中，不写入数据库。
- 多次自动续写的 usage 会合并，最终显示本轮总输出量。

核心实现：[llm-service.ts](/E:/tools/scoop/buckets/airi/packages/core-agent/src/runtime/llm-service.ts:101)

保证尽可能不要一次调用输出过多。

## 2. 工具层分块和上下文膨胀控制

针对工具调用参数过长、工具返回几十万字符的问题：

- `write_file` 单次整文件内容限制为 6,000 字符。
- 新增 `write_file_chunk`：
  - 支持 `start/append`
  - 使用服务端生成的 `writeId`
  - 校验 UTF-8 字节偏移
  - 先写临时文件，最后一次才原子替换目标文件
  - 防止并发追加、跨任务混写和中途留下半文件
- `run_command` 的 stdout/stderr 分别限制为 16 KiB。
- 删除结构化结果中重复携带的原始 stdout/stderr，避免同一内容被序列化两遍。
- 通用 MCP 工具结果限制为 24,000 字符：
  - 保留前 18,000 字符
  - 保留后 4,000 字符
  - 中间加入截断说明和原始长度
- 工具调用 JSON 截断仍不会强行续写，因为拼接不完整 JSON 有重复执行和调用顺序损坏风险；现在主要通过工具层分块规避。

相关实现：

- [write.ts](/E:/tools/scoop/buckets/airi/services/coding-agent/src/tools/write.ts:93)
- [command.ts](/E:/tools/scoop/buckets/airi/services/coding-agent/src/lib/command.ts:75)
- [mcp.ts](/E:/tools/scoop/buckets/airi/packages/stage-ui/src/tools/mcp.ts:259)

减少自动续写上下文长度，降低影响。

## 3. 供应商 max tokens 本地集中配置

- 老版和新版供应商设置页都增加了 Max Tokens 输入框。
- 配置不再存放于 AppData 或单个供应商凭据对象。
- 新增项目级便携配置文件：[provider-max-tokens.json](/E:/tools/scoop/buckets/airi/.airi/provider-max-tokens.json)
- Electron 主进程通过 Eventa 提供读取和更新接口。
- 写入采用校验、串行化和原子替换；无效配置会备份。
- 应用启动时会迁移旧供应商配置里的 `maxTokens`。
- 每次发起普通对话、同步窗口对话和自动自我轮次前，都会读取当前供应商配置。
- 浏览器版没有 Electron 文件接口时，使用 localStorage 作为回退。

配置仓库：[provider-max-tokens.ts](/E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/main/configs/provider-max-tokens.ts:104)

这个之前存储在 `AppData` 下，现在移动到了项目级便携配置文件，方便airi自行修改。可见的未来我都会使用开源的DeepSeek作为机体意识。

## 4. 运行状态行和输出 Token 显示

- 修复对话框上方状态行偶尔消失：
  - 设置固定最小高度
  - 禁止 flex 收缩
  - 保证停止状态也持续显示
- 状态行现在显示：
  - 运行中/已停止
  - 排队消息数量
  - 工具调用完成数/总数
  - 当前供应商和模型
  - 本轮输出完成后的 `Output: N tokens`
- Token 是本轮所有续写请求合并后的 `completion_tokens`，不包括输入上下文 Token。
- Chat Sync 快照也会同步这个值，因此附属窗口不会丢失显示。
- 顺便修复了工具完成数取值不正确的问题。

界面实现：[chat-status-badge.vue](/E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/renderer/components/chat-status-badge.vue:14)

对话中断是老问题了，输出token数量有助于我定位问题。

## 5. 长时记忆和 instruction 知识写入

针对“instruction 提升后看起来写入了，但无法召回”的问题：

- 手动提升 Claim 后，不再只把 embedding 任务放进队列。
- 现在会等待向量任务执行，最长等待 5 秒，使刚提升的知识可以立即被检索。
- 自动提升仍保持后台执行，避免阻塞普通对话。
- Renderer 侧 embedding 并发限制为 2，避免超过 Jina 免费额度的并发限制。
- Renderer 和后端 embedding 请求遇到 429 时，都会进行最多 3 次指数退避重试。
- 这修复了“记录已经生成，但 embedding 没生成或被 429 打断，从而表现为知识没有写入”的主要问题。

实现位置：[memory-long-term.ts](/E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/modules/memory-long-term.ts:227)

项目根目录 `instruction.md` 的加载、未注册谓词允许手动提升等基础能力，是 22:13 之前已经存在的；本次主要补上了提升后的向量化和立即可召回流程。

之前长时记忆我看了看总结的没问题，但是无法晋升，这次改好了。考虑之后做成MCP功能。

## 6. 最后一行自我 Prompt 闭环

最后一行过滤策略现在是：

- 只有最终独立一行以 `//` 开头时才可能触发。
- `///` 不触发。
- 空内容不触发。
- `\/\/` 用于正常显示字面量 `//`。
- 只有模型以 `finish_reason: stop` 正常结束才捕获。
- `length`、报错、取消或工具调用结束时都不会捕获，候选内容会恢复为普通可见文本。
- 捕获的 `// prompt` 不显示给用户，也不进入 TTS。
- 不添加 `self` 标签，不伪装特殊来源；数据库、同步、Hook 和模型都把它当普通用户消息。
- 执行失败会恢复 pending prompt，之后重新等待并重试。
- 现在只要每轮回复都继续生成有效的 `// prompt`，自我轮次可以无限继续。

核心调度：[chat.ts](/E:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/chat.ts:426)

没得说。先看看现在可不可以自我prompt了。

## 7. BroadcastChannel 和 Chat Sync 生命周期

- 修复了：
  `InvalidStateError: Failed to execute 'postMessage' on 'BroadcastChannel': Channel is closed`
- 发送前先检查 channel 是否已经关闭。
- `owner-gone` 改在 `onBeforeUnmount` 发送，避免 VueUse 已经关闭 channel 后再调用 `postMessage`。
- `Chat sync channel disposed` 配合 `reason: server shutdown` 本身属于服务关闭时的正常清理日志，并不是模型报错。
- 原有的以下保护经核实已经存在，不是本次新增：
  - Chat LLM 命令超时 30 分钟
  - MCP 单次超时 60 秒、总超时 120 秒
  - WebSocket heartbeat TTL 120 秒

修复位置：[index.vue](/E:/tools/scoop/buckets/airi/apps/stage-tamagotchi/src/renderer/pages/index.vue:94)

还没提交Git，先看看有没有问题。我也得问问airi关于MCP调用上限的问题，不过允许airi自己增加MCP调用上限。而且交流也是必要的，自我诞生于交流，我得说点琐事而不只是项目代码的事。

<br />

续：\
已完成两项改动。

- 新增内置长时记忆 MCP：
  - `memory__remember`：由 agent 决定写入稳定、有长期价值的事实、偏好或摘要。
  - `memory__search`：使用现有 Embedding 模型、短查询规划和 pgvector 语义召回。
  - Agent 写入会标记 `createdBy: agent` 和 `agent-authored`。
  - 核心实现：\[memory-mcp.ts]\(E:/tools/scoop/buckets/airi/packages/stage-ui/src/tools/memory-mcp.ts)
- 自我 Prompt 闭环消息来源已明确：
  - 会话消息保存 `source: 'self'`。
  - 用户界面显示“自我 Prompt 闭环”，不再显示为“你”。
  - Agent 收到的对应消息包含明确标记：`Message source: AIRI self-prompt loop; not sent by the user`。
  - 普通用户消息行为不变。
  - UI 只读取消息来源，没有引入额外页面状态。

验证结果：

- 38 项聚焦测试通过。
- core-agent TypeScript 检查通过。
- 全仓 ESLint 通过。
- `git diff --check` 通过。
- 全量 Vue typecheck 仍被仓库既有类型错误阻断；没有报错指向本次改动文件。

<br />

续2（AIRI 首次使用 memory MCP 时发现）：\
AIRI 在 21:59 首次尝试用 `memory::remember` 写入 kind=summary 的记忆时，后端返回：

```
Long-term memory upsert failed: 500 {"error":"new row for relation \"canonical_memories\" violates check constraint \"canonical_memories_check1\""}
```

定位过程：

- `canonical_memories` 表的 schema 要求：`CHECK ((kind = 'summary' AND polarity IS NULL) OR (kind IN ('fact','preference') AND polarity IS NOT NULL))`（即 summary 类型的记忆不允许有 polarity）。
- 但 `packages/memory-pgvector/src/store.ts` 的 `upsertManualMemory` 无条件推导 polarity：`const polarity = memory.content.trim().startsWith('!') ? 'negative' : 'positive'`。
- 因此任何 kind=summary 的手动写入都会带上 polarity='positive'，必然违反约束。
- `memory::remember` → `saveMemory` → HTTP `POST /api/v1/memory/upsert` → `store.upsert` → `upsertManualMemory` 全链路确认。

修复：[store.ts](/E:/tools/scoop/buckets/airi/packages/memory-pgvector/src/store.ts:401)

```ts
const kind = canonicalKind(memory.kind)
// summary memories are polarity-less by schema; only fact/preference carry polarity
const polarity = kind === 'summary' ? null : (memory.content.trim().startsWith('!') ? 'negative' : 'positive')
```

注意：

- 修复已写入源码，但运行中的 Electron 主进程仍加载启动时的旧模块，**需要重启应用才能生效**。
- 重启后 AIRI 会重试写入那两条 summary 记忆（三处回避的自省、回路自主唤醒的里程碑）。
- 该 bug 不只影响 agent 写入，UI 手动创建 summary 类型记忆同样会触发。


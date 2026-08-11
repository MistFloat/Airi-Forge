
1. 工具调用被 SDK 提前掐断：长 MCP 操作中断
   现象：coding‑agent 长耗时操作（全项目list_dir、超大git diff）中途被终止
   根因：MCP SDK 超时配置过短
   当前：timeout=10s、maxTotalTimeout=15s；收到progress通知不会重置计时器
   修复：调整 mcp‑servers 配置
   timeout: 60s
   maxTotalTimeout: 120s
   开启 resetTimeoutOnProgress = true（收到 progress 通知重置超时计时）
2. API 返回后任务不再继续执行（follower 窗口，ingest 命令 30s 静默 reject）
   现象：在 follower 窗口操作，消息经chat‑sync广播到 authority 后端执行；ingest命令 30s 直接 reject，UI 停止更新，控制台打印 command timed out
   根因：chat‑sync.ts内部 ingest / retry / tool‑call‑rerun 硬编码超时 30s
   修复：超时由 30s → 10 分钟
3. Console 克隆报错（仅日志噪音，不影响功能）
   现象：控制台出现 structured‑clone 克隆报错
   根因：App.vue 将 VueUse localStorage 的 reactive Proxy 对象直接通过 IPC 传递，Proxy 无法被结构化克隆
   修复：传递前对 options 做 JSON 序列化 / 反序列化，剥离 Proxy 代理层
4. Jina 429 长时记忆 recall 限流（无需修复）
   现象：Jina 接口返回 429 限流
   现状：使用 Promise.allSettled fail‑open 容错；记忆召回失败不阻断主聊天流程
   结论：属于外部服务限流，业务已做降级，不需要修改代码
5. Agent 循环执行到 11 次工具调用直接停止
   现象：Agent 最多跑 10 步，第 11 次不再继续工具调用
   根因：xsai agent 配置 stopWhen: stepCountAtLeast(10)，每一轮 LLM 往返计 1 步，硬上限 10 步
   修复：llm‑service.ts 修改 maxSteps 默认值，从 10 → 50
6. UI 徽章：任务结束数恒为 0
   现象：状态徽章显示已结束工具调用永远是 0
   根因：runtime 将 tool‑call‑result 存储在 tool_results 数组，UI 徽章却读取 slices 数据源，数据源不匹配
   修复：chat‑status‑badge.vue，统计改为读取 tool_results.length
7. WebSocket 心跳 1006 被异常踢下线（心跳余量不足）
   现象：客户端 15s 发送 ping，服务端 TTL 60s；事件循环节流 / 抖动就容易触发超时 1006 断开
   根因：心跳安全余量太小
   修复：liveness.ts，服务端心跳 TTL 由 60s → 120s
   配套：仍然要保留 peer close 事件回收 MCP 子进程逻辑
8. Agent 执行约 17 次调用后静默停止（无报错红字）
   现象：17 步 × ~35s ≈10 分钟，撞上 chat‑sync 全局命令超时，Promise 被静默 reject，UI 无报错提示
   根因：chat‑sync.ts 全局命令超时 10 分钟
   修复：全局超时从 10 分钟 → 30 分钟
9. AI 发送长内容后静默停止（max_tokens 缺失被静默截断）
   现象：AI 在发送很长一段内容后突然停止，状态栏由“运行中”变为“已停止”；控制台仅 memory-long-term.ts 的 POST /api/v1/memory/remember 500，无其他报错；coding-agent MCP 仍在运行
   根因：streamText 调用从未设置 max_tokens，模型用 provider 默认上限（通常 4096），生成长内容撞上限后流以 finish_reason:'length' 正常结束；xsai 对 'length' 不抛错、不告警，直接 resolveOnce()，performSend 的 finally 块执行 setSending(false) 让状态栏变“已停止”。随后的 rememberTurn 因 PostgreSQL 当时未就绪返回 500，是流结束后的次生现象，非中断原因
   证据链：
   - StreamOptions(llm.ts) 无 maxTokens 字段
   - llm-service.ts 的 streamText 只透传 chatConfig(仅 apiKey/baseURL)/abortSignal(chat 路径从未设置)/headers/messages/onEvent/stopWhen/tools，未传 max_tokens
   - provider 配置(openai/deepseek index.ts) 只有 apiKey+baseUrl，max_tokens 仅出现在 validator 的连通性测试(max_tokens:1)
   - xsai stream-text 无内部超时；chat.ts 无 AbortController；abortSignal 在 chat 路径从未被赋值
   - xsai requestBody 用 objCamelToSnake 把 maxTokens→max_tokens 透传给 provider(WithUnknown<T> 允许任意字段)，因此传 maxTokens 给 streamText 即可生效
   - FinishReason 类型含 'length'，onEvent 的 finish 分支对 length 走 resolveOnce() 静默结束
   修复：
   - llm.ts: StreamOptions 加 maxTokens?: number 字段
   - llm-service.ts: streamText 调用传 maxTokens: options?.maxTokens ?? 16384（Aider/Cursor/Continue.dev 生产默认值）
   - llm-service.ts: finish 事件中 finish_reason==='length' 时 console.warn 告警，截断不再隐形
   验证：core-agent typecheck 通过；75/75 单测通过；lint 无错误
   附注：PostgreSQL 用 Docker 容器 airi-pgvector(pgvector/pgvector:pg17) 运行，配置 POSTGRES_USER=airi / POSTGRES_PASSWORD=pazzw0rd123 / POSTGRES_DB=airi_memory，匹配 AIRI 默认连接串 postgresql://airi:pazzw0rd123@localhost:5432/airi_memory；Navicat 报 "No password supplied" 是连接配置密码留空所致，正确密码即 pazzw0rd123。schema 由 store.ts 首次连接时 migrateMemorySchema 自动建表 + CREATE EXTENSION vector/pgcrypto，无需手动建表

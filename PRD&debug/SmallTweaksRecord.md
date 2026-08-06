## 本轮改进总结

**改进缘由**
角色卡和指令原本混在长时记忆（PG/pgvector）里，依赖记忆网关生效——长时记忆不启用时这些关键指令就不会注入 LLM；且旧机制把 persona 写进历史首条消息，占用上下文预算、随窗口截断存在身份丢失风险。

**改进的地方**

1. **指令与记忆彻底解耦**

   - 新建 [instruction-store.ts](file:///e:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/modules/instruction-store.ts)：指令改用 localStorage 持久化，不依赖记忆网关，长时记忆关闭时照样生效；内置 ACT/DELAY/CALL 种子指令（幂等）。
   - [memory-long-term.ts](file:///e:/tools/scoop/buckets/airi/packages/stage-ui/src/stores/modules/memory-long-term.ts) 清掉全部指令逻辑，只保留语义记忆。
2. **注入方式改为"每轮重组"**

   - [chat-orchestrator-runtime.ts](file:///e:/tools/scoop/buckets/airi/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts)：每次发送由「角色卡 + 工具集 + 指令 + 记忆召回」现场组装 system 消息并**替换**（非追加），身份与指令每轮保证存在、不受上下文截断影响，上下文里永远只有一条 system 消息、无重复。
3. **独立"指令"设置大类**

   - 新增 [settings/instructions/index.vue](file:///e:/tools/scoop/buckets/airi/packages/stage-pages/src/pages/settings/instructions/index.vue) 路由页（`settingsEntry` + `order: 5.5` 紧跟记忆页）+ InstructionManager/InstructionEditor 组件，从记忆管理 UI 中移除指令入口。
4. **本轮收尾（i18n + 验证）**

   - 9 语言 `settings.yaml` 各补 42 个指令页 key，node 脚本验证全部解析通过。
   - 修复验证暴露的 4 处问题：pinia 误导入 `computed`、清理后残留未用变量、core-agent dist 类型过期（重建解决）、i18n key 层级缺 `modules` 段（按项目惯例修正）。
   - 单测 11/11 通过，本次改动文件 eslint 全绿；typecheck 中本次相关错误清零，剩余报错均为既有故障（apps/server 残留等），留作 repo-wide cleanup。


Docker 关了，长时记忆数据库无法连接，故而我还没有测试改进后是否存在新的问题。

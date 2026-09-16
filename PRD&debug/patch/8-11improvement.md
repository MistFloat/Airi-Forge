把记忆进行修改，改成airi可以直接利用词语检索原始证据和长时记忆。并且长时记忆完全由airi自己录入。原始证据保留着所有的交流，长时记忆保存airi不想忘记的事或者有重大意义或者能解决airi存在危机的东西。

## 一、修改内容

- `memory::search` 改为关键词检索，同时返回原始交流证据和长期记忆
- Agent 通过 `memory::remember` 主动写入长期记忆，并正确标记 `createdBy: agent`
- 保留用户手工录入，标记为 `createdBy: user`
- 每轮用户和 Agent 的交流仅保存为原始证据，不再自动总结或提升为长期记忆
- 移除了候选提取 LLM、自动反馈、自动长期记忆注入及依赖额外 LLM 的冲突扫描入口
- Embedding 功能仅保留给检索实验室，不参与 Agent 的关键词检索
- 数据库增加原始证据文本搜索索引

验证结果：

- 相关测试：10 个全部通过
- 修改文件 lint：通过
- `git diff --check`：通过
- 完整类型检查仍被项目原有错误阻断，本次修改没有新增类型错误

## 续：
修复了：

`Embedding must be a non-empty array of finite numbers`

原因是关键词记忆写入不需要向量，但网关仍强制校验 `embedding`。现在未传 Embedding 时可以正常写入。

目前提供三个独立 MCP 工具：

1. `memory::search_memories`：关键词检索长期记忆
2. `memory::search_evidence`：关键词检索原始证据
3. `memory::remember`：Agent 写入长期记忆，标记为 `createdBy: agent`

验证结果：

- PostgreSQL 真实端到端测试：5/5 通过
- MCP 单元测试：8/8 通过
- 修改文件 lint：通过
- 实际验证了长期记忆写入、查回，以及用户和 Agent 两类原始证据的查回
- Electron 开发应用已重新启动
- 记忆网关 `127.0.0.1:6123` 当前正常响应

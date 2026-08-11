# 长期记忆系统 PRD（第二版，精简修订）

- 状态：基于当前实现的下一阶段实施基线
- 日期：2026-08-03
- 适用范围：单用户 Electron 桌面应用
- 上一版：`long-termmemoryPRD.md`（保留，不覆盖）

## 1. 本版只解决什么

本版只解决三个已经观察到的问题：

1. 用户自然输入通常很长，真正决定长期记忆召回目标的可能只有一个短词或短语；直接编码整句会稀释检索意图。
2. 否定表达之间的 Embedding 相似度不稳定，不能只靠固定阈值发现冲突。
3. Confidence、Utility、Importance 已经存在，但不得继续扩展成难以解释、没有真实数据支持的复杂评分系统。

核心原则：

- Evidence 是事实来源，LLM 只提出结构化判断。
- 正式写入、状态变化、筛除、隔离和回滚由确定性代码执行。
- 当前表达优先于长期记忆；长期记忆只作为背景。
- 宁缺毋滥。无法可靠取得的信息不设置字段、不写占位值，也不由模型猜测后冒充事实。
- 优先复用现有表、Job 和审计结构；没有明确用途和真实数据来源时不增加字段。

## 2. 当前实现与实际缺陷

### 2.1 已经实现

- PostgreSQL/pgvector 的 Evidence、Claim、Canonical Memory、Instruction、Evidence Link、Feedback、Retrieval、Conflict、Embedding Schema、Job 和 Change Log。
- Evidence 去重、Claim Quote 定位、Fact Key、基础 Cardinality、事务晋升和人工冲突处理。
- `explicit | implicit | none` Assertion Mode。
- Explicit Claim 自动晋升；允许的少量隐式偏好可以低 Confidence 晋升。
- 相同 Fact Key 下的确定性冲突隔离。
- Canonical Memory 向量化、Active/Fallback Embedding Schema、Embedding Job 和向量召回。
- Recall Trace、反馈记录、Confidence/Utility 重算、Wrong/Outdated 状态变化。
- Electron 本地 Gateway，以及记忆管理、候选、治理和检索实验界面。
- Instruction 独立保存和确定性编译。

### 2.2 当前有缺陷或名义存在但没有闭环

- 当前聊天召回直接编码完整用户输入，没有分词、实词提炼或短查询召回；自然问题可能无法命中真正需要的背景知识。
- 当前检索实验已证明短词有效：查询“音乐”时，“Apple Music（positive）”和“Spotify（negative）”分别排在前两位，分数约为 `0.5296` 和 `0.4541`。这证明短词 Embedding 在当前模型和数据上足以产生有价值候选，但尚未接入真实聊天召回。
- 当前冲突实现主要依赖相同 Fact Key/Cardinality；`classify_conflict` Job 可以入队，但筛式邻居扫描和 LLM 批次分类 Worker 尚未实现。
- 当前 Predicate Registry 只有少量 Predicate；未知 Predicate 默认按 `single` 处理，可能把本可共存的集合值误判为冲突。这是现有实现缺陷，扩充 Registry 或改为保守隔离前不能宣称已安全覆盖。
- 当前自动反馈可以写入并重算 Utility，但缺少真实评估，不能证明 Utility 排序一定改善回答。
- 当前召回排序已经混入 Utility 和 Importance；它仍然简单，但尚未通过离线数据证明比纯相似度更好。
- 文档、图片和视频可以进入聊天上下文，但文档 Chunk、页码、视频时间位置到长期 Evidence 的完整溯源尚未闭环。
- Vision、Hearing、Tool 进入统一 Evidence、隐私暂停和残留缓冲清空尚未完成端到端验收。
- 管理页面已有核心操作，但 Worker 进度、失败原因、冲突批次内容和回滚影响预览仍不完整。
- Embedding Schema 和 Job 已存在，但生产级崩溃恢复、限流和大数据量覆盖率没有完成验证。

### 2.3 本版不假装已经实现

以下内容在代码和测试完成前只能写作待办：

- 中文分词器及其具体依赖。
- 分词后的聊天自动召回。
- 筛式冲突扫描 Worker。
- 批次全 Pair 的 LLM 冲突分类和输出校验。
- 冲突 Importance 自动分级。
- 自动反馈是否真正提升召回质量。
- 文档、Vision、Hearing、Tool 的完整长期 Evidence 流程。

## 3. 运行时优先级

```text
当前轮明确表达
> 当前会话明确上下文
> 用户手工确认的长期记忆
> 用户明确陈述形成的长期记忆
> 允许晋升的隐式偏好
> Tool、Vision 或模型推断
```

- 当前表达与长期记忆不一致时，本轮不把旧记忆作为确定背景注入。
- “这次、当前任务、在这个项目中”等局部表达只形成会话覆盖，不自动修改长期记忆。
- “现在、已经、以后、不再、换成”等可能表示长期变化的表达进入 Claim 和冲突流程；正式裁决前，本轮先服从当前表达。
- 无法判断是临时覆盖还是长期变化时，只服从本轮，不修改正式记忆。

### 3.1 主体与指令边界

- 只有原文能够明确归属于当前用户的 Fact、Preference 才能自动进入晋升流程。
- “我妹妹喜欢 Spotify”“张三对花生过敏”等第三方信息不得归入用户记忆。
- 当前 `assertion_mode` 继续使用 `explicit | implicit | none`，不新增枚举和迁移。
- 假设、引用、第三方陈述、角色扮演、无法确认主体的内容统一为 `none`，不自动晋升。
- Instruction 仍然只能由用户手工创建。LLM、文档、网页、Tool、Vision 和 Hearing 都不能自动创建持久 Instruction。

## 4. 基于分词的精简召回

### 4.1 设计结论

真实聊天召回优先使用短词或短语的 Embedding，不再默认只编码完整用户输入。

示例：

```text
用户输入：我想给你接入一个启用和控制音乐软件的 MCP，你能给我一个简单的流程吗？
分词与过滤：音乐、软件、MCP
用于个人背景召回：音乐、音乐软件
```

“流程、简单、可以”等泛化任务词没有个人记忆区分度，应被过滤。“音乐”已经在现有检索实验中证明可以把 Apple Music 和 Spotify 使用状态召回到前两位。

### 4.2 最小查询结构

不引入复杂 Query Planner，也不为尚未实现的数据增加字段。运行时只需要：

```ts
interface MemoryRecallQuery {
  originalText: string
  terms: string[]
}
```

- `terms` 最多保留 4 个去重后的实词或短语。
- 优先保留名词、专名以及相邻实词形成的短语。
- 中英文品牌名保持完整，例如 `Apple Music`、`Spotify`、`网易云音乐`。
- 否定词只有与对象共同组成短语时才保留；不能把“不使用 Spotify”降成表示相反含义的“使用 Spotify”。
- 分词器没有产生有效词项时，才使用 `originalText` Embedding 兜底。
- 不调用额外 LLM 改写查询；当前问题尚不足以证明需要为每轮聊天增加一次模型调用。

### 4.3 分词实现边界

- 采用支持中文词性和用户词典的分词实现；jieba 系实现是当前首选候选。
- 具体 npm 包尚未完成维护状态、许可证、Electron 体积和中英文混合行为检查，因此本 PRD 不宣称依赖已经选定或接入。
- 分词结果只存在于本轮运行时和现有 Retrieval 审计中；不新增永久“查询规划”字段。
- 停用词表和用户词典随代码版本管理。规则变化通过代码/Policy 版本追踪，不建立可长期为空的数据库列。

### 4.4 候选生成

```text
每个 term 使用当前 Active Embedding Schema 编码
→ 每个 term 取 Top 5
→ 按 memory_id 合并
→ 同一记忆保留最高 Similarity
→ 状态、有效期、Namespace、Scope、Confidence 过滤
→ 最多注入 5 条
```

- 所有 term 必须使用同一 Active Embedding Schema，禁止跨 Schema 比较分数。
- 不同时运行全文检索、Predicate 打分、LLM 改写、多模型混排和 MMR。
- 现有 Fact Key 命中可以作为零成本补充候选，但不增加新的综合评分公式。
- 第一阶段沿用当前简单排序；同时记录纯 Similarity 排序的离线对照。没有证据表明 Utility/Importance 修正有效时，不继续增加新权重。

### 4.5 注入

- 只注入 `active` 且 Confidence 非 0 的正式记忆。
- `quarantined`、`disputed`、`awaiting_user`、过期和归档记忆不注入。
- 同一 `single/temporal_single` Fact Key 最多注入一个当前有效值。
- 记忆以“可能相关的个人背景”注入，不伪装成当前用户指令。
- 默认注入规范化后的短 Claim，不注入完整 Evidence、文档段落或 Tool 输出。
- 每条实际注入的记忆继续写入现有 `memory_retrieval_items`；没有实际注入的候选不能标为已注入。
- Token 超限时按当前排序从尾部移除，不从中间截断文字，以免改变否定语义。

### 4.6 注入安全

- 当前表达与候选记忆冲突时，本轮不注入旧记忆作为确定事实。
- Canonical Memory 只能作为有边界的数据块加入 Prompt，不与系统指令、开发者指令或当前用户指令混排。
- 注入内容做长度限制和结构化转义，不能因为记忆中存在命令式文字而触发工具调用或状态变化。
- Tool、Vision、文档等来源在没有人工确认前不作为高风险事实注入。

## 5. 冲突发现

### 5.1 第一层：确定性结构化冲突

以下情况不需要 Embedding 或 LLM：

- 同 Fact Key、同 Value、相反 Polarity。
- `single` Predicate 同 Fact Key、不同 Value。
- `temporal_single` Predicate 的有效期重叠且 Value 不同。
- `set` Predicate 只在同一 Value 的 Polarity 相反时冲突。

命中后创建现有 `memory_conflicts`，新 Claim 进入 Quarantine。

### 5.2 第二层：筛式批次检查

用于发现 Predicate 提取错误、Alias 未覆盖、通用否定和标题不同但语义冲突等结构化规则没有覆盖的情况。

流程：

1. Worker 获取本次扫描的 Memory ID 快照，并建立内存中的“待作为扫描起点”集合。
2. 取第一个仍在集合中的 Memory ID，仅编码其规范化标题。
3. 在同一 Embedding Schema 的全部合格记忆中取相似度最高的 Top 3。必要时可配置到 Top 10，但默认不按 Importance 自动扩大。
4. 把当前记忆与所有邻居作为一个批次交给记忆 LLM；输入只包含已有的 ID、Title、Value、Polarity、Fact Key 和有真实值的有效期。
5. 批次有 `n` 条记忆时，LLM 必须返回全部 `n × (n - 1) / 2` 个无序 Pair，逐对分类为 `conflict | duplicate | compatible | unrelated | uncertain`。
6. 确定性代码检查 ID、Pair 数量、无重复、无缺失和枚举合法性。任一项不合法则整批无效，最多修复重试一次，且不能改变正式状态。
7. 只有与本批次其他所有记忆均为 `compatible` 或 `unrelated` 的记忆，才能从“待作为扫描起点”集合划去。
8. 涉及任何 `conflict`、`duplicate` 或 `uncertain` 的记忆不划去，并创建或复用现有 Conflict 记录。
9. 从下一个仍未处理的起点继续，直到集合为空。

### 5.3 “划去”的准确含义

这是筛式流程成立的必要约束：

- 划去只表示该记忆不再主动作为本次扫描的起点。
- 划去的记忆仍保留在后续所有 Seed 的 Top-K 邻居检索池中。
- 因此，后续记忆仍然可以把已划去记忆重新作为邻居送入 LLM。
- LLM 检查的是本批次所有记忆之间的全部 Pair，不是只判断邻居是否与当前项冲突。
- 本次划去不修改 Canonical Memory 状态，也不表示该记忆被永久证明“与所有记忆无冲突”。新的 Memory Revision、Embedding Schema 或扫描 Policy 可以触发重新扫描。

### 5.4 保守边界

- `uncertain` 永远不能被当作无冲突。
- LLM 无权直接指定划去对象；划去由确定性代码根据完整 Pair 结果计算。
- Top-K 只能减少候选数量，不能保证发现所有开放领域冲突；界面和文档不得宣称零漏检。
- 不跨 Embedding Schema 比较 Similarity。
- Registry 未定义的“没有任何过敏”与“海鲜过敏”等通用否定关系，可以由筛式 LLM 发现；只有在 Registry 明确配置后才升级为确定性结构化规则。

### 5.5 冲突处理

- 没有可靠 Importance 来源时，不让 LLM 猜测后直接丢弃记忆，统一进入 `awaiting_user`。
- 只有用户手工设置或 Predicate 固定策略能够确定 Importance 时，才允许使用现有 `normal/important/critical` 分类。
- Important/Critical 冲突必须询问用户；裁决前双方都不能作为确定事实注入。
- 普通冲突只有在当前用户原文含明确更新信号，且主体、Quote、Cardinality 和时间关系均可验证时，才允许自动结束旧值并采用新 Claim。
- 其他冲突保持 Quarantine 或 `awaiting_user`，不得为了减少询问而猜测谁正确。
- 不物理删除 Evidence 或冲突记忆。

### 5.6 Duplicate、集合与时间

- 新 Claim 与已有正式记忆同 Fact Key、同 Value、同 Polarity 时，不创建第二条正式记忆，只增加 Evidence Link 并重算 Confidence。
- 两条既有 Canonical Memory 是否合并必须由用户治理；MVP 不自动迁移 Evidence Link。
- Set Predicate 的普通肯定表达只增加明确值，不推测它是完整集合。
- 只有原文明确出现“只、全部、都不、除了、不再”等集合操作信号时，才允许提出 replace/remove/clear；无法校验时保持候选。
- Evidence 写入时间不能冒充事实生效时间。原文没有事实时间时，不自动关闭其他记忆有效期。
- 无法可靠解析主体、集合范围或时间关系时不新增字段、不填默认时间，保留 Evidence 和候选即可。

## 6. Confidence、Utility 与 Importance

### 6.1 Confidence

继续沿用当前已实现且可追溯的规则：

```text
用户手工确认：1.00
用户明确陈述：0.85
允许晋升的隐式偏好：0.45
无有效支持：0.00
```

```text
confidence = max(valid support_weight)
```

- Confidence 不是现实真值概率。
- 每个非零值必须能追溯到有效 Evidence Link 或人工确认。
- `NULL` 只允许出现在旧数据迁移或尚未完成首次聚合的短暂状态；新业务不依赖 `NULL` 表示未知。
- Wrong 的人工反馈使记忆失效；Outdated 表示过去可能正确但当前过期。两者都不删除 Evidence。
- 不增加贝叶斯累计、时间衰减或模型自报概率。

### 6.2 Utility

- 当前代码已经根据 Useful/Irrelevant Feedback 重算 Utility；继续保留，不新增字段。
- Utility 只表示历史召回是否有用，不表示事实真假。
- `unknown` 不更新 Utility。
- 当前没有足够评估证明 Utility 应影响在线排序，因此本版必须保留“纯 Similarity”对照；如果没有稳定收益，后续移除 Utility 排序修正，而不是增加公式。
- 自动反馈分类仍有误判风险；没有明确用户 Quote 时不得生成 Wrong/Outdated。

### 6.3 Importance

- Canonical Memory 当前已经使用 `[0,1]` 数值 Importance；本版不再引入另一套永久枚举字段。
- Conflict 表中现有的 `normal/important/critical` 只在数据来源可靠时填写。
- 可靠来源仅限用户手工设置和代码中固定的 Predicate Policy。
- 当前 Predicate Registry 尚未实现完整 Importance/Sensitivity Policy，因此自动冲突 Worker 在该策略完成前不得假装知道某条记忆是否 Critical。
- LLM 可以提出建议供界面参考，但没有固定策略或用户确认时不写入正式 Importance，也不能据此自动删除或覆盖记忆。

## 7. 数据与审计边界

只记录实际取得的信息：

- Confidence：Evidence Source、Assertion Mode、人工确认和 Evidence Link。
- Utility：带 Retrieval ID 的 Useful/Irrelevant Feedback。
- Relevance：本次实际执行的 term、Schema ID、Memory ID、Rank 和 Similarity。
- 冲突分类：本批次输入 ID、可取得的字段、模型标识、Prompt/Policy 版本、原始结构化输出、校验结果和最终状态变化。

不记录也不新增：

- 模型没有提供且无法验证的概率。
- 模型内部推理过程。
- 无法可靠解析的实体、领域、时间和 Importance。
- 只为了界面“看起来完整”而长期为空的字段。

优先使用现有 `memory_jobs.payload`、`memory_conflicts`、`memory_changes` 和 Retrieval 表。只有现有结构确实无法表达验收所需事实时，才新增迁移。

## 8. 后台任务

本版只新增一个实际任务类型：

```text
scan_conflict_batch
```

- 分词召回在聊天热路径运行，不建立 `plan_recall_query` Job。
- 一个扫描 Job 的 Key 由扫描快照、Embedding Schema 和代码内固定 Policy Version 组成。
- 扫描游标和待起点集合优先放在现有 Job Payload；不要预先增加独立数据库列。
- Job 使用现有 Lease、Attempts、Run After 和 Last Error。
- 同一 Job Key 不得并发成功两次；失败最多重试 3 次，之后留在管理界面，不阻塞聊天。

## 9. 最小界面改动

只增加能帮助验证系统的内容：

- 检索实验页显示分词结果、每个 term 的 Top-K、合并结果和实际注入结果。
- 冲突治理页显示批次成员、全部 Pair 分类、输出校验错误和最终状态。
- Job 页面显示扫描进度、失败原因和可重试状态。
- Confidence、Utility、Importance 只显示真实来源；来源缺失时显示“尚无可靠数据”，不显示虚构默认解释。

不新增复杂查询规划图、多模型分数面板或用户无法据此采取行动的字段展示。

## 10. 验收标准

### 10.1 分词召回

- 示例 MCP 输入能够提取“音乐”或“音乐软件”。
- 已有 Apple Music positive、Spotify negative 时，两者进入候选集且否定语义不丢失。
- 中英文品牌名保持完整。
- 停用词不产生大量无关候选。
- 无有效词项时回退原句，不阻塞聊天。
- Retrieval Trace 能区分 term 候选、过滤结果和实际注入，不能只写“召回成功”。

### 10.2 冲突扫描

- 一个包含 4 条记忆的批次必须返回且只返回 6 个无序 Pair；缺少、重复或包含未知 ID 时整批失败。
- 只有与批次内其他所有记忆均为 `compatible/unrelated` 的记忆才能从待起点集合划去。
- 已划去记忆仍可被后续 Seed 作为 Top-K 邻居重新选中。
- `conflict/duplicate/uncertain` 不被划去，并产生幂等 Conflict 记录。
- “用户不对任何事物过敏”与“用户海鲜过敏”应进入同一批次并由 LLM 检查；如果 Top-K 没有把它们放入同一批次，测试必须明确记录为候选发现失败，不能伪报冲突分类成功。
- Worker 中断后可以从现有 Job 状态继续，不重复创建 Conflict。

### 10.3 保守写入

- 假设、转述、第三方事实和主体不明内容为 `none`，不自动晋升。
- 未登记 Predicate 在修复默认 `single` 缺陷前不得自动晋升可能的多值事实。
- 当前表达与长期记忆冲突时，本轮不注入旧记忆作为确定事实。
- 无明确更新信号或时间关系时不自动选择冲突赢家。
- 没有可靠 Importance 来源时不填写冲突 Importance，也不自动丢弃记忆。
- 任意 Confidence 非零值都可追溯；Useful/Irrelevant 不改变 Confidence；Wrong/Outdated 不删除 Evidence。

## 11. 实施顺序

1. 为“音乐”实验、自然 MCP 输入、否定、中文品牌和无关词建立固定离线用例。
2. 选定并接入中文分词依赖，实现最多 4 个有效 term 和原句兜底。
3. 将 term Embedding 召回接入聊天，补齐 Retrieval Trace 和纯 Similarity 对照。
4. 修复未知 Predicate 默认 `single` 的现有缺陷；无法确定 Cardinality 时保守隔离。
5. 实现 `scan_conflict_batch`，完成批次全 Pair Prompt、严格校验和“只移除扫描起点”的集合语义。
6. 完成 Conflict 幂等写入、Worker 续跑和人工治理页面。
7. 用真实评估决定是否保留 Utility/Importance 排序修正；没有稳定收益就删除修正，不增加新公式。
8. 最后再推进文档、Vision、Hearing、Tool Evidence 和隐私验收；这些不是本版召回与冲突修复已经完成的内容。

## 12. 明确不承诺

- 分词或 Embedding 能理解所有隐含个人需求。
- Top-K 能发现全部开放领域冲突。
- LLM 冲突分类永不误判。
- Confidence 是事实正确概率。
- 当前 Importance 已经能够自动可靠分级。
- 自动反馈已经被证明能改善召回。
- 本版已经完成文档、Vision、Hearing 和 Tool 的长期 Evidence 闭环。
- 为追求表面完整而填充无法取得的信息。

本版成功标准只有三个：短词能够让自然输入召回真正相关的个人背景；批次 LLM 检查全部 Pair 后由确定性代码执行筛式流程；任何无法可靠取得的信息都不进入正式字段和自动裁决。

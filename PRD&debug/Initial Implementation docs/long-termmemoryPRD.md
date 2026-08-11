# AIRI 长期记忆系统 PRD（第一版）

- 状态：第一版技术实施基线（修订 1）
- 日期：2026-08-02
- 适用范围：AIRI 单用户 Electron 桌面应用
- 核心原则：字段克制、证据优先、LLM 仅提议、确定性代码裁决、变更可审计回滚

本文是后续实现和验收依据。文中的功能必须有明确输入、持久化位置、执行者、失败行为和验收方法；无法稳定实现的能力不会以承诺形式写入。

先澄清一个论文细节：你引用的论文确实论证了余弦相似度受归一化、各向异性、高维 Hubness、未校准等因素影响，不能直接等同于语义关系；但它本身并不是一篇专门针对 BGE 否定句开展完整矛盾实验的论文。因此，“高余弦值反而可能是潜在矛盾”的方法可以采用，但应把它定位为候选发现启发式，而不是论文已经证明的通用定律。[论文页面](https://arxiv.org/abs/2504.16318)

Memoria 的反馈、隔离、溯源和运维 API 分层值得借鉴；完整分支式分布式架构则没有必要照搬。[Memoria 项目](https://github.com/matrixorigin/Memoria)

其他可借鉴但不直接引入的实现：

- [LangMem](https://github.com/langchain-ai/langmem)：证明记忆提取、整合可以作为后台任务运行，而不阻塞聊天热路径。
- [Mem0](https://github.com/mem0ai/mem0)：提供事实/偏好提取和单条记忆历史，验证“当前值与变更历史分离”的可行性。
- [Zep / Graphiti](https://github.com/getzep/graphiti)：采用 Episode、原子事实、有效时间和失效而非物理删除，支持本文的证据层与时间语义设计。

这些项目主要用于验证工程模式。AIRI 不引入独立 Python 服务、图数据库、MatrixOne、完整 Git 分支或多 Agent 分布式协调。

## 一、最终产品定位

AIRI 的长期记忆将不是 Memoria 那种“多 Agent 共享的 Git 数据库”，而是：

> 面向单个用户、围绕个人事实和偏好、能够解释“为什么记住”、能够发现错误并请求用户确认的个人记忆系统。

需要实现：

- 原始证据长期保留。
- Fact/Preference 自动候选提取。
- 候选转正由确定性策略控制。
- 低置信度隔离。
- 反馈影响后续检索和置信度。
- 冲突候选自动发现。
- 便宜 LLM 判断冲突关系和重要性。
- 重要且无法自动解决的冲突交给用户。
- 每次变更可审计、可撤销。
- Embedding 可以重建，不影响文字证据。
- Instruction 只能手工创建。
- Vision、文档、Tool、聊天都进入统一 Evidence 入口。
- 不引入 Memoria 那种完整分支式分布式架构。

---

## 二、先削减字段，而不是继续增加字段

你提出的“数据库信息量应该大于字段负担”是非常重要的约束。

上一版设计最大的问题是把：

- 原始观察。
- LLM判断。
- 检索参数。
- 状态。
- 时间。
- 审计。
- 展示信息。

全部试图放在同一条 Memory 上。这样会出现大量看起来严谨、实际只能填默认值的字段。

新方案保留九张职责单一的业务表：

```text
memory_evidence
memory_claims
canonical_memories
memory_instructions
memory_evidence_links
memory_feedback
memory_retrievals
memory_retrieval_items
memory_conflicts
```

附加五张基础设施表：

```text
memory_embeddings
embedding_schemas
embedding_schema_state
memory_changes
memory_jobs
```

这些表分别表示原始观察、LLM提议、当前正式记忆、人工永久指令、证据关系、反馈事件、召回批次、批次中的具体记忆和冲突关系。它们不是为了追求“表多”，而是避免把不同生命周期的数据塞入同一行后相互覆盖。`memory_retrievals` 与 `memory_retrieval_items` 记录哪一轮实际向 LLM 注入了哪些记忆，是自动反馈和效果审计不可缺少的事实来源。

不会再建立大量 Entity、Predicate、Snapshot 独立表。第一版将这些能力压缩成明确字段和 JSON 审计记录，只有评测证明需要时再拆表。冲突对已经由最小的 `memory_conflicts` 关系表承担独立生命周期。

字段约束：

- 无法从真实事件获得的值使用 `NULL`，禁止为了完整率填默认日期、默认来源或伪置信度。
- 每个非空字段必须能指出产生它的事件或策略版本。
- `metadata/model_info/before/after` 可以使用 JSONB，但必须按 Source Type 或 Operation 在 TypeScript/Valibot 边界校验，不能成为任意垃圾桶。
- 管理界面默认显示语义信息，不按数据库列逐项暴露。
- 统计计数优先从不可变事件聚合；只有性能测量证明必要时才增加可重建缓存列。

### 数据库必须执行的唯一性约束

幂等不能只写在业务代码里，PostgreSQL 必须提供最后防线：

```text
memory_evidence:
  UNIQUE(namespace, source_type, source_id, content_hash)

memory_claims:
  UNIQUE(evidence_id, schema_version, claim_hash)
  CHECK(status IN ('proposed', 'validated', 'quarantined', 'promoted', 'rejected'))
  CHECK(polarity IN ('positive', 'negative'))
  CHECK((status = 'promoted') = (promoted_memory_id IS NOT NULL))

canonical_memories:
  CHECK(status IN ('active', 'quarantined', 'disputed', 'superseded',
                   'expired', 'archived', 'stale'))
  CHECK((kind = 'summary' AND polarity IS NULL)
        OR (kind IN ('fact', 'preference') AND polarity IN ('positive', 'negative')))
  CHECK(kind = 'summary' OR status <> 'stale')

memory_feedback:
  UNIQUE(source, source_event_id, memory_id)

memory_evidence_links:
  CHECK((relation = 'supports' AND evidence_id IS NOT NULL)
        OR (relation = 'derived_from' AND evidence_id IS NULL))
  UNIQUE(memory_id, claim_id, evidence_id, relation) WHERE evidence_id IS NOT NULL
  UNIQUE(memory_id, claim_id, relation) WHERE evidence_id IS NULL

memory_conflicts:
  CHECK(status IN ('open', 'classified', 'awaiting_user', 'resolved', 'dismissed'))
  CHECK((right_memory_id IS NOT NULL) <> (candidate_claim_id IS NOT NULL))
  UNIQUE(left_memory_id, candidate_claim_id) WHERE candidate_claim_id IS NOT NULL
  UNIQUE(least(left_memory_id, right_memory_id), greatest(left_memory_id, right_memory_id))
    WHERE right_memory_id IS NOT NULL

memory_embeddings:
  UNIQUE(memory_id, schema_id)
  CHECK(build_status IN ('pending', 'ready', 'failed'))

embedding_schemas:
  UNIQUE(namespace, schema_version)
  UNIQUE(namespace, id)
  CHECK(status IN ('building', 'ready', 'failed', 'archived'))

embedding_schema_state:
  FOREIGN KEY(namespace, active_schema_id) REFERENCES embedding_schemas(namespace, id)
  FOREIGN KEY(namespace, fallback_schema_id) REFERENCES embedding_schemas(namespace, id)
  CHECK(fallback_schema_id IS NULL OR active_schema_id IS NOT NULL)
  CHECK(active_schema_id IS NULL OR fallback_schema_id IS NULL
        OR active_schema_id <> fallback_schema_id)

memory_jobs:
  CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'))
  UNIQUE(job_key)
```

所有权威关联外键统一使用 `ON DELETE RESTRICT`，包括 Claims→Memories、Evidence Links、Conflicts、Feedback、Retrieval Items、Embeddings 与 Schema State。第一版通过状态迁移、Revision 和回滚处理生命周期，不级联删除证据或审计依据。

写入全部使用事务和 `ON CONFLICT` 明确处理。应用崩溃、重复回调和 Worker 重试不能绕过这些约束。

---

## 三、Evidence：原始证据层

```text
memory_evidence
```

最小字段：

```text
id
namespace
source_type
source_id
content
content_hash
content_normalization_version
observed_at
metadata
created_at
```

其中：

- `source_id` 可以是 Message ID、Tool Call ID、文件 Hash 或视觉帧组 ID。
- `metadata` 保存来源特有信息，不把所有来源可能拥有的属性都变成数据库列。

例如：

```json
{
  "sessionId": "session-123",
  "role": "user",
  "fileName": "notes.pdf",
  "mimeType": "application/pdf",
  "page": 7
}
```

### Source Type

```text
user_assertion
assistant_output
tool_result
document_text
vision_observation
manual_entry
legacy_conversation
```

音频识别后的用户文字仍是 `user_assertion`，但 Metadata 会注明：

```json
{
  "inputMode": "speech",
  "transcriptionProvider": "mimo",
  "transcriptionModel": "mimo-v2.5-asr"
}
```

### 文档上传如何接入

你新增的拖放和聊天附件会进入统一入口：

#### 文本文档

```text
文件
→ 文本解析
→ 分段
→ 每段保存为 document_text Evidence
→ 提交给意识 LLM
→ 允许生成 Fact/Preference Candidate
```

#### 图片、视频

```text
媒体文件
→ Vision LLM
→ 视觉描述保存为 vision_observation Evidence
→ 默认低信任
→ 不直接转正
```

#### 原始文件保存策略

PostgreSQL 不保存大型文件二进制。

只保存：

- 文件名。
- MIME Type。
- 文件 Hash。
- 本地文件引用。
- 提取文本。
- 页码/时间戳。
- 解析器版本。

目的：

- 不让 PostgreSQL 膨胀成文件仓库。
- 同一个文件重复拖入时可以通过 Hash 去重。
- Fact 可以追溯到具体文件页码或视频时间点。
- 文件解析规则升级后可以重新提取。

---

## 四、Claim：LLM 候选层

```text
memory_claims
```

字段缩减为：

```text
id
evidence_id
kind
assertion_mode
fact_key
value
polarity
importance_hint
evidence_quote
quote_start
quote_end
normalized_quote
claim_hash
valid_from
valid_until
status
promoted_memory_id
model_info
schema_version
predicate_registry_version
content_normalization_version
revision
created_at
```

其中：

```text
kind = fact | preference
assertion_mode = explicit | implicit | none
status = proposed | validated | quarantined | promoted | rejected
```

`claim_hash` 是规范化后的 `kind + assertion_mode + fact_key + value + polarity + valid_from + valid_until + quote_start + quote_end` 按固定字段顺序序列化后的 SHA-256，仅用于幂等和索引；原始 Quote 仍保留在独立字段中。Offset 只有通过原文/规范化映射校验后才参与 Hash，避免同一引用仅因空白形式不同而重复，也避免对任意长度文本建立脆弱的 B-tree 唯一索引。

`importance_hint` 只保存 LLM 的四档建议，晋升时必须经过 Predicate Registry 的 Min/Max Clamp；它不直接成为 Canonical Memory 的最终 Importance。

Claim 状态只表示“模型提取结果是否通过审核以及是否完成晋升”，绝不表示事实当前是否有效：

- `proposed`：模型刚产生，尚未完成确定性校验。
- `validated`：Schema、Quote、Predicate、来源与敏感策略均通过。
- `quarantined`：候选存在风险，需要人工确认或等待冲突处理。
- `promoted`：已晋升，`promoted_memory_id` 必须非空并唯一指向正式记忆。
- `rejected`：候选不合法或策略拒绝，不能晋升。

`promoted_memory_id` 是 Claim 到 Canonical Memory 的明确所有权关系。晋升必须在同一 PostgreSQL 事务中创建/更新 Canonical Memory、写 Evidence Link、设置该字段并追加 Change Log；其中任何一步失败都会整体回滚。

一个 Claim 最多指向一个 Canonical Memory；多个表达同值的 Claim 可以共同指向同一个 Memory，形成多条可追溯支持证据。该字段不是一对一唯一键。

不再拆出大量 Subject、Predicate、Object Type 字段。

统一使用：

```text
fact_key
value
```

例如：

```text
fact_key = user/residence_city/global
value = 上海
```

```text
fact_key = user/favorite_music/global
value = 爵士乐
```

`fact_key` 本身已经包含：

```text
subject / predicate / scope
```

这能显著降低人类理解成本。

### Predicate Registry 与 Fact Key 规范化

Fact Key 不能依赖 LLM 自由命名。第一版在 TypeScript 中维护一个版本化、可测试的 Predicate Registry；设置与后台任务只能读取已加载版本，不能由 Agent 动态修改。

```ts
interface PredicateDefinition {
  aliases: string[]
  allowedKinds: Array<'fact' | 'preference'>
  cardinality: 'set' | 'single' | 'temporal_single'
  implicitPromotion: boolean
  key: string
  maxImportance: 'critical' | 'important' | 'normal' | 'trivial'
  minImportance: 'critical' | 'important' | 'normal' | 'trivial'
  sensitivity: 'high' | 'normal'
  valueAliases?: Record<string, string>
  valueNormalizer: 'boolean' | 'casefolded_text' | 'date_iso' | 'number' | 'text'
  valueType: 'boolean' | 'date' | 'number' | 'string'
}
```

示例：

```yaml
version: predicate-v1
predicates:
  residence_city:
    aliases: [current_city, living_city]
    allowedKinds: [fact]
    cardinality: temporal_single
    implicitPromotion: false
    valueType: string
    valueNormalizer: text
    valueAliases: {上海市: 上海, 北京市: 北京}
    sensitivity: high
    minImportance: important
    maxImportance: important
  birth_date:
    aliases: [birthday, date_of_birth]
    allowedKinds: [fact]
    cardinality: single
    implicitPromotion: false
    valueType: date
    valueNormalizer: date_iso
    sensitivity: high
    minImportance: important
    maxImportance: critical
  favorite_music:
    aliases: [preferred_music, music_preference]
    allowedKinds: [preference]
    cardinality: set
    implicitPromotion: true
    valueType: string
    valueNormalizer: casefolded_text
    sensitivity: normal
    minImportance: normal
    maxImportance: important
```

规范化流程：

```text
解析 subject / predicate / scope
→ subject、scope 只允许已知枚举
→ predicate 转小写 snake_case
→ Registry Key 精确匹配
→ 未命中则查 Alias Map
→ 校验 kind、valueType 和 scope
→ 使用 Registry 指定的 Value Normalizer 与 Value Alias
→ 生成规范 Fact Key
```

Normalizer 由纯 TypeScript 实现并带版本化测试。日期只有在能无歧义解析为 ISO 日期时才规范化；无法确定的 Value 进入 Quarantine，不让 LLM用自由解释替代类型校验。

未登记 Predicate 使用 `custom_{normalized_slug}` 作为 Predicate 段，例如 `user/custom_current_city/global`，保持 Fact Key 三段结构，并强制：

- `implicitPromotion = false`。
- 不进入结构化冲突自动裁决。
- 不自动晋升为 Important/Critical 记忆。
- 进入 Quarantine，用户可以把该 Claim 映射到现有 Predicate 后重新处理；第一版不允许运行时创建新 Predicate。

每条 Claim 和 Canonical Memory 保存 `predicate_registry_version`。第一版 Registry 作为随应用发布的不可变 TypeScript 数据模块存在，已被数据库行引用的旧版本继续随代码保留；增加 Predicate/Alias 必须发布新版本。Registry 升级通过后台迁移 Job 重新规范化候选，不在读取时静默改变已有 Fact Key，也不要求设置页面改写源码。

应用启动时编译 Registry 为 Key Map 和 Alias Map，并校验 Key/Alias 不重复、Min 不高于 Max、Value Type 与 Normalizer 匹配。校验失败时禁用自动提取并在设置页显示错误，不能带着不确定 Registry 继续写库。已发布的 Registry Version 不原地修改；规则变化创建新 Version。

### 基数策略

- `single`：同一 Namespace + Fact Key 只能有一个当前 Active Value；不同值视为纠正或冲突，不因时间自动共存，例如生日。
- `temporal_single`：同一有效时间区间只能有一个 Active Value，不重叠区间可以保留历史，例如居住城市。
- `set`：多个不同 Value 可以同时 Active；同值去重，明确否定某个值时只处理该集合成员，例如喜欢爵士乐和古典乐可以共存。

基数是结构化冲突算法的前置条件，不是后续排序优化。

基数不能只靠先查后写，否则两个 Worker 可能同时看到“没有当前值”并各自晋升。所有会创建、激活、过期或合并 Canonical Memory 的路径必须在一个事务中：

```text
→ 先获取 namespace 的 Embedding/Schema Advisory Transaction Lock
→ 再获取 namespace + normalized_fact_key 的 Fact Advisory Transaction Lock
→ SELECT 同键的非终态 Canonical Memory FOR UPDATE
→ 使用 Claim 保存的 Predicate Registry Version 读取 Cardinality
→ 在锁内重新执行同值去重、集合成员和时间区间校验
→ 写 Canonical Memory、Claim.promoted_memory_id、Evidence Link、Conflict 与 Change Log
```

Advisory Lock 使用稳定的 64 位哈希键；哈希碰撞最多造成无害的额外串行化，不能绕过数据校验。全系统锁顺序固定为 `Namespace Schema Lock → 按键排序的 Fact Lock → 按 Entity Type/ID 排序的 Row Lock`；跨 Key 合并和批量回滚也按规范 Fact Key 排序后取锁，禁止反序获取。`single` 与 `set` 的约束由此事务状态机保证；`temporal_single` 把任一未知起止时间视为“无法证明不重叠”，因此不会自动并存。Predicate Registry 是版本化 TypeScript 策略，数据库迁移不需要为每个 Predicate 动态创建不同的表约束。

### LLM的职责

便宜 LLM只负责：

1. 判断 Evidence 是否包含值得长期保存的信息。
2. 判断它是用户明确陈述、隐式偏好，还是不构成记忆。
3. 把长内容拆成互相独立、可以分别判真和失效的原子 Claim。
4. 生成 Fact/Preference Candidate。
5. 输出 Fact Key 和 Value。
6. 只提取原文明确表达的时间；不确定则返回 `null`。
7. 提取肯定、否定或撤回关系。
8. 为每个 Claim 引用原文证据。
9. 对潜在矛盾对分类。
10. 给出重要性候选，并判断冲突是否值得打扰用户。

它不能：

- 创建 Instruction。
- 直接写 Canonical Memory。
- 自己覆盖旧记忆。
- 自己删除 Evidence。
- 自己决定最终 Confidence。
- 自己调用重建索引或调参 API。

### 明确陈述与隐式偏好的操作性定义

这项判断不能靠正则完整实现，交给便宜 LLM，但必须使用固定定义和结构化枚举：

- `explicit`：用户直接把命题作为事实或偏好表达出来，不需要根据行为、语气或上下文推测。例如“我住在上海”“我喜欢爵士乐”“我不喜欢长回答”。否定句仍可属于明确陈述。
- `implicit`：原文没有直接声明偏好，只有从用户反复要求、选择或行为中才能推断。例如用户只说“再短一点”，可产生“偏好简短回答”的隐式候选。
- `none`：闲聊、假设、引用他人、问题、讽刺、角色扮演内容，或无法确定陈述主体时，不生成候选。

LLM 的分类不是最终裁决。确定性代码仍验证 Source Type、引用片段、Fact Key、敏感策略、时间字段和允许晋升的类型。

---

## 五、结构化输出

记忆提取模型使用独立配置：

```text
Provider
Model
API Key（复用 Provider 配置）
Temperature
Max Tokens
```

强制 JSON Schema，返回：

```json
{
  "claims": [
    {
      "kind": "fact",
      "assertionMode": "explicit",
      "factKey": "user/residence_city/global",
      "value": "上海",
      "polarity": "positive",
      "validFrom": null,
      "validUntil": null,
      "evidenceQuote": "我现在住在上海",
      "importanceHint": "normal"
    }
  ]
}
```

一个 Evidence 可以返回零到多个 Claim。长文本必须拆成原子 Claim，不能把整段摘要作为一个不可分割的 Fact。例如：

```text
“我现在住在上海，喜欢爵士乐，但已经不再使用 Spotify。”
```

必须拆成：

```text
user/residence_city/global = 上海
user/favorite_music/global = 爵士乐
user/uses_service/global = Spotify, polarity=negative
```

每一条都保存自己的 `evidenceQuote`，之后可以独立失效或被纠正。

确定性校验：

- `kind` 只能是 Fact/Preference。
- `assertionMode` 只能是 `explicit/implicit/none`；`none` 不落入 Candidate 表。
- Fact Key 必须符合三段式格式。
- Quote 必须能通过原文 Offset 或版本化规范化映射回 Evidence。
- 空字符串不能通过。
- 无法确定的时间必须是 `null`。
- 不允许模型自行补充当前日期作为 Valid From。
- Instruction 类型直接拒绝。
- 敏感内容进入隔离或忽略。
- 相同 Evidence + 提取 Schema Version 不重复处理。
- 单条 Claim 的 Value 超过配置长度时拒绝，改为继续拆分或只保留 Evidence。
- LLM 返回无法解析、字段越界或 Quote 不存在时，整个响应不直接写正式记忆；合法 Claim 可以逐条接收，非法 Claim 记录拒绝原因。

### 实际调用流程

```text
Evidence 到达
→ 确定性敏感信息扫描
→ 命中禁止策略则停止提取或只保存脱敏 Evidence
→ 后台任务调用便宜 LLM
→ LLM 判定 explicit / implicit / none 并原子化
→ JSON Schema 校验
→ Evidence Quote Offset/规范化映射校验
→ Fact Key 规范化
→ 时间和来源校验
→ 写入 Candidate
→ 进入自动晋升状态机
```

聊天请求不等待这个流程。提取失败只会留下可重试 Job，不影响当前回复。

### Evidence Quote 定位算法

仅用字符串子串校验无法稳定处理 OCR、CRLF、Unicode 和全角半角差异。第一版采用以下可实现流程：

1. Evidence 永久保存原始 `content` 和 `content_normalization_version`。
2. LLM 返回 Quote，可选返回它认为的 Offset；Offset 不能直接信任。
3. 代码先在原文中查找完全一致且唯一的 Quote，成功后计算 `quote_start/quote_end`。
4. 完全匹配失败时，使用版本化规范化函数生成带“规范化位置 → 原始位置”映射的文本。第一版规范化为 Unicode NFKC、CRLF 转 LF、连续空白折叠。
5. `normalized_quote` 在规范化文本中唯一匹配时，通过位置映射恢复原始 Offset。
6. 出现零个或多个候选位置且无法由文档 Chunk 位置消歧时，Claim 拒绝或进入 Quarantine，不能伪造 Offset。

`quote_start/quote_end` 统一采用 JavaScript UTF-16 Code Unit 的半开区间 `[start, end)`，由 TypeScript 验证；不能混用 PostgreSQL 字符位置或 Unicode Code Point 下标。Normalization 模块必须包含中英文、Emoji、组合字符和 CRLF 的固定测试。

文档 Evidence 的 Metadata 必须保存：

```text
document_id
chunk_id
page（可空）
source_char_start
source_char_end
```

图片/视频 Observation 则保存 Frame ID 或时间区间。这样管理界面可以从 Claim 跳回真实文档位置，而不是只展示一段可能无法定位的引用。

---

## 六、Canonical Memory：正式记忆

```text
canonical_memories
```

最小字段：

```text
id
namespace
kind
fact_key
value
polarity
predicate_registry_version
status
confidence
importance
valid_from
valid_until
revision
created_at
updated_at
```

`kind` 第一版只允许：

```text
fact
preference
summary
```

Instruction 不再与 Canonical Fact 共用一行结构。它的优先级、Scope、Rule Key 和生效规则与事实完全不同，继续混表会产生大量对 Fact 无意义的空字段。因此迁移到独立 `memory_instructions`：

```text
id
namespace
title
content
scope
priority
rule_key
status
effective_from
effective_until
revision
created_at
updated_at
```

Instruction 不含 Confidence、Importance、Embedding、Evidence Link，也没有任何自动写入 API；修改历史仍统一进入 `memory_changes`。

状态：

```text
active
quarantined
disputed
superseded
expired
archived
stale
```

字段目的：

- `fact_key`：判断是不是同一类事实。
- `value`：保存具体值。
- `polarity`：Fact/Preference 保存该 Value 是肯定还是否定，第一版只允许 `positive/negative`；不能在晋升时丢掉 Claim 的否定语义。Summary 不表达单一命题，因此为 `null`。
- `confidence`：证据支持强度，不是真实概率。
- `importance`：决定是否值得检索、是否值得打扰用户。
- `valid_from/until`：处理时间变化。
- `status`：不直接删除不确定或旧事实。

`stale` 只用于 Summary 等派生记忆，表示其组成 Claim 已变化、等待后台重建；Fact/Preference 不使用该状态。

只有 Canonical Memory 使用 `active/disputed/quarantined/superseded/expired/archived/stale`。冲突分类和回滚修改的是 Canonical Memory 的状态与 Revision；Claim 不会被设置为 Active、Disputed 或 Expired。

其余来源、反馈和修改历史全部放关联表，不再重复塞入 Canonical Memory。

### 三套状态机的边界

| 实体 | 状态回答的问题 | 合法主路径 |
|---|---|---|
| Claim | “这条 LLM 提议是否通过审核、是否已经晋升？” | `proposed → validated/quarantined/rejected → promoted` |
| Canonical Memory | “这条正式记忆现在能否被召回？” | `active ↔ disputed/quarantined → superseded/expired/archived`；Summary 可使用 `stale → active` |
| Conflict | “这组潜在矛盾处理到哪一步？” | `open → classified → awaiting_user/resolved/dismissed` |

已 Promoted Claim 即使对应 Memory 后来 Expired/Superseded，也保持 Promoted，因为“它曾经晋升过”仍然是真实审计事实。只有用户明确回滚原晋升事务时，当前 Claim 状态才恢复到晋升前状态；历史事实由 Change Log 保留。重新提取产生新 Claim，不能把三套状态互相同步复制。

---

## 七、证据关系不再使用数组字段

不会继续依赖：

```text
source_message_ids[]
```

正式记忆与证据通过关系记录连接。

可以将关系存在 `memory_changes` 或建立一个很小的关联表：

```text
memory_evidence_links
```

字段只有：

```text
id
memory_id（非空）
claim_id（非空）
evidence_id（可空）
relation
revision
created_at
```

`relation`：

```text
supports
derived_from
```

约束：

```text
relation = supports:
  memory_id NOT NULL
  claim_id NOT NULL
  evidence_id NOT NULL

relation = derived_from:
  memory_id NOT NULL
  claim_id NOT NULL
  evidence_id IS NULL
```

`supports` 连接正式 Fact/Preference 与产生它的 Claim/Evidence；`derived_from` 连接 Derived Summary 与组成它的 Atomic Claim。矛盾关系只保存在 `memory_conflicts`，不再让 Evidence Link 同时承担冲突生命周期。

目的：

- 一条 Fact 可以追溯多条证据。
- 一条 Evidence 可以支持多个 Fact。
- 可以直接查出“为什么记住这件事”。
- 某条 Evidence Link 被撤回、对应 Claim/Memory 被隔离，或支持关系被修正后可以重新计算 Confidence；原始 Evidence 本身仍不被自动改写。
- 管理界面不需要把一大串 ID 塞在一个字段里展示。

这是证据溯源所需的最小关联表；它保存关系，不复制 Evidence 或 Memory 正文。

---

## 八、自动转正算法

所有用户语言先执行统一顺序：

```text
敏感策略校验
→ LLM 判断 explicit / implicit / none
→ 结构化与 Evidence Quote 校验
→ 来源与 Fact Key 校验
→ 时间校验
→ 冲突预检查
→ 按 assertion_mode 执行晋升策略
```

不能在敏感校验之前把原文送入记忆提取模型；如果用户为提取模型配置的是远程 API，这条顺序尤其重要。

### 1. 用户明确陈述 `explicit`

例如：

```text
我住在上海。
我喜欢爵士乐。
我不喜欢特别长的回答。
```

LLM 判定为 `explicit`，并通过以下校验后自动转正：

- Evidence 来源是用户。
- 引用文本存在。
- Fact Key 合法。
- Value 非空。
- 没有触发敏感策略。
- 没有高风险冲突。

转正后的初始 Confidence 来自“明确用户陈述”的固定策略权重，不采用 LLM 输出的置信度。若同 Fact Key 已存在不同 Value，则先进入冲突流程，不直接覆盖。

### 2. 用户隐式偏好 `implicit`

例如连续多次要求：

```text
短一点。
不要解释那么多。
直接给结果。
```

第一版不再依赖“独立支持证据数”。要在大量历史中寻找语义上相互支持的证据，不仅成本高，而且会重新引入难以解释的相似度判断。

LLM 判定为 `implicit` 后，满足以下条件即可转正，但使用低于明确陈述的初始 Confidence：

- 只能是 `preference`，隐式 Fact 不自动转正。
- Evidence Source 必须是用户输入，不能来自助手推断。
- Evidence Quote 必须存在。
- Fact Key 必须属于允许自动学习的低风险偏好集合，例如回答长度、表达风格和内容呈现方式。
- 医疗、身份、地址、财务、关系等高风险 Predicate 即使被判为隐式也只能隔离等待人工确认。
- 没有相反的 Active Preference。

隐式偏好转正后可以参与召回，但在 Prompt 中标记为“推断偏好”，不能表述成用户亲口确认的事实。后续自动反馈为 `wrong/outdated` 时立即隔离；用户在管理页面确认后升级为人工确认。

这样既保留个性化学习能力，也不需要实现不可靠的“全库寻找独立支持证据”算法。

### 3. Tool Result

可以生成 Candidate。

“可信工具”由版本化 Tool Memory Policy Allowlist 定义，不能由 Tool 名称猜测：

```ts
interface ToolMemoryPolicy {
  allowedFactKeys: string[]
  autoPromote: boolean
  redactFields: string[]
  toolId: string
  trustLevel: number
  ttlSeconds?: number
}
```

`trustLevel` 必须位于 `[0, 1]`，只是该工具允许产生长期记忆时的初始证据权重；它不是调用次数，也不是模型概率。Policy 编译器同时验证 Tool ID 唯一、Allowed Fact Key 已登记、Redact Field 路径合法，以及 `autoPromote=true` 时 Allowlist 非空。验证失败的整版 Policy 不加载，Tool Result 退回“只保存 Evidence/Candidate、禁止自动晋升”的安全行为。

Policy 示例：

```yaml
version: tool-policy-v1
tools:
  calendar.get_profile:
    allowedFactKeys: [user/timezone/global]
    trustLevel: 0.85
    autoPromote: true
    redactFields: [access_token]
  weather.current:
    allowedFactKeys: []
    trustLevel: 0.85
    autoPromote: false
    ttlSeconds: 3600
```

未登记工具、Fact Key 不在 Allowlist、缺少稳定 Tool ID 的结果只能进入 Evidence/Candidate，不能自动转正。天气、余额、进程状态等瞬时结果即使来源可信，也只作为带 TTL 的 Observation，不进入长期 Canonical Fact。

稳定 Tool ID 来自 AIRI Tool Contract；MCP 工具使用 `server_id/tool_name`，不能使用 LLM生成的显示名称。`redactFields` 在保存 Evidence 和发送记忆提取 LLM 前执行。TTL 由 `observed_at + ttlSeconds` 确定，无法取得 Observed At 时不自动晋升。

允许自动转正的工具结果必须保留：

- Tool 名称。
- Tool Call ID。
- 观察时间。
- 原始返回摘要。

工具结果默认没有必要过度怀疑，但不能丢失时间，因为天气、余额、进程状态等很快会过期。

Tool Policy 第一版同样作为随应用发布的不可变 TypeScript 数据模块存在，不提供运行时自由编辑器；新增可信 Tool 或修改 Allowlist 必须发布新 Policy Version。Policy Version 写入 Evidence Metadata 和 Change Log。选择新版本不会静默重写旧记忆，只能通过显式维护 Job 重新评估。这样既可审计，也避免把未经审查的 Tool 通过设置页临时升级成“可信来源”。

### 4. Vision

只生成 Candidate，不自动转正。

原因不是认为 Vision 一定错误，而是画面通常只证明“当时屏幕上出现了什么”，不能自动推导长期个人事实。

### 5. Assistant Output

可以保存为 Evidence，但不能单独支持用户 Fact/Preference 转正。

助手输出的用途主要是：

- 对话追溯。
- 摘要来源。
- 检查模型是否错误引用记忆。
- 生成反馈和调试记录。

### 6. Instruction

完全没有自动转正路径。

只有管理界面专用 API 可以创建。

### 7. 晋升结果必须可重复

晋升使用稳定 Job Key：

```text
promote:{candidate_id}:{promotion_policy_version}
```

同一候选重复执行只能得到同一个 Canonical Memory 或同一个拒绝结果。代码通过数据库事务和唯一键保证，不能依赖 Worker“通常只运行一次”。

---

## 九、Confidence 改成可解释算法

Confidence 不由 LLM填写，而由可观察事件计算。

第一版只使用确实能够采集的数据：

```text
来源可信度
人工确认
Wrong 反馈
```

取消：

- `独立支持证据数`：第一版不做全库语义支持搜索。
- `冲突次数`：冲突是状态迁移事件，不是线性扣分项。
- `用户确认次数`：人工确认使用最终状态而非累加次数；自动 Useful 反馈也不等价于事实为真。

必须区分两个概念：

- `confidence`：这条事实/偏好得到的证据支持强度。
- `utility`：这条记忆在历史召回中是否有帮助。

Useful/Irrelevant 主要更新 Utility；Wrong 会影响事实状态和 Confidence；Outdated 影响有效时间和状态，但不机械否定它在过去曾经为真。如果把 Useful 直接当成“用户确认事实为真”，系统会把一个虽然帮助回答、但内容已经不准确的记忆越用越可信。

### 基础支持分

```text
manual confirmation          1.00
explicit user assertion      0.85
registered tool result       Tool Memory Policy.trustLevel
document text                0.65
implicit user preference     0.45
vision observation           0.35
assistant output             不允许单独晋升
```

这些不是“真值概率”，只是策略权重。

来源值由 `memory_evidence.source_type` 和 Claim 的 `assertion_mode` 确定，因此无需 LLM填写，也不需要人工计数。

### 所有评分数据的采集来源

| 数据 | 采集时机 | 产生者 | 持久化位置 | 是否允许直接改变正式记忆 |
|---|---|---|---|---|
| 来源可信度 | Evidence 写入时 | 确定性 Source Policy | 由 Source Type 派生，Change Log 记录策略版本 | 只决定初始 Confidence |
| 明确/隐式陈述 | Candidate 提取时 | 便宜 LLM + Schema/Quote 校验 | `memory_claims.assertion_mode` | 按固定晋升规则执行 |
| 人工确认 | 用户点击确认时 | 用户 | `memory_changes(operation=confirm)` + Canonical 当前值 | 可以设为 Active/1.00 |
| Usage/User Signal | 下一条用户回应后 | 便宜 LLM分别分类，默认 Uncertain/None | `memory_feedback` | 不能直接改变正式记忆 |
| Useful/Irrelevant | Usage + User Signal 的确定性映射 | TypeScript Policy | `memory_feedback.feedback` | 只影响 Utility |
| Wrong | User Signal=Correction 或人工操作 | 自动结果必须提供用户 Quote；人工无需 LLM | `memory_feedback` | 自动只隔离，人工可失效 |
| Outdated | User Signal=Outdated 或人工操作 | 自动结果必须提供用户 Quote；人工无需 LLM | `memory_feedback` | 自动只隔离/候选失效，人工可过期 |
| Importance | Candidate 提取与晋升时 | Predicate Policy + LLM Hint | Canonical Memory + Change Log | 由确定性上限/下限约束 |
| 检索次数/最近使用 | 实际注入 Prompt 时 | 检索流水线 | `memory_retrievals` | 不直接改变事实状态 |
| 时间 | Candidate 提取时 | LLM仅提取明确原文，代码解析 | Claim/Canonical Memory | 不确定统一为 null |

表中没有“独立支持证据数”和“冲突次数”。如果未来评测证明需要，可以基于现有 Evidence Link 和 Conflict 事件离线计算，不需要现在填充没有意义的列。

人工确认来自管理界面的显式操作，不复用 Useful Feedback：

```text
confirm memory
→ 在事务中校验当前 Revision，并写 operation=confirm 的不可变 Change
→ confidence 固定为 1.00
→ status 变为 active
```

Canonical Memory 保存当前有效的 Confidence/Status，Change Log 保存谁在何时确认以及后续是否被纠正或回滚。重复确认同一 Revision 是幂等空操作，不通过点击次数继续加分；界面如果需要显示历史确认次数，只聚合未被对应 Rollback 撤销的 Confirm Change。

### Confidence 多证据聚合

```text
validSupportWeights = 当前 Memory 所有未撤销 supports Link 的支持权重
confidence = max(validSupportWeights)
人工确认作为有效支持事件，权重固定为 1.00
```

支持 Link 被 Wrong 裁决、撤销或重定向后立即失效并重算。重算完成但没有任何有效支持时写入 `0`；`NULL` 只表示尚未计算（例如迁移或任务仍在运行），不能与“已计算但没有支持”混用。该公式不会因为重复陈述机械累加，也不会把多个弱证据伪装成高概率。

### Confidence 状态规则

第一版不使用难以校准的连续聚合公式，而使用少量确定性状态规则：

```text
创建时：confidence = 来源固定权重
人工确认：confidence = 1.00，status = active
自动 Wrong：status = quarantined，confidence 数值暂不改，等待用户裁决
人工 Wrong：confidence = 0.00，status = superseded 或 archived，并保留证据
自动 Outdated：status = quarantined；若新事实时间关系明确则 status = expired，保留历史 Confidence
人工 Outdated：status = expired，保留历史 Confidence
```

自动 Wrong 来自便宜 LLM 对用户回应的分类，单次误判不能直接改分；Quarantine 已足以阻止确定性召回。人工 Wrong 才把当前命题支持度归零。Outdated 表示“现在不再有效”，不等于“过去从未为真”，所以用 Status/Valid Until 表达而不降低历史支持度。目的：状态表达事实是否可用，Confidence 表达证据支持，避免把大量任意系数乘成一个看似精确的数字。

### Utility 反馈聚合

Utility 由实际召回反馈计算：

```text
utility = (useful + 1) / (useful + irrelevant + 2)
```

其中加一平滑避免一条反馈造成极端分数。Wrong/Outdated 不进入 Utility 公式，因为它们已经触发更强的状态处理。

- 同一 `retrieval_id + memory_id + feedback_source` 只能产生一条反馈。
- 自动判定为 `unknown` 时不写 Useful/Irrelevant/Wrong/Outdated。
- 没有用户回应或回应与记忆无关时必须返回 `unknown`，不能为了填数据强行判断。
- 排序时 Utility 只能作为温和调整，不能把低语义相关记忆推到最前。

### 低 Confidence 隔离

第一版不通过连续分数自动跨阈值删除。以下事件进入隔离：

```text
隐式高风险偏好
自动 Wrong
无法自动解决的重要冲突
来源只有 Vision 或 Assistant 的正式记忆候选
Schema/引用校验通过但语义仍不确定的候选
```

不会删除。

目的：

- 保留证据链。
- 可以在新证据出现后恢复。
- 可以人工检查。
- 算法更新后能够重新计算。
- 避免一次错误反馈造成不可逆删除。

---

## 十、Memory Feedback

### 数据如何真实产生

每次检索在把记忆注入意识 LLM 前写入 `memory_retrievals`：

```text
id
session_id
turn_id
query
created_at
```

每条最终注入结果写入 `memory_retrieval_items`：

```text
retrieval_id
memory_id
rank
retrieval_score
token_count
```

这里只记录最终实际注入上下文的记忆，不记录最初检索但后来被过滤或 Token 预算淘汰的候选。独立 Item 行允许对每条记忆建立反馈唯一键和统计索引，避免把 ID 数组再次变成不可查询字段。

当本轮助手回复完成、并收到用户下一条回应后，建立一个低优先级 Feedback Job。便宜 LLM 的输入严格限制为：

```text
上一轮用户问题
实际注入的记忆（逐条带 memory_id）
助手上一轮回复
用户当前回应
```

它为每条记忆分别输出两个可审计维度：

```text
usage = used | unused | uncertain
user_signal = positive | negative | correction | outdated | none
evidenceQuote
reasonCode
```

确定性代码再映射为反馈：

```text
used + positive       → useful
unused + 非 correction/outdated → irrelevant
任意 usage + correction → wrong
任意 usage + outdated → outdated
其他                  → unknown
```

`negative` 只表示用户对回答表现出否定，但没有明确纠正记忆；它不能自动映射成 Wrong。`used + none` 也不是 Useful，因为用户可能只是换了话题或说“谢谢”。

`correction/outdated/positive` 必须携带能够在当前用户回应中验证的 `evidenceQuote`。Quote 不存在则把 `user_signal` 降级为 `none`。`usage` 可以根据记忆与助手回复判断，不要求用户 Quote。

为了控制成本，同一轮所有召回记忆使用一次批量 LLM 调用，不为每条记忆分别请求。没有召回记忆、用户没有下一条回应、记忆功能被暂停时不创建调用。

对普通聊天用户消息，Candidate 提取和上一轮 Retrieval Feedback 合并为一次 `analyze_user_turn` 请求：响应包含互相独立校验的 `claims` 与 `retrievalFeedback` 两部分。某一部分不合法不会让另一部分已经通过 Schema/Quote 校验的结果失效。文档、Vision 和 Conflict 因输入来源和触发时机不同，仍使用独立后台请求。

新表：

```text
memory_feedback
```

字段：

```text
id
memory_id
retrieval_id（自动反馈必填，管理界面反馈可空）
feedback
source
source_event_id
usage
user_signal
evidence_quote
metadata
revision
retracted_at
created_at
```

`source` 第一版只允许 `automatic | manual`。Automatic 行令 `source_event_id = retrieval_id`；Manual 行使用管理 API 生成并随重试复用的 Request UUID。数据库唯一键 `source + source_event_id + memory_id` 保证两条路径都不会因网络/Worker 重试新增重复计数；同一事件重新分析时在 Revision/Change Log 保护下更新或恢复同一行。Manual 行可以记录用户在不依赖某次召回时做出的 Wrong/Outdated/Useful/Irrelevant 判断。

反馈值：

```text
useful
irrelevant
outdated
wrong
```

自动分类得到 `unknown` 时不写入 `memory_feedback`，只把 Feedback Job 标记为成功完成。

不在 Canonical Memory 上直接保存四个计数字段。

原因：

- 原始反馈事件比计数更有信息量。
- 可以防止重复反馈。
- 可以知道是哪次召回导致反馈。
- 修改算法后可以重新聚合。
- 可以区分用户反馈和自动反馈。

管理界面展示的：

```text
usefulCount
irrelevantCount
outdatedCount
wrongCount
lastRetrievedAt
lastUsefulAt
```

将由查询或数据库 View 聚合产生，而不是作为多份可失真的冗余列。

### 反馈入口

第一版提供：

- 开发工具中查看本轮召回结果。
- 每条结果提供 Useful/Irrelevant/Outdated/Wrong。
- 记忆管理页面也可反馈。
- Wrong/Outdated 要求可选说明。
- 当前聊天正常界面暂时不堆反馈按钮，避免打扰日常使用。
- 自动反馈详情显示模型、Prompt Schema Version、Evidence Quote 和 Reason Code，方便识别反馈模型本身的误判。

### 自动反馈的权限边界

- 自动 `useful/irrelevant` 只更新聚合 Utility。
- 自动 `wrong/outdated` 只能把记忆移入 Quarantine 或启动冲突处理，不能物理删除或直接重写 Value。
- 用户在管理页面给出的 `wrong/outdated` 是人工反馈，可以执行明确状态迁移。
- 自动反馈本身也写入 Change Log；错误反馈可以撤销并重新计算聚合值。
- 自动 Correction 必须唯一归因到本轮实际注入的一条 Memory。确定性 Quote、Value 或 Predicate+Entity 匹配先缩小真实候选；LLM 只能在该候选集中选择唯一目标。用户只说“你记错了”却无法定位内容、候选多于一个、Quote 校验失败或 LLM 返回不确定时，不给任何 Memory 写 Wrong。

---

## 十一、冲突发现采用双轨制

你的“高相似度反而暴露否定盲点”方法有价值，但不能作为主要冲突判据。

### 长信息与短信息如何结构化

系统不直接对整段长文本赋予一个 Fact Confidence。所有输入先区分三个层次：

1. `Evidence`：不可变原文，可以很长，负责追溯。
2. `Atomic Claim`：从原文拆出的最小可判定命题，负责冲突、时间和状态。
3. `Derived Summary`：为了召回节省 Token 而生成的派生文本，负责可读性，不作为原始事实来源。

例如一段文档包含十个事实，其中一个错误：

```text
原始 Evidence：保持不变
九个正确 Atomic Claim：保持 validated/promoted；其对应 Canonical Memory 继续 active
一个错误 Atomic Claim：保留原审核状态和证据；其对应 Canonical Memory 标记 quarantined/superseded/expired
Wrong/Outdated：只作为 Feedback 标签记录，不写入 Claim.status
旧 Derived Summary：标记 stale
后台任务：只用仍有效的 Canonical Memory 及其支持 Claim 重建 Summary
```

因此不会“因为长信息里有一个错误就删除整段”，也不会在原始文档字符串上做不可审计的局部删改。

### 原子化的可实现约束

便宜 LLM 可以完成长文本到 Atomic Claim 的拆分，但为了避免 Wish-coding，第一版规定：

- 每个 Claim 必须拥有独立 Fact Key、Value 和 Evidence Quote。
- Quote 必须通过 Offset 或版本化规范化映射回原始 Evidence。
- 一个 Claim 只表达一个可以独立否定的命题。
- 超过最大 Claim 数的长文档按 Chunk 分批提取，不要求模型一次理解整个文件。
- 跨 Chunk 才能成立的推论第一版不自动生成。
- 无法原子化的内容保留为 Evidence，可参与文档问答，但不进入 Canonical Fact。

这意味着系统能可靠处理局部错误，但不承诺把任意文学文本、复杂论证或整本书无损转换成知识图谱。

### Derived Summary 的状态

`summary` 可以继续存在于 Canonical Memory，但它必须通过 `derived_from` Link 记录构成它的 Claim ID。Promoted Claim 在对应事实过期后仍保持 Promoted，因此 Stale 触发条件不能只观察 Claim.status：任一组成 Claim 的 `promoted_memory_id` 发生变化、其对应 Canonical Memory 的 Status/Revision 变化，或组成 Link 被修改，Summary 都立即变为 `stale`，在重建前不参与正式召回。重建只读取当前允许召回的 Canonical Memory 及其 Claim/Evidence，生成新 Summary 版本；旧 Summary 保留在 Change Log 中而不是覆盖原文。

### 冲突记录

冲突对需要生命周期，增加最小表：

```text
memory_conflicts
```

字段：

```text
id
namespace
fact_key（可空；Embedding 异常可能跨 Key）
left_memory_id
right_memory_id（可空）
candidate_claim_id（可空）
detection_method
status
classification
importance
resolution
revision
created_at
resolved_at
```

合法冲突形态只有两种：

```text
现有正式记忆 vs 新候选：
  left_memory_id NOT NULL
  candidate_claim_id NOT NULL
  right_memory_id IS NULL

两个既有正式记忆：
  left_memory_id NOT NULL
  right_memory_id NOT NULL
  candidate_claim_id IS NULL
```

数据库 Check Constraint 要求 `right_memory_id` 与 `candidate_claim_id` 恰好一个非空。两个 Memory 的 ID 按稳定顺序保存并建立唯一索引；Memory/Claim 组合也建立唯一索引，防止同一冲突重复提交给 LLM 或用户。

Conflict 状态统一为：

```text
open | classified | awaiting_user | resolved | dismissed
```

它只描述冲突处理流程。Conflict 不能拥有 Active/Expired 等事实状态，也不复制长文本。

### 第一轨：结构化事实冲突

可靠、低成本：

```text
Fact Key 相同
+ Value 不同，或同 Value 但 Polarity 相反
+ 时间区间重叠
```

例如：

```text
user/residence_city/global = 上海
user/residence_city/global = 北京
```

进入潜在冲突。

这是主要方法。

具体算法：

```text
新 validated Claim 写入
→ 按全局顺序获取 Namespace Schema Lock 与 normalized_fact_key Fact Lock
→ 从 Predicate Registry 读取 cardinality
→ SQL 查询并锁定同 namespace + fact_key 的 active/disputed Canonical Memory
→ 没有现有 Memory：按晋升策略创建 Canonical Memory
→ Value 与 Polarity 规范化后都相同：把 Claim 作为新 Evidence Link 关联到现有 Memory，并设置 promoted_memory_id
→ cardinality=set 且 Value 不同：允许不同集合成员分别创建 Active Memory
→ cardinality=set、Value 相同但 Polarity 相反：只对该集合成员创建 Conflict，不影响其他 Value
→ cardinality=single 且 Value 或 Polarity 不同：创建 Memory-vs-Claim Conflict，并把 Candidate Claim 设为 quarantined
→ cardinality=temporal_single、Value/Polarity 变化但时间明确且不重叠：按 temporal_change 晋升
→ cardinality=temporal_single、Value/Polarity 变化且时间重叠或未知：创建 Memory-vs-Claim Conflict，并把 Candidate Claim 设为 quarantined
```

Conflict 行、Claim Quarantine、Change Log 和分类 Job 在同一事务中写入。`promote_claims` 只处理没有 Open/Classified/Awaiting User Conflict 的 Validated Claim，避免分类等待期间被另一个 Worker 晋升。

时间未知统一保持 `null`。`null` 不被假装成当前时间；它会使自动时间消解失效，从而交给 LLM分类或隔离。

所有有效时间统一采用半开区间 `[valid_from, valid_until)`。只有 `left.valid_until <= right.valid_from` 或反向条件能证明两段不重叠；任一必要边界为 `null` 时结果为 Unknown，不能把 `null` 当作正负无穷或当前时间。

`set` Predicate 的否定 Claim 只针对规范化 Value 相同的集合成员。例如“不再喜欢爵士乐”与现有 `favorite_music=爵士乐, positive` 进入时间变化/冲突流程，但不会影响 `favorite_music=古典乐, positive`。如果不存在该 Value 的正向记忆，负向 Claim 仍可按普通晋升规则保存为 `favorite_music=爵士乐, negative`，让召回明确知道该用户不喜欢它。

### 第二轨：Embedding 异常候选

用于发现 Fact Key 规范化失败或者自然语言否定：

```text
余弦相似度极高
+ 文本并不完全相同
+ 来自不同 Evidence
```

例如阈值先使用可配置的：

```text
similarity >= 0.90
```

这一步只产生：

```text
potential_contradiction_pair
```

不能直接宣布矛盾。

为了控制两两比较的平方级成本，不扫描全库笛卡尔积。每个新 Claim 使用当前 Active Embedding Schema 的同一输入模板生成一次临时向量，再从同 Namespace、同 Kind 的 Active/Disputed Canonical Memory 中取 Top-K 近邻并检查高相似度异常。Candidate 尚未晋升，因此不为它伪造 `memory_embeddings.memory_id`；临时向量只存在于当前 Conflict Job，失败时该 Claim 只使用第一轨。默认 K 应保持较小并可配置。

原因：

- “我住在上海”和“我现在住在上海”也会极高相似，但不矛盾。
- 同义句也会极高相似。
- 模板化文字、短文本很容易异常接近。
- 不同 Embedding 模型的相似度分布不同，`0.90` 不能永久写死。

### 便宜 LLM 二次判断

LLM对候选对返回：

```text
same
compatible
temporal_change
contradiction
unrelated
uncertain
```

同时输出：

```text
importance:
  trivial
  normal
  important
  critical

needsUserDecision:
  true | false
```

LLM 同时返回它使用的双方 Evidence Quote。代码验证 Quote 后才接受分类。LLM不能直接修改 Claim 或 Canonical Memory；它只能把 Conflict 从 `open` 更新为 `classified/awaiting_user` 并给出建议处理方式。

### 交给用户的条件

只有满足以下条件才提示用户：

- LLM判断为 `contradiction` 或 `uncertain`。
- Importance 至少为 `important`。
- 自动时间消解失败。
- 没有明显更高可信度证据。
- 最近没有询问过相同冲突。
- 不是已经被用户忽略的冲突。

例如：

- 居住地冲突：可能值得询问。
- 常用语言冲突：值得询问。
- 医疗过敏信息冲突：必须询问。
- 两年前早餐吃了油条还是馅饼：直接忽略或保留为 Episodic Evidence。

### 冲突处理结果

- `same`：Memory-vs-Claim 时把 Candidate 关联到现有 Memory，并同时设为 Promoted、写入 `promoted_memory_id`；Memory-vs-Memory 时选择一个 Canonical ID，把失败 Memory 所有支持 Claim 的 `promoted_memory_id` 与 Evidence Link 一起重定向到胜出 ID，再把重复 Memory 设为 Superseded。重定向使用 `INSERT ... ON CONFLICT` 去重后删除旧 Link，全部动作与 Conflict Resolution 在同一事务中完成；两种形态都不删除 Claim/Evidence。
- `compatible`：LLM 分类仍要通过确定性 Cardinality/时间校验。`set` 的不同成员或 `temporal_single` 的不重叠区间可以并存；`single` 的不同当前 Value 以及无法证明不重叠的 `temporal_single` 不能仅凭 LLM 的 Compatible 结果同时 Active，必须继续 Quarantine 或 Awaiting User。
- `temporal_change`：按明确时间确定旧 Canonical Memory 并设置 `valid_until/expired`；Candidate 存在时再晋升为新 Active Memory，Memory-vs-Memory 则保留较新者 Active。
- `contradiction + trivial/normal`：较低来源方对应的 Canonical Memory Quarantine；如果右侧仍是 Candidate，则 Candidate Quarantine 而不先创建正式记忆。
- `contradiction + important/critical`：现有 Canonical Memory 设为 Disputed，Candidate 保持 Quarantined，Conflict 进入 Awaiting User。
- `uncertain`：现有 Memory 保持原状态或进入 Disputed，Candidate Quarantined，不自动覆盖。
- 用户裁决：胜出的 Candidate 才创建/激活 Canonical Memory；失败的 Canonical Memory 设置 Superseded/Expired，失败的 Candidate 设置 Rejected/Quarantined，并写入同一事务的 Change Log。

对于来自长信息的冲突，事实状态只作用于该 Atomic Claim 对应的 Canonical Memory；候选 Claim 只使用审核状态。其余 Claim/Memory 不降 Confidence；包含该 Claim 的 Derived Summary 变为 Stale 并后台重建。

需要在两个同义 Canonical Memory 中选择保留 ID 时，确定性顺序为：人工确认优先、Confidence 较高优先、创建时间较早优先、最后按 Memory ID 排序。LLM不决定数据库主记录。

---

## 十二、Importance 同样不能完全交给 LLM

LLM可以给出 Importance Candidate，但最终由规则修正。

规则示例：

```text
身份、长期偏好、地址、重要关系 → 较高
临时任务状态 → 中等并带有效期
一次性视觉状态 → 低
闲聊、一次性餐食 → 很低
安全、医疗过敏 → 高，但自动隔离等待确认
```

最终：

```text
llm_level = LLM importanceHint
min_level, max_level = Predicate Registry
importance = clamp(llm_level, min_level, max_level)
```

等级顺序为 `trivial < normal < important < critical`。`clamp` 同时表达最小值和最大值：例如地址最低 Important，而一次性状态最高 Normal。LLM只是区间内的一个输入。

第一版不计算伪精确小数，使用四档枚举并在数据库中映射为固定排序值：

```text
trivial   = 0.10
normal    = 0.40
important = 0.70
critical  = 1.00
```

Predicate Policy 已合并入版本化 Predicate Registry。敏感性和重要性彼此独立：地址可以是 Important，同时因为 `sensitivity=high` 被禁止自动激活；该限制由 Sensitivity Policy 决定，而不是通过降低 Importance 间接实现。

Useful 反馈不直接提高 Importance。它影响 Utility 排序；否则一条频繁被检索的普通偏好会逐渐被误认为人生关键事实。

---

## 十三、是否实现全文混合检索

我的结论是：

> 第一版不做通用的“向量 + 全文加权排名”，但保留精确键和文本搜索作为候选入口。

原因：

1. AIRI 的主要长期记忆是短 Fact/Preference，不是大型文档库。
2. 中文全文分词会引入额外扩展、词典和维护复杂度。
3. Fact Key 和 Value 的精确/模糊匹配比通用全文搜索更可解释。
4. Embedding 已经负责表达差异。
5. 在没有评测集前引入复杂加权没有依据。

第一版候选来源：

```text
Fact Key 精确匹配
Value/实体文本匹配
Embedding 召回
```

管理页面搜索继续支持标题/正文模糊搜索。

文档如果未来规模很大，再单独为文档 Evidence 增加 PostgreSQL 全文索引。不会一开始把文档检索和个人事实检索混为同一个排名系统。

---

## 十四、检索流水线最终版本

你不想再阅读复杂的检索细节，所以这里给出最终承诺：

```text
1. 查找相关候选
2. 从召回候选中滤掉当前无效、过期、隔离、错误 Scope 的记录
3. 优先精确 Fact Key/实体，再结合向量相关性
4. 同一事实只选择当前有效版本
5. 渲染 Fact Key、Polarity 与 Value，负向记忆不能丢失否定词
6. 冲突未解决的内容不会伪装成确定事实
7. 去掉重复表达
8. 根据 Token 预算截断
9. 记录本轮实际召回结果，允许反馈
```

不会在没有评测证明的情况下加入：

- 复杂 MMR。
- 任意时间衰减。
- 多层机器学习排序器。
- 第二个重排序 LLM。
- 难以解释的综合黑箱分数。

---

## 十五、Embedding 多版本

Embedding 是 Canonical Memory 的可重建派生索引。Serving/Fallback 属于整个向量 Schema，不能属于单条向量。

### Embedding Schema Registry

新表：

```text
embedding_schemas
```

字段：

```text
id
namespace
schema_version
provider
model
dimensions
distance_metric
input_template_version
status
eligible_count
ready_count
coverage
index_name
index_status
created_at
updated_at
```

Schema 状态：

```text
building
ready
failed
archived
```

一个 Schema 唯一确定 Provider、Model、Dimensions、Distance Metric、输入模板和 Schema Version。输入模板第一版把 Canonical Memory 确定性序列化为 `kind + fact_key + polarity + value`；Candidate 冲突检查必须使用同一模板。模板变化必须创建新 Schema Version，不能让同一索引中混入不同编码语义。不同 Schema 的余弦分数不能直接比较，即使维度碰巧相同。Active/Fallback 角色只由 `embedding_schema_state` 指针决定，不重复写入 Schema Status，避免两个真相来源漂移。

`eligible_count` 第一版定义为同 Namespace 内需要参与召回或冲突发现的 Canonical Memory：Active/Disputed Fact/Preference，以及启用 Summary 时的 Active Summary；Quarantined、Expired、Superseded、Archived、Stale 不计入。`coverage = ready_count / eligible_count` 是由后台 Job 根据真实 `memory_embeddings` 聚合更新的可重建进度；管理界面显示分子、分母和失败数，不能只显示一个百分比。空集合的 Coverage 定义为 1.00，但健康检查仍必须验证模型配置和索引可用。

### Active Schema 指针

新表：

```text
embedding_schema_state
```

字段：

```text
namespace PRIMARY KEY
active_schema_id（可空）
fallback_schema_id（可空）
revision
updated_at
```

每个 Canonical Memory Namespace 只有一行状态，因此只能有一个 Active Schema 和至多一个 Fallback Schema。两个指针都是外键，并且被指向 Schema 的 Namespace 必须与 State 行相同；该跨表约束在切换事务内锁行并验证。首次尚未配置可用模型时允许 Active 为空，此时精确键/文本召回继续工作，Vector Recall 明确显示为未启用。Instruction 不使用 Embedding，不进入这个 Registry。

### 单条向量

`memory_embeddings` 字段改为：

```text
memory_id
schema_id
vector
build_status
last_error
created_at
updated_at
```

唯一键是 `memory_id + schema_id`。单条向量只有 `pending/ready/failed` 构建状态，不再出现 Serving/Fallback。

对每个 Schema 建立独立的 pgvector 部分索引。索引表达式将向量安全转换为该 Schema 声明的固定维度，并以 `schema_id` 作为 Predicate；Schema ID、维度和索引名均由校验后的内部值生成，不能拼接用户原始字符串。如果索引构建失败，Schema 不能进入 Ready。

该方案由 pgvector 官方明确支持：同一 `vector` 列可以保存不同维度，但索引必须通过固定维度 Cast 和 Partial Index 限定同维行：[pgvector FAQ](https://github.com/pgvector/pgvector#can-i-store-vectors-with-different-dimensions-in-the-same-column)。因此不需要为每个模型部署新数据库。

### 原子 Serving 切换

切换条件：

```text
coverage = 1.00（第一版固定门槛）
+ 部分向量索引构建完成
+ 维度/距离函数校验通过
+ 固定健康查询能够返回预期 Schema 的结果
```

切换事务：

```text
BEGIN
→ 获取 Namespace 级 Advisory Transaction Lock
→ SELECT embedding_schema_state WHERE namespace=? FOR UPDATE
→ 在锁内重新统计 eligible_count/ready_count/coverage
→ 再次检查 Candidate Schema status/index/coverage
→ 原 Active Schema ID 写入 fallback_schema_id
→ Candidate ID 写入 active_schema_id
→ state.revision + 1
→ 写 Change Log
COMMIT
```

任何检查或更新失败，指针保持原样。管理界面看到的 Active Schema 来自 `embedding_schema_state`，而不是统计每条 Embedding 的状态。

创建、晋升、修改、归档 Canonical Memory 的事务也必须获取同一个 Namespace 级 Advisory Lock，并为去重后的 Active、Fallback 以及所有 Building Schema 建立幂等 Embedding Job。Fallback 成为回退指针后仍持续跟随每次 Memory Revision 更新，否则真正回切时会回到一份静止的旧快照。这样 Coverage 检查与正式记忆集合不会并发漂移。单用户桌面应用写并发很低，这种短事务串行化是可接受的；Embedding 网络计算不在锁内执行。

### 检索期间的一致性

一次 Recall 开始时读取一次 `active_schema_id/fallback_schema_id/revision` 快照，后续 SQL 全部使用该快照；切换发生在请求中途也不改变本次检索的向量空间。

正常查询只在 Active Schema 内计算距离；Active 为空时跳过向量步骤，不能静默改用任意 Schema。第一版 Serving 切换阈值固定为 100% Eligible Coverage，因此迁移期间旧 Schema 始终仍是 Active，新 Schema 只在后台构建，不需要混合两套分数。`fallback_schema_id` 只用于可审计的一键回切：回切也执行同一原子指针事务，完成后旧 Fallback 成为新的 Active，再在它自己的向量空间查询。第一版不并行混排 Active/Fallback；如果以后允许低于 100% 的切换，必须另行定义跨 Schema Rank Fusion，仍禁止直接比较原始 Similarity Score。

### 构建与回退策略

1. 文字 Evidence 和 Canonical Memory 永远不变。
2. 更换模型时创建新 Schema Version。
3. 后台渐进生成新向量。
4. 未完成时旧向量继续服务。
5. 条件通过后原子切换 Active Schema。
6. 旧版本保留为 Fallback；切回旧版本只需再次原子更新指针。
7. 管理界面允许重试失败记录。
8. Agent 没有重建索引权限。
9. Active/Fallback Schema 不能物理删除；必须先切换并归档。
10. 用户可手工停止维护旧 Fallback：事务先锁定 State 行并清空 `fallback_schema_id`，再把旧 Schema 设为 Archived、取消未运行的构建 Job。顺序不能反转；外键 `RESTRICT` 用于阻止仍被指针引用的 Schema 被归档或删除。

---

## 十六、可审计和回滚，但不实现完整 Git

借鉴 Memoria，但保持单用户规模。

新表：

```text
memory_changes
```

字段：

```text
id
transaction_id
batch_id
entity_type
entity_id
entity_revision_before
entity_revision_after
operation
before
after
inverse_operation
reason
actor
policy_version
caused_by_change_id
created_at
```

`transaction_id` 与 `batch_id` 都是应用生成的 UUID，不使用可能回卷的 PostgreSQL 内部 Transaction ID。一次数据库事务内的 Change 共用 Transaction ID；单独操作令 Batch ID 等于 Transaction ID，多步维护任务则让多个 Transaction 共用 Batch ID。Batch 只负责成组审计/回滚，不能削弱每个 Transaction 自身的原子性。

`entity_revision_before` 在创建可变实体时为 `null`，`entity_revision_after` 为创建后的 Revision；更新/状态迁移时二者都非空。Evidence 是不可变来源，不作为字段恢复型回滚目标；Embedding 和 Job 是可重建派生状态，回滚分别通过重建和取消/补偿处理。Claim、Canonical Memory、Instruction、Conflict、Evidence Link、Feedback 与 Schema State 都有单调递增 Revision。

操作：

```text
create
promote
confirm
update
quarantine
restore
supersede
expire
archive
manual_correct
rollback
```

`before` 和 `after` 使用经过 Entity Schema 校验的 JSON 快照；显式 Revision 列让回滚器不必解析 JSON 才能判断后续修改。`inverse_operation` 是由受控枚举和 Valibot Payload 组成的可执行逆操作，例如：

```text
restore_fields       { fields: { status, value, valid_from, valid_until, ... } }
archive_created_memory { memory_id }
restore_claim_promotion { status, promoted_memory_id }
delete_created_link  { link_id }
restore_deleted_link { complete_link_snapshot }
retract_feedback     { feedback_id }
restore_conflict     { status, classification, resolution }
cancel_job           { job_id, target_revision }
```

允许的字段集合由 `entity_type + operation` 的注册表固定，未知 Operation 或多余字段使整个事务失败。逆操作恢复业务字段，但 Revision 永远单调递增，不能把旧 Revision 数字写回数据库；`before` JSON 也不能被整包盲目覆盖到当前行。

这样可以：

- 查看每条记忆怎么变成现在这样。
- 撤销单次修改。
- 恢复被错误隔离的记忆。
- 查看是用户、算法还是后台任务修改的。
- 批量任务可以通过 Batch ID 成组回滚。

### 写事务边界

一次领域操作涉及的所有实体必须使用一个 PostgreSQL Transaction：

```text
BEGIN
→ 按固定 Entity Type + ID 顺序 SELECT ... FOR UPDATE
→ 检查当前 Revision
→ 修改 Claim / Canonical Memory / Conflict / Evidence Link / Feedback
→ Summary 标记 stale
→ 写入同 transaction_id 的 memory_changes
→ 插入需要的幂等后台 Job
COMMIT
```

例如解决冲突时，旧 Memory 状态、新 Memory、Candidate 状态、Conflict 状态、Evidence Link、Derived Summary 和 Change Log 必须一起成功或一起失败。不能由前端连续调用多个独立 API 拼成一次操作。

每个可变业务实体保存整数 `revision`。更新 SQL 使用旧 Revision 作为条件并递增；受影响行数为 0 表示实体已被其他操作修改，整个事务失败后重新读取。

### 跨实体回滚

回滚一个 Transaction/Batch 时：

1. 使用 `pg_advisory_xact_lock` 锁定 Batch，防止重复回滚。
2. 加载该 Batch 全部 Change，并收集受影响 Namespace、Fact Key 和实体。
3. 按全局锁顺序获取 Namespace Lock、Fact Lock 和当前实体 Row Lock，避免与晋升、冲突处理、Schema 切换形成死锁。
4. 对同一实体按 Change 顺序形成链，要求前一条 `entity_revision_after` 等于后一条 `entity_revision_before`，并要求当前 Revision 等于该 Batch 最后一条 Change 的 `entity_revision_after`；否则说明存在后续修改或审计断链。
5. 如果存在后续人工修改，整个回滚拒绝并展示冲突，不能部分恢复。
6. 按 Change 创建顺序的逆序执行每条类型化 `inverse_operation`。
7. Feedback 不物理删除，而是标记 Retracted；聚合查询忽略被撤回事件。
8. 已创建的 Link 执行删除逆操作，已删除的 Link 使用完整快照恢复；唯一键冲突会使整个回滚失败。
9. 受影响 Summary 统一标记 Stale，受影响 Embedding 标记待重建，不盲目恢复旧派生数据。
10. 在同一事务中插入补偿 Job 和新的 Rollback Change，保留原审计记录。
11. 任一步失败则 PostgreSQL 回滚整个回滚事务。

Canonical Memory、Claim 和 Evidence 不因回滚而物理删除。撤销一次晋升时，Claim 回到晋升前状态并清空 `promoted_memory_id`，由该事务新建的 Canonical Memory 变为 Archived；由被撤销事务创建的 Conflict 变为 Dismissed 且 Resolution 标记为 Rolled Back。原 Promote Change 与新的 Rollback Change 共同证明它曾被晋升又被撤销。

后台 Job 必须携带触发它的 `batch_id` 和目标 Entity Revision。回滚事务把该 Batch 仍处于 Pending/Running 的 Job 标记为 Cancelled；已经发出的网络请求无法撤回，但 Worker 提交结果时必须以 `status=running + lease_owner + target_revision` 作为 Compare-and-Set 条件，因此 Cancelled Job 的迟到结果不会写入数据库。

### 批量范围限制

第一版对一个可回滚 Batch 设置实体数量上限，保证它可以在单个 PostgreSQL 事务内完成。大规模 Embedding 迁移不逐行使用业务 Batch 回滚，而使用 Embedding Schema 的原子 Serving 指针切换。已经发出的 LLM/Embedding 网络请求和产生的 API 费用无法回滚；系统只能回滚其数据库副作用。

不会实现：

- Branch。
- Checkout。
- Merge。
- 多用户并发分支。
- MatrixOne Copy-on-Write。
- Agent 自主创建实验分支。

这些对单用户 AIRI 的成本大于收益。

第一版不实现数据库级 Snapshot API。大规模 Schema 迁移依赖 PostgreSQL 事务和正式备份；Embedding 迁移依赖 Active Schema Pointer 回切。业务回滚使用上述逆操作，不伪装成 Git Snapshot。

---

## 十七、后台任务

任务类型：

```text
analyze_user_turn
extract_claims
promote_claims
renormalize_predicates
classify_retrieval_feedback
detect_structured_conflicts
discover_embedding_conflicts
classify_conflict
build_embedding
build_embedding_index
verify_embedding_schema
recalculate_confidence
rebuild_stale_summary
expire_memories
```

每个任务有：

```text
job_key
job_type
status
payload
cursor
attempts
lease_owner
lease_expires_at
next_retry_at
last_error
batch_id
target_entity_type
target_entity_id
target_revision
created_at
updated_at
```

Job 状态统一为：

```text
pending | running | succeeded | failed | cancelled
```

`cancelled` 是回滚或用户明确取消后的终态；重试中的任务仍回到 Pending 并使用 `next_retry_at`，不另造 Retry 状态。Worker 领取时在事务中把 Pending 改为 Running 并写 Lease；只有 Lease Owner 和目标 Revision 仍匹配时才能提交结果。

示例：

```text
analyze:user-message-456:extractor-schema-v1
extract:evidence-123:extractor-schema-v1
feedback:retrieval-123:user-message-456:feedback-schema-v1
embedding:memory-456:r12:jina-v5-1024-v1
conflict:user/residence_city/global:revision-12
```

会写派生状态的 Job Key 必须包含目标 Revision，例如 `embedding:memory-456:r12:jina-v5-1024-v1`；同一 Revision 的重试复用同一行，新 Revision 产生新 Job Key。这样回滚后重新构建不会被旧的唯一键错误拦截，而迟到的旧 Worker 结果会因 `target_revision` 不匹配被丢弃。只分析不可变输入的 Job（例如 Evidence ID + Extractor Schema）可以不带可变实体 Revision。

目的：

- 崩溃后恢复。
- 重启不重复收费。
- 同一候选不重复晋升。
- 同一冲突不反复询问用户。
- Embedding 可以暂停和继续。
- 处理速度可以限制，避免影响 Live2D、Vision 和语音性能。

桌面应用中的 Worker 采用低并发：

```text
Claim Extraction：1
Conflict LLM：1
Embedding：1–2
数据库维护：1
```

只有应用空闲或队列达到条件时运行。

---

## 十八、API 权限分层

### Agent 可以使用

```text
recall
feedback
查看本轮召回来源
```

是否允许 Agent 主动提交 Fact Candidate，可以以后决定；第一版由聊天生命周期自动提交 Evidence。

### 管理界面可以使用

```text
创建/修改/归档 Instruction
确认或拒绝 Candidate
解决 Conflict
恢复 Quarantine
查看 Evidence
手动更正 Canonical Memory
```

### 仅内部 Worker 可以使用

```text
promote candidate
recalculate confidence
detect contradiction
build embedding
expire memory
```

### 仅开发工具/运维可以使用

```text
rebuild all embeddings
create/verify/switch embedding schema
change thresholds
rerun extraction
repair evidence links
reset failed jobs
batch rollback
选择随应用发布的 Predicate Registry Version
选择/校验随应用发布的 Tool Memory Policy Version
```

不会把这些接口加入 Agent Tool 或 MCP Tool 列表。

---

## 十九、操作系统级隐私

第一版只实现四项可验证能力，不引入独立 Windows Privacy Guard：

### 1. 写入记忆前的敏感策略过滤

所有用户文本、STT 文本、OCR 文本、文档提取文本和 Tool Result 在进入 Evidence 或远程记忆提取 LLM 之前执行同一过滤器。

过滤结果：

```text
allow
redact
evidence_only
drop
```

- 明确的 API Key、密码、Cookie、私钥等默认 `drop` 或 `redact`。
- `evidence_only` 表示允许本地留档但不发送给记忆提取模型、不晋升为 Canonical Memory。
- 过滤器命中与处理结果写本地审计日志，但日志不能再次保存被过滤的秘密原文。

正则和启发式无法识别全部隐私语义，因此该功能承诺的是阻断已知敏感格式和用户配置关键词，不承诺百分之百识别所有私人信息。

### 2. 可显示窗口标题阻断

Electron 主进程定时调用内置 `desktopCapturer.getSources({ types: ['window'] })` 获取当前可捕获窗口名称，并使用 `thumbnailSize: { width: 0, height: 0 }` 避免为隐私检测额外抓取画面。

Electron 官方文档明确说明 Window Source 的 `name` 对应窗口标题，并建议在不需要缩略图时把宽或高设为 0 以节省捕获处理时间：[desktopCapturer 文档](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[DesktopCapturerSource](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source/)。

如果任意可显示窗口标题命中用户配置黑名单或内置 Edge 密码关键词，则设置统一 `privacyBlocked` 状态。选择“所有可显示窗口”而不是只判断前台窗口，是因为 Electron 本身没有跨平台、可靠的前台窗口 API；这种策略更保守且无需新增原生依赖。

标题检测无法识别标题未暴露的 Edge 内部弹窗，这一限制必须在界面中说明。

为避免后台长期打开的普通窗口永久误杀，设置页面提供：

```text
blocklist
allowlist
当前命中规则与窗口标题
软规则临时忽略（5/15/60 分钟）
最近阻断记录
```

规则优先级：

```text
用户全局隐私暂停
→ 内置硬阻断规则（密码、密钥等，不允许临时忽略）
→ 对某次软命中的临时忽略
→ 用户 Allowlist
→ 用户 Blocklist
→ Allow
```

最近阻断记录只保存在本地，记录时间、命中规则和截断后的标题，不保存截图、音频或完整敏感标题。窗口列表受 Windows/macOS 权限和系统实现限制，可能不完整；标题关键词也可能误杀，无标题弹窗和网页内部密码框无法检测。

### 3. 阻断时暂停并清空缓冲

`privacyBlocked` 或用户手动暂停时：

- Vision 不再创建新截图。
- Hearing 停止接受新录音段。
- 清空 VAD 预录环形缓冲、尚未提交的音频段、待分析截图和 Vision latest-wins 队列。
- 已经发出的远程请求无法从网络中撤回，但其结果不写入 Evidence。
- 解除阻断后重新建立干净缓冲，不提交暂停前残留内容。

### 4. AIRI 全局隐私暂停

提供持久可见的全局开关和快捷键。它覆盖 Vision、Hearing、附件自动分析和后台 Evidence 提取；状态由主进程统一管理，Renderer 组件不能自行绕过。

验收时必须测试：黑名单窗口出现、手动暂停、暂停期间讲话/切换窗口、解除暂停后，均不存在旧缓冲被延迟上传的情况。

---

## 二十、前端不会直接暴露全部字段

管理界面默认只显示人类真正关心的内容：

```text
记住了什么
为什么记住
来自哪里
当前是否有效
可信程度
是否存在冲突
最近是否有用
```

点击“详细信息”后才显示：

- Fact Key。
- Predicate Registry Version、Cardinality 和 Alias 规范化结果。
- Evidence。
- Feedback。
- 时间区间。
- Embedding Version。
- Change Log。
- Job 信息。

回滚界面在执行前必须展示整个 Transaction/Batch 将影响的实体，而不是只展示当前 Memory；出现后续 Revision 冲突时禁用确认并说明原因。Embedding 页面展示 Active/Fallback Schema 指针、Coverage 分子/分母、索引健康状态和切换记录。

数据库字段用于算法和审计，不会要求用户逐列阅读。

首页建议按状态组织：

```text
有效记忆
待确认
冲突
已隔离
已过期
永久指令
```

而不是展示数据库表格。

---

## 二十一、实际开发顺序

我下一步会按这个顺序连续实施，每一阶段通过测试后继续，不中途等你确认。

### 阶段 0：保存设计约束

先用 PostgreSQL `CHECK`、`UNIQUE`、复合外键和 `ON DELETE RESTRICT` 执行数据库状态机；文档解释约束，但不能成为唯一防线。固定：

- Instruction 只能手工创建。
- LLM只能创建 Candidate。
- Evidence 不可被自动覆盖。
- Embedding 是可重建派生数据。
- 自动任务必须幂等。
- 运维 API 不进入 Agent/MCP。

目的：防止后续代码演进破坏边界。

### 阶段 1：Evidence

- 新表和迁移。
- Chat 用户/助手消息分开记录。
- Tool、文档、Vision 来源类型。
- Source ID 和 Content Hash 去重。
- 写入及远程提取前敏感策略过滤。
- 实现最小 Job 基础：唯一 Job Key、Pending/Running/Succeeded/Failed/Cancelled、Lease 和重试退避；后续阶段只增加任务类型。
- Evidence API。
- Evidence 管理页面。
- 测试重复写入、崩溃重试、来源隔离、附件分段和敏感内容不出站。

### 阶段 2：Candidate LLM

- 提取模型配置。
- Provider/Model 选择。
- JSON Schema。
- `explicit/implicit/none` 分类。
- 长文本原子 Claim 拆分。
- Evidence Offset + 规范化 Quote 验证。
- Predicate Registry、Alias、Cardinality 和 Fact Key 版本化规范化。
- 只允许 Fact/Preference。
- Candidate 页面。
- Mock 模型单元测试和有 Key 才运行的集成测试。

### 阶段 3：自动晋升

- 明确用户陈述自动转正。
- 允许列表内的隐式偏好以低 Confidence 转正。
- 隐式 Fact 与高风险偏好进入隔离。
- Tool 策略。
- Tool Memory Policy Allowlist、TTL 和 Redaction。
- Vision 只进 Candidate。
- Assistant 不单独转正。
- Quarantine。
- Canonical Memory 和 Evidence Links。
- 晋升状态机测试。

### 阶段 4：Feedback 与 Confidence

- Feedback 事件表。
- `memory_retrievals`、`memory_retrieval_items` 与本轮 Recall ID。
- 用户下一条回应触发的批量自动反馈 Job。
- `unknown` 默认与 Evidence Quote 校验。
- 开发工具反馈入口。
- 管理页面反馈入口。
- Confidence 与 Utility 分离。
- Wrong/Outdated 状态迁移。
- Low Confidence Quarantine。
- Feedback 重放测试。

### 阶段 5：冲突

- Fact Key 冲突。
- 冲突候选查询过滤现有 `quarantined` Canonical Memory；它们必须先经人工恢复，不能被后台冲突任务重新引入正式决策。Candidate Claim 自身仍可因新冲突进入 Quarantine，两种含义不能混用。
- `memory_conflicts` 生命周期与唯一键。
- Claim 审核状态、Canonical Memory 事实状态和 Conflict 流程状态完全分离。
- Memory-vs-Claim 与 Memory-vs-Memory 两种冲突 Check Constraint。
- Single/Set/Temporal Single 基数处理。
- 时间区间消解。
- 高余弦候选发现。
- 便宜 LLM分类。
- Importance Gate。
- 长 Evidence 保留、错误 Atomic Claim 对应的 Canonical Memory 独立失效、Derived Summary 标记 Stale 并重建。
- 用户冲突确认页面。
- 忽略和防重复询问。
- 冲突回滚测试。

### 阶段 6：Embedding 多版本

- 独立 Embedding 表。
- Embedding Schema Registry 与 State Pointer。
- Schema Version、部分向量索引和健康检查。
- Active/Fallback 原子指针切换。
- 渐进重算。
- 新旧 Schema 独立检索，不跨模型比较 Similarity。
- 迁移进度页面。
- 模型切换不中断测试。

### 阶段 7：召回

- Fact Key/实体匹配。
- Vector Recall。
- 状态、时间、Scope 过滤。
- 冲突消解。
- 简单确定性去重。
- Token 预算。
- Recall Trace。
- 不引入复杂 MMR。

### 阶段 8：后台任务

任务框架实际上会在前面各阶段逐步使用，这一阶段完成：

- Lease。
- Retry。
- Cursor。
- Pause/Resume。
- Job 管理页面。
- 应用崩溃恢复。
- 重复启动测试。
- 性能限流。

### 阶段 9：Scope

- Vision：`global + vision`。
- Vision Observation → Evidence。
- Artistry：`global + artistry`。
- Memory Worker：`global + memory`。
- Speech：`global + speech`。
- Chat：`global + chat + speech`。
- 每个 Scope 独立测试。
- 可显示窗口标题隐私阻断、统一 Privacy State 和所有采集缓冲清空。

### 阶段 10：审计和回滚

- Change Log。
- Transaction/Batch、Entity Revision 和类型化逆操作。
- 单条跨实体事务撤销。
- 批次锁定、后续 Revision 检查和原子撤销。
- 自动任务修改原因。
- 修改前后 Diff。
- 不实现 Branch/Merge。

### 阶段 11：完整验证

- PostgreSQL 实际集成测试。
- Electron Gateway 测试。
- Vue 管理界面类型检查。
- Worker 崩溃恢复测试。
- Provider Mock。
- 现有 Chat、Voice、Vision 回归。
- 性能和 API 调用统计。
- 最终提供人工测试步骤。

---

## 二十二、实现参数与非阻塞决策

### 记忆提取 LLM

复用 AIRI Provider 系统，在长期记忆设置中单独选择 Provider 和 Model，不写死供应商。模型应支持中文和稳定的结构化输出；若供应商没有原生 JSON Schema，则使用固定 JSON Prompt、严格解析和最多一次修复重试。第二次仍不合法就让 Job 失败并进入退避，不把自由文本当作 Claim。

开发和自动化测试使用 Mock Provider，不需要真实 API Key。真实联调由用户选择任意兼容模型后进行。因此具体供应商不是开始实现的阻塞条件。

### 阈值

以下值作为第一版保守默认值，但必须集中在版本化 Policy 中，不能散落在 SQL 和 Vue 组件：

```text
隐式偏好初始 Confidence：0.45
明确用户陈述初始 Confidence：0.85
Vision Observation：0.35
Embedding 冲突候选阈值：0.90（按模型配置覆盖）
冲突近邻 Top-K：10
单次 Claim Extraction 最大 Claim 数：20
Embedding Schema 首次切换 Coverage：1.00
单次可回滚 Batch 最大实体数：500
Content Normalization Version：text-normalization-v1
Predicate Registry Version：predicate-v1
Tool Memory Policy Version：tool-policy-v1
```

这些是工程启动值，不是假定已经优化过的最佳参数。后续评测集负责调整。

### 现有空数据库

当前长期记忆数据库没有历史数据，因此第一版无需实现旧 Conversation 的智能拆分迁移。迁移只需：

- 将现有 `kind=instruction` 记录幂等复制到 `memory_instructions`，校验数量后再停止旧表读取；当前数据库为空时该步骤自然为空操作。
- 现有非 Instruction 记录如意外存在则作为 Legacy Evidence 保留，不自动提炼。
- 新增第一版表、索引和约束。
- 保证重复迁移幂等。

## 二十三、阶段验收门槛

每一阶段只有达到以下条件才继续；管理页面完成不能代替数据层测试。

### Evidence 验收

- 同一 Message/File/Tool Result 重放不会产生重复 Evidence。
- 用户和助手内容具有不同 Source Type，不再拼成同一事实来源。
- 文档 Claim 能追溯到文件 Hash、Chunk 和页码/时间位置。
- 敏感过滤发生在远程提取调用之前。
- Privacy Block 时新音频、截图和残留缓冲均不产生 Evidence。
- Window Blocklist、Allowlist、软规则临时忽略和硬规则优先级具有固定测试，并能查看最近命中原因。

### Candidate 验收

- 明确 Fact、明确 Preference、隐式 Preference、否定句、问题、引用他人和角色扮演均有固定测试。
- LLM输出没有真实 Evidence Quote 时不能通过。
- OCR/换行/全角差异可以通过版本化规范化定位回原始 Offset；多重匹配不能自动通过。
- 一段包含多个命题的文本被拆成独立 Claim。
- `current_city/living_city/residence_city` 等 Alias 规范为同一 Predicate。
- 未登记 Predicate 进入 Custom Quarantine，不能自动晋升高价值事实。
- 未登记 Tool Result 只能进入 Evidence/Candidate，不能自动转正；TTL Observation 不进入长期 Fact。
- 任意自动路径都无法创建 Instruction。
- 同一 Evidence 的同一 Schema Version 不重复收费提取。

### 晋升与冲突验收

- Explicit User Fact 可自动转正。
- Implicit Preference 只能在允许 Predicate 中低 Confidence 转正。
- Promoted Claim 必须拥有 `promoted_memory_id`，未 Promoted Claim 必须为空。
- Implicit Fact、高风险偏好、Vision 推断进入隔离。
- Importance 按 Predicate Min/Max Clamp，Sensitivity 独立决定是否允许激活。
- 同 Fact Key 同 Value 且同 Polarity 不产生冲突。
- 同 Fact Key 同 Value 但 Polarity 相反会进入冲突；否定语义在 Canonical Memory 和 Prompt 中均不丢失。
- Set Predicate 的不同 Value 可以同时 Active。
- Single Predicate 的不同 Value 创建冲突。
- Conflict 只使用 Open/Classified/Awaiting User/Resolved/Dismissed；Claim 不出现 Active/Expired，Memory 不出现 Proposed/Validated。
- 同 Fact Key 不同 Value、时间不重叠时形成历史变化。
- 时间未知时保持 null，不伪造日期。
- 长 Evidence 中一条 Claim 错误不会失效其他 Claim，也不会删除原始 Evidence。

### Feedback 验收

- 只有最终注入 Prompt 的记忆进入 Retrieval Trace。
- 一轮召回只产生一次批量自动反馈调用。
- LLM分别输出 Usage 与 User Signal，最终标签由确定性映射产生。
- 没有明确用户信号时返回 Unknown，不能强行填反馈。
- Useful/Irrelevant 只影响 Utility。
- 自动 Wrong/Outdated 不能删除或直接覆盖正式记忆。
- 人工反馈与自动反馈可区分、可撤销、可重算。

### Embedding 验收

- 删除全部 Embedding 后 Evidence 和 Canonical Memory 完整保留。
- 新 Embedding Version 未完成时旧版本继续召回。
- Serving 切换只更新一个 Schema State Pointer 事务，不逐行修改 Serving。
- 相同模型不同维度不会进入同一索引空间。
- Recall 只查询一次快照所指向的 Active Schema；Fallback 只能经原子指针回切后成为 Active，绝不直接比较或混排不同 Schema 的 Similarity Score。
- 重算中断并重启后从游标继续，不重复生成已成功项目。

### 审计和恢复验收

- 每次自动状态变更有 Actor、Reason、Before 和 After。
- 一次冲突处理的所有实体共享 Transaction ID 并原子提交。
- 单条撤销使用逆操作恢复权威数据，并把 Summary/Embedding 标记为待重建。
- 批量回滚先锁定实体和检查后续 Revision；存在冲突时不进行部分恢复。
- Rollback 产生新 Change，旧审计记录仍然存在。
- Worker 在持有 Lease 时崩溃，Lease 到期后能被重新领取。
- 同一个 Job Key 不会并发执行两次。

## 二十四、明确不承诺的能力

第一版不承诺：

- 把任意长篇文章无损转换成完整知识图谱。
- 识别所有隐私语义或所有 Edge 内部密码弹窗。
- 让 Confidence 成为现实世界真值概率。
- 仅凭余弦相似度准确判断矛盾。
- 自动解决所有含糊时间和代词指向。
- 多 Agent 分布式一致性、Git Branch/Merge 或图数据库遍历。
- 在没有用户回应证据时准确知道一条召回记忆是否 Useful。

系统承诺的是：无法确定时保留 Evidence、返回 Unknown、进入 Quarantine 或请求用户确认，不用伪造字段填补不确定性。

## 二十五、第一版结论

本 PRD 已具备开始实现所需的主要技术决策，没有架构级阻塞问题。实现将使用两个可配置模型：

1. 一个 Embedding 模型，用于记忆和潜在冲突候选召回。
2. 一个低成本 LLM，用于 Claim 原子化、明确/隐式分类、自动反馈分类和冲突分类。

低成本 LLM 只产生结构化提议；所有写入、晋升、状态迁移、权限、幂等、隔离和回滚由确定性代码控制。后续实现必须以本文的阶段验收门槛为准，不能用“模型通常会做对”代替验证。

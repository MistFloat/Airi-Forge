# 长期记忆实现问题跟踪清单

> 基于 2026-08-03 代码审查（对照 `long-termmemoryPRD-v2.md`），按优先级排序，逐条修复。
> 状态标记：⬜ 待修复 / 🔧 进行中 / ✅ 已修复
> 相关代码：`packages/memory-pgvector`（数据层）、`packages/stage-ui`（编排/UI）、`apps/stage-tamagotchi`（主进程 Gateway）

## 一、正确性与闭环（优先）

### #1 classify_conflict Job 无人消费
- 状态：✅ 已修复（2026-08-03）
- 问题：`promoteClaim` 检测到同 Fact Key 确定性冲突时入队 `classify_conflict`（store.ts），但全仓库没有任何 Worker 消费它，Job 永远 pending、冲突停在 `open`。
- 修复：第一轨冲突创建时直接置 `awaiting_user`（与批次扫描一致），不再入队无消费者的 Job。`resolveConflict` 已支持该状态。单测与 tsc 通过。
- 涉及文件：`packages/memory-pgvector/src/store.ts`

### #2 uses_service 未登记 registry，核心演示场景无法自动晋升
- 状态：✅ 已修复（2026-08-03）
- 问题：提取器 prompt 示例让模型输出 `uses_service`（Apple Music/Spotify），但 Predicate Registry 未登记 → `cardinality=unknown` → 全部 quarantine。「使用 Apple Music / 不使用 Spotify」永远进不了正式记忆。
- 修复：registry 补 `uses_service`（cardinality: `set`），并同时修复 `set` 谓词「同 Value 反 Polarity」未按 PRD v2 §5.1 产生冲突的缺陷（新增 `fact_key_polarity` 冲突轨道）。已补 `predicateRegistry.test.ts` 用例。
- 涉及文件：`packages/memory-pgvector/src/predicateRegistry.ts`、`packages/memory-pgvector/src/store.ts`

### #3 隐式偏好晋升白名单检查的是未规范化 predicate
- 状态：✅ 已修复（2026-08-03）
- 问题：`extractEvidence` 用 `['favorite_music','preferred_language'].includes(claim.predicate)` 判断（LLM 原始输出），但 registry 会把 `music_preference` 等 alias 规范化为 `favorite_music` 存入 DB，白名单漏判。
- 修复：隐式晋升策略集中到 registry（`implicitPromotion` 字段）+ store `promoteClaim(source: 'auto' | 'user')`——自动路径受白名单约束（非白名单 quarantine），治理页手动路径不受限（用户确认可转正）。渲染层移除本地白名单判断，只传 `source: 'auto'`。
- 涉及文件：`packages/memory-pgvector/src/predicateRegistry.ts`、`packages/memory-pgvector/src/store.ts`、`packages/stage-ui/src/stores/modules/memory-long-term.ts`、`apps/stage-tamagotchi/src/main/services/airi/http-server/http/memory-pgvector/index.ts`

## 二、体验与架构

### #4 评估闭环缺失：80 个用例的 golden_truth 无自动打分
- 状态：✅ 已修复（2026-08-03）
- 问题：`longttermmemorytest.json` 每例带 `golden_truth`（should_recall / must_not_recall / expected_conflict_result），但检索实验页只导入为 manual 记忆，不做断言。PRD v2 §10 验收和 §11 第 7 步（评估 Utility 排序修正）无法进行。
- 修复：
  - 量化纯函数 `evaluateRecallCase` / `summarizeRecallEvaluation`（`@proj-airi/memory-pgvector/evaluation`）：`recall@K`、`forbiddenHitRate`、`precision`、`fullyRecalledRate`、`cleanRate`，分母为空返回 `null`（不假装 0），附带 `missedExpectedIds` / `erroneouslyRecalledIds` 供明细定位。
  - 数据集导入（`memoryTestDataset.ts`）：query 取 conversation_flow 最后一个 `[user_assertion]`；golden 目标导入为 `evaluation-<caseId>-<n>`；可解析的 forbidden 目标导入为 `evaluation-<caseId>-f<n>`（tags 含 `forbidden`），描述性语句（"不应/不存在/长期Canonical"）跳过。
  - `recallMemories` 增加 `mode: 'terms' | 'original'`，同一召回路径跑两种模式对照（terms 走 `recall/plan` 分词，original 直接原句 embedding）。
  - 检索实验页 `memoryRetrievalLab.vue` 新增评估区块：逐 case 跑 terms/original 双模式，汇总表（recall@K / forbiddenHitRate / fullyRecalledRate / cleanRate）+ case 明细（分词语、两侧命中/泄露数），单例失败不中断。
- 验证：evaluation 6 单测、memory-pgvector 23 通过 + tsc 通过；stage-ui memoryTestDataset 5 通过；改动文件 eslint 0 错误。stage-ui typecheck 仅剩 #10 记录的预存错误。
- 涉及文件：`packages/memory-pgvector/src/evaluation.ts`（新增）、`packages/memory-pgvector/src/evaluation.test.ts`（新增）、`packages/memory-pgvector/package.json`、`packages/stage-ui/src/stores/modules/memoryTestDataset.ts`、`packages/stage-ui/src/stores/modules/memory-long-term.ts`、`packages/stage-ui/src/components/modules/memory-long-term/memoryRetrievalLab.vue`、`packages/i18n/src/locales/{zh-Hans,en}/settings.yaml`

### #5 Worker 全在渲染层 + Embedding 排空阻塞聊天热路径
- 状态：✅ 已修复（2026-08-04）
- 问题：`runEmbeddingJobs`/`startConflictScan` 是 Pinia store 循环，与窗口生命周期耦合；`recallMemories` 开头、`rememberTurn` 末尾 `await processEmbeddingJobs()`，远程 embedding API 慢时聊天卡住。
- 修复：
  - 主进程 Gateway 新增 `/api/v1/memory/jobs/run`：一次请求内完成 claim → embed → put/fail 循环（维度校验、`failJob` 指数退避不变）。渲染层只转发 embedding 客户端配置，不再持有逐 job 循环。
  - 主进程新增 embedding 客户端（`embedding.ts`）：`embeddingRequestFor` 纯函数（Jina task-specific retrieval API / OpenAI-compatible `/embeddings`）+ `embedForJob` 实际 fetch；`providerConfig` 由渲染层 `providersStore.getProviderConfig()` 透传，主进程无需复刻 provider 注册表。
  - 渲染层 `runEmbeddingJobs` 改为拼装 client config 调 `jobs/run`；`rememberTurn` 末尾 fire-and-forget（吞错）；`recallMemories` 开头改为 200ms 限时等待 + fail-open，召回不再依赖向量构建延迟。
  - 治理页 `memoryGovernance.vue` 手动排空仍保留同步等待。
- 验证：stage-tamagotchi vitest 9 通过（embedding 8 + gateway 1）；stage-ui 记忆相关 14 通过；改动文件 eslint 0 错误；stage-tamagotchi/stage-ui typecheck 仅剩 #10 记录的预存错误。
- 涉及文件：`apps/stage-tamagotchi/src/main/services/airi/http-server/http/memory-pgvector/embedding.ts`（新增）、`.../embedding.test.ts`（新增）、`.../index.ts`、`packages/stage-ui/src/stores/modules/memory-long-term.ts`

### #6 Evidence 无限增长 + 敏感过滤未覆盖入库路径
- 状态：✅ 已修复（2026-08-04）
- 问题：每轮对话 user+assistant 都写 Evidence 且无归档策略；`containsSensitiveSecret` 只在渲染层提取前检查，`/remember` 的 `ingestEvidence` 直接入库不过滤。
- 修复：
  - 敏感过滤下沉为单一事实来源：新建 `packages/memory-pgvector/src/sensitiveContent.ts`（`containsSensitiveSecret`），渲染层 `memoryCandidateExtractor.ts` 改为从中导入并 re-export，不再有两份正则副本。
  - `ingestEvidence` 写库前同过滤：命中则 drop + 审计（`recordChange` 记 `block_sensitive`，只存 `{ contentHash, namespace, sourceId, sourceType }`，不写原文避免敏感内容回流），返回 `{ blocked: true, evidenceId: '' }`；渲染层 `rememberTurn` 对空 evidenceId 跳过 claim 提取（提取器不接触敏感文本）。
  - Evidence 保留策略（PRD v2「不物理删除 Evidence」）：`memory_evidence` 加 `status`/`archived_at` 软归档列（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + 归档索引）；store 新增 `archiveEvidence(namespace, { days, limit })` —— 归档超过保留期（默认 90 天）且未被任何 claim / evidence link 引用的证据；`listEvidence` 加 `status` 过滤（默认 `all` 保持原行为）。
  - Gateway 新增 `/api/v1/memory/evidence/archive`；`evidence/list` 透传 `status`；治理页加「归档 90 天以上旧证据」按钮（zh/en i18n）。
- 验证：memory-pgvector vitest 26 通过（新增 sensitiveContent 3）；stage-tamagotchi 9 通过；stage-ui 记忆相关 14 通过；memory-pgvector tsc 通过；改动文件 eslint 0 错误；两 app typecheck 仅剩 #10 预存错误。
- 涉及文件：`packages/memory-pgvector/src/sensitiveContent.ts`（新增）、`.../sensitiveContent.test.ts`（新增）、`.../store.ts`、`.../schema.ts`、`packages/memory-pgvector/package.json`、`apps/stage-tamagotchi/.../memory-pgvector/index.ts`、`packages/stage-ui/src/stores/modules/memoryCandidateExtractor.ts`、`.../memory-long-term.ts`、`.../memoryGovernance.vue`、`packages/i18n`（zh-Hans/en）

### #7 @node-rs/jieba native 模块打包验证
- 状态：✅ 配置已满足（2026-08-03）
- 问题：jieba 在 Gateway 主进程加载（native `.node`），需确认 electron-builder 打包覆盖。
- 现状：`apps/stage-tamagotchi/electron-builder.config.ts` 已有 `asarUnpack: ['**/*.node']`，风险已覆盖。剩余工作：打包后冒烟测试确认分词可用。
- 涉及文件：`apps/stage-tamagotchi/electron-builder.config.ts`（已满足）

### #8 recall 中 term Top-K 硬编码 LIMIT 5
- 状态：✅ 已修复（2026-08-04）
- 问题：`store.recall` 每 term Top-K 固定 5，不可配置；trace 未保留「纯 similarity vs 修正排序」对照字段。
- 修复：
  - `PgvectorRecallOptions` 加 `topKPerTerm?: number`（默认 5，上限 20），`store.recall` 的 per-term `LIMIT 5` 改为 `bounded(options.topKPerTerm ?? 5, 1, 20)`；gateway `/recall` 透传（1-20 钳制），渲染层 `recallMemories` options 加 `topKPerTerm`。
  - trace 排序对照（PRD v2 §7 纯 similarity 基线）：`evaluation.ts` 新增纯函数 `rankRecallCandidates`（baselineRank = 纯 similarity 排序名次，finalRank = 过滤后注入名次，均 1-based）；`store.recall` 用它生成对照并写入每个 trace candidate；`PgvectorRecallCandidate` 加 `baselineRank?`/`finalRank?`（渲染层类型同步）。
  - lab 的 Retrieval Trace 卡片展示「基线 #N · 注入 #N」对照。
- 验证：memory-pgvector vitest 29 通过（新增 rankRecallCandidates 3）；stage-tamagotchi 9 通过；stage-ui 记忆相关 14 通过；memory-pgvector tsc 通过；改动文件 eslint 0 错误；两 app typecheck 仅剩 #10 预存错误（顺带修复 #6 遗留的 `MemoryPayload.days` 缺失 TS2339）。
- 涉及文件：`packages/memory-pgvector/src/domain.ts`、`.../evaluation.ts`、`.../evaluation.test.ts`、`.../store.ts`、`apps/stage-tamagotchi/.../memory-pgvector/index.ts`、`packages/stage-ui/src/stores/modules/memory-long-term.ts`、`.../memoryRetrievalLab.vue`

### #9 Predicate Registry 扩展（value 规范化 / Importance / Sensitivity）
- 状态：✅ 已修复（2026-08-04）
- 问题：registry 无 value 规范化（上海市→上海）、无 Importance 策略、无 sensitivity。PRD v2 §6.3 要求 Importance 仅来自用户手工设置或固定 Predicate Policy。
- 修复：
  - `PredicateDefinition` 新增 `valueNormalizer` / `importance`（`PredicateImportancePolicy`：`min`/`max` 钳制 [0,1] Importance、`conflictSeverity` 固定冲突等级）/ `sensitivity`（`public`/`personal`/`sensitive`），并导出 `importancePolicyFor` / `conflictSeverityFor` / `sensitivityFor` / `normalizeValueFor`。
  - 策略落地：`residence_city`（敏感 + min 0.6 + important + 中文地名规范化）、`display_name`（personal + min 0.7 + important）、`favorite_music`/`preferred_language`（max 0.5 + normal）、`timezone`/`uses_service`（normal）。
  - store 接线：`createClaim` 入库前 `normalizeValueFor`（hash 同步用规范化值，上海市/上海同值冲突轨对齐）；`initialImportance` 增加 predicate 参数做 `bounded` 钳制（promote 与用户裁决两条路径）；两处 conflict INSERT 写入 `importance = conflictSeverityFor ?? null`（未登记谓词不假装 Critical）；auto 晋升门禁增加 `sensitivity === 'sensitive'` 即 quarantine（显式断言也需用户确认）。
  - 版本号保持 `predicate-v1`：本轮未改 alias/cardinality，不动 fact key 语义，避免无谓触发 embedding 缓存失效。
- 验证：predicateRegistry 新增 4 例（值规范化 / Importance 策略 / 敏感度 / 未登记默认值）；memory-pgvector vitest 32 通过（nodeEsmImport 守卫仍绿）+ tsc 通过；stage-tamagotchi gateway 9 通过；改动文件 eslint 0 错误。
- 涉及文件：`packages/memory-pgvector/src/predicateRegistry.ts`、`.../predicateRegistry.test.ts`、`.../store.ts`

### #10 memory-pgvector 相对导入带 .ts 后缀，跨包整仓 typecheck 失败
- 状态：🔧 主体已修复（2026-08-04），apps/server 残留需单独处理
- 问题：`store.ts` 等文件使用 `from './conflictBatch.ts'` 形式导入，在 stage-tamagotchi / stage-ui 整包 `vue-tsc`（未开 `allowImportingTsExtensions`）下报 TS5097；同时 `apps/server` 目录缺失导致 `api.ts` 等 TS2307。均为预存问题，与本轮改动无关，但阻塞"全仓 typecheck 通过"的验证标准。
- 修复（相对导入部分）：
  - 核实运行时约束：`nodeEsmImport.test.ts` 守卫证明 Electron 外部化该包后由 Node 直接加载源码，Node ESM（type-stripping）要求相对导入带显式 `.ts` 后缀 —— **不能删除后缀**，否则启动失败（历史上已踩过）。
  - 因此修在消费侧：stage-tamagotchi / stage-ui 两个 tsconfig 开 `allowImportingTsExtensions`（两者均已 `noEmit`，合法），并附 `// NOTICE:` 注释说明原因。TS5097 已全部消失，stage-tamagotchi typecheck 不再报 memory-pgvector 错误。
- 残留：`apps/server` 在仓库重构中被整体移除（`git ls-tree HEAD apps/` 只有 stage-pocket/stage-tamagotchi），但 `packages/stage-ui/src/composables/api.ts`（`hc<AppType>`）、root `vitest.config.ts`（projects）、`eslint.config.ts` 仍引用它，导致 stage-ui typecheck 的 TS2307 及其连锁错误。此为仓库级预存问题，需与仓库其他未提交改动一并处理（恢复 apps/server 或统一清理引用），不在本任务伪造契约。
- 涉及文件：`apps/stage-tamagotchi/tsconfig.json`、`packages/stage-ui/tsconfig.json`

---

## 附录：第一版 PRD 历史审查（保留）

## 与我要求的符合情况

| 你的要求                                           | PRD情况                                         | 判断           |
| -------------------------------------------------- | ----------------------------------------------- | -------------- |
| 敏感过滤 → LLM 判断 explicit/implicit → 其他校验 | 已明确写出顺序                                  | 符合           |
| 不使用独立支持证据数                               | 已取消                                          | 符合           |
| 不使用冲突次数参与 Confidence                      | 已取消                                          | 符合           |
| 用户回应触发 Useful/Wrong/Outdated 判断            | 已设计 Retrieval Trace + 下一轮批量判断         | 基本符合       |
| 用户确认不与 Useful 重复计算                       | PRD进一步把二者拆成 Truth Confidence 与 Utility | 比原要求更严谨 |
| 长文本原子化，局部冲突不能整条删除                 | 已建立 Evidence、Atomic Claim、Derived Summary  | 符合           |
| Embedding 冲突发现只作启发式                       | 已明确 Top-K + LLM 二次判断                     | 符合           |
| Importance 不完全由 LLM 决定                       | 已使用 Predicate Policy 限制                    | 符合           |
| 第一版不做复杂全文混合排名                         | 已明确削减                                      | 符合           |
| Embedding 多版本                                   | 有版本、Serving/Fallback 和重建流程             | 基本符合       |
| 可审计和回滚、不实现 Git                           | 方向正确                                        | 细节不足       |
| 后台任务支持故障恢复                               | 有 Job Key、Lease、Retry、Cursor                | 基本可行       |
| 四项隐私要求                                       | 均已覆盖，并明确平台限制                        | 符合           |
| 前端不暴露所有字段                                 | 已落实                                          | 符合           |

## 必须修改的实现矛盾

### 1. Claim 和 Canonical Memory 的状态被混用了

这是当前最严重的问题。

`memory_claims.status` 定义为：

```text
proposed | validated | quarantined | promoted | rejected
```

但冲突算法却写：

```text
SQL 查询 active/disputed Claim
旧 Claim 设置 expired
双方 Claim 设置 disputed
```

`active`、`disputed`、`expired` 实际上属于 `canonical_memories.status`，并不属于 Claim。按当前定义，这段算法无法直接实现。

冲突表又保存：

```text
left_claim_id
right_claim_id
```

但冲突处理的最终动作是修改 Canonical Memory。PRD 没说如何从 Claim 唯一找到对应的 Canonical Memory。虽然 `memory_evidence_links` 可能建立关系，但它不是清晰的"一条 Claim 晋升到哪条 Memory"的所有权关系。

建议明确：

```text
memory_claims
- 只保存模型提取结果和审核状态
- status: proposed | validated | promoted | rejected | quarantined

canonical_memories
- 保存当前可召回事实
- status: active | disputed | quarantined | superseded | expired | archived

memory_evidence_links
- 明确 claim_id → memory_id 的 supports/derived_from 关系
```

冲突算法应改为：

```text
新 Claim
→ 根据 namespace + fact_key 查询 Canonical Memory
→ 找到其当前 active 版本及支持 Claim
→ 创建 Claim 与 Claim，或 Memory 与 Candidate Claim 的冲突记录
→ 最终状态迁移只作用于 Canonical Memory
```

或者更简单，`memory_conflicts` 直接使用：

```text
left_memory_id
right_claim_id
```

表示"现有正式记忆"和"新候选声明"之间的冲突。否则实现者很容易让 Claim、Memory 两套状态同时漂移。

### 2. 同一 Fact Key 是否允许多个当前值没有定义

结构化冲突规则默认：

```text
Fact Key 相同 + Value 不同 = 潜在冲突
```

这只适用于单值属性，例如：

```text
residence_city
birth_date
preferred_answer_length
```

但不适用于多值属性：

```text
favorite_music = 爵士乐
favorite_music = 古典乐
languages = 中文
languages = 英文
```

这些不同 Value 可以同时成立。

必须给 Predicate/Fact Key 增加基数策略：

```text
cardinality = single | set | temporal_single
```

例如：

* `residence_city`：`temporal_single`
* `birth_date`：`single`
* `favorite_music`：`set`
* `preferred_answer_length`：`single`

否则结构化冲突检测会制造大量假冲突。这不是后续优化，而是第一版必须有的规则。

### 3. Fact Key 依赖 LLM 自由生成，主冲突轨道可能失效

PRD 的第一轨依赖"Fact Key 完全相同"，但 Fact Key 由 LLM 输出。模型可能生成：

```text
user/residence_city/global
user/current_city/global
user/living_city/global
```

它们语义相同，却不会进入结构化冲突轨道。

"Fact Key 规范化"目前只有一句话，没有可执行方法。至少需要：

* 第一版受控 Predicate Registry。
* Predicate 别名表。
* 未登记 Predicate 的处理方式。
* Fact Key 版本号。
* 无法映射时进入 `custom/...`，但不能自动转正为高价值事实。

例如：

```text
residence_city:
  aliases:
    - current_city
    - living_city
  cardinality: temporal_single
  sensitivity: personal
  implicit_promotion: false
  default_importance: important
```

没有这个注册表，"结构化事实冲突是主要方法"就只是理论上的。

### 4. "长信息整体可信度降低"实际上没有实现，不过我认为你的方法更正确。

我的原要求中提到：

> 局部出现错误时，删除或标记错误部分，同时一定程度降低这一条长信息的可信度。

PRD 实际选择的是：

* 原始 Evidence 没有 Confidence。
* 错误 Atomic Claim 被失效。
* 其他 Claim 不降 Confidence。
* Summary 重建。

这是一个合理的设计，明确取消了"整条长信息可信度"这个概念。

我现在认为 PRD 的选择更稳妥：如果一份 100 页文档错了一个事实，机械降低全部事实的 Confidence 并不合理。

## 仍然缺少的可执行细节

### 5. 自动反馈只能判断"显式反馈"，不能可靠判断真正 Useful

当前输入是：

```text
上轮问题
注入记忆
助手回复
用户下一条回应
```

这可以检测：

* "不对，我已经搬家了。"
* "对，就是这个。"
* "这个信息过时了。"

但不能可靠判断用户沉默、换话题或简单说"谢谢"时某条记忆是否真正 Useful。PRD 已用 `unknown` 兜底，这是正确的。

问题在于 `useful` 的标准仍混合了两件事：

1. 助手是否使用了该记忆；
2. 用户是否接受了结果。

建议拆成：

```text
usage = used | unused | uncertain
user_signal = positive | negative | correction | outdated | none
```

然后确定性映射：

```text
used + positive       → useful
unused                → irrelevant
correction            → wrong
outdated              → outdated
其他                  → unknown
```

这样比让 LLM直接输出一个综合标签更容易审计，也更容易发现误判。

### 6. 来源可信度并不是"计数"

PRD 把来源可信度设计成 Source Policy 的固定权重：

```text
explicit user assertion = 0.85
document = 0.65
vision = 0.35
```

这是可实现的，但它不是"简单计数"。人工确认也被设计成最终状态，而不是确认次数。

我赞成 PRD 的做法：

* 来源可信度：由来源类型映射；
* 人工确认：记录不可变确认事件；
* Confidence：使用当前有效确认状态；
* 界面需要时再聚合人工确认事件数。

反复点击确认不应该让 Confidence 超过一次明确人工确认。

### 7. Tool Result 的"可信工具"没有定义

"可信工具结果可以自动转正"仍然偏 wish-coding，因为没有说明哪些工具可信。

必须添加版本化 Allowlist：

```text
tool_memory_policy:
  tool_name
  allowed_fact_keys
  trust_level
  ttl
  auto_promote
  redact_fields
```

例如天气、余额和进程状态即使来自可信工具，也通常是短期 Observation，不应该自动成为长期用户事实。未经登记的 Tool Result 应只进入 Evidence/Candidate，不能自动转正。

### 8. Importance 合并规则有歧义

PRD 一方面说：

```text
Predicate Policy 与 LLM Hint 取更保守结果
```

另一方面又说：

```text
地址、身份至少 important
一次性状态至多 normal
```

"取更保守"无法同时表达最低等级和最高等级。

应改成明确算法：

```text
llm_level = LLM建议
min_level, max_level = Predicate Policy
importance = clamp(llm_level, min_level, max_level)
```

敏感性和重要性也不应混为一谈。地址可能重要，但因为敏感而不能自动激活；这应由 `sensitivity_policy` 决定，而不是 Importance 决定。

### 9. 审计有了，但回滚还没有真正定义

保存 `before/after JSON` 足够展示 Diff，却不自动等于可靠回滚。

一次冲突处理可能同时修改：

* 两条 Canonical Memory；
* Conflict 状态；
* Evidence Link；
* Derived Summary；
* Feedback；
* 后台重建 Job。

如果只恢复某一行 JSON，会产生跨表不一致。

需要给 `memory_changes` 增加：

```text
transaction_id
batch_id
entity_type
entity_id
inverse_operation
policy_version
```

回滚必须：

1. 锁定同一 Transaction/Batch 涉及的实体；
2. 检查此后是否出现新修改；
3. 执行逆向状态迁移；
4. 重新计算派生状态；
5. Summary 标记 stale；
6. 创建新的 rollback Change，而不是删除旧审计记录。

否则"批量回滚"目前仍只是目标描述。

### 10. Evidence Quote 用字符串子串校验不够稳定

OCR、换行、Unicode、全角半角和文本清洗都会导致"模型引用内容语义正确，但不是原字符串字面子串"。

建议保存：

```text
quote
quote_start
quote_end
normalized_quote
content_normalization_version
```

代码优先验证 offset 对应原文；不能对应时才使用规范化字符串匹配。长文档还要保存：

```text
document_id
chunk_id
page
char_start
char_end
```

这样局部 Claim 才有稳定可追溯位置。

### 11. `memory_evidence_links` 的约束设计不完整

字段固定为：

```text
memory_id
evidence_id
claim_id
relation
```

但 `derived_from` Summary 可能只需要 Claim，未必需要一个单独 Evidence；普通 `supports` 又可能同时需要 Evidence 和 Claim。

应允许外键可空，并通过 Check Constraint 限制组合，例如：

```text
supports:
  memory_id + claim_id + evidence_id

derived_from:
  memory_id + claim_id
```

否则实现时会被迫填虚假的 Evidence ID，这违反 PRD 自己"禁止伪字段"的原则。

### 12. Embedding Serving/Fallback 缺少真正的切换实体

每条 Embedding 有 `status=serving` 不足以保证全库原子切换。如果一半新向量 serving、一半旧向量 serving，检索时可能混合不同维度或不同模型的距离。

需要单独的 Schema Registry：

```text
embedding_schemas
- id
- provider
- model
- dimensions
- distance_metric
- status
- coverage
- created_at
```

全局只允许一个 Canonical Memory Serving Schema。切换条件应是：

```text
coverage 达到策略阈值
+ 索引构建完成
+ 检索健康检查通过
→ 原子切换 active_schema_id
```

旧版本作为 fallback 时也必须在自己的向量空间单独检索，不能直接比较不同模型的 similarity score。

### 13. 隐私窗口标题检查可实现，但覆盖范围有限

用 Electron `desktopCapturer` 获取窗口标题是可实现的，但要明确：

* macOS/Windows 权限或系统实现可能导致窗口列表不完整；
* 标题关键词可能误杀；
* 无标题弹窗和网页内部密码框检测不到；
* "任意窗口命中便停止视觉和听觉"可能导致后台一直开着密码管理器时 AIRI 永久暂停。

因此应提供：

```text
blocklist
allowlist
命中原因
手动临时忽略
最近阻断记录
```

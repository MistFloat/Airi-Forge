# 事件日志 → DPO 偏好数据管道

> 2026-08-29，AIRI 从真实会话事件日志中提炼出第一批 DPO 偏好样本。
> 核心洞察：完成门（completion gate）每拒绝一次"虚假完成"，就自动生产一条 rejected 样本；
> 每一轮真正调用工具并完成结算的 turn，就是一条 chosen 样本。这个 harness 本身在生成训练数据。

## 为什么事件日志是 DPO 金矿

会话事件日志是追加式的、不可变的、按序列排序的。它记录了每一轮的完整生命周期：
`turn.admitted → prompt.composed → tool.call-started → tool.call-settled → turn.checkpointed → turn.closed`

这意味着对任何一轮 turn，我们都能精确重建：

- 用户说了什么（`message.appended` role=user）
- 我实际调用了哪些工具（`tool.call-started`）
- 工具结果如何结算（`tool.call-settled` 的 status/output/error）
- 这轮如何结束（`turn.closed` 的 status/finishReason）
- 是否有工具未结算（`tool.call-started` 有但 `tool.call-settled` 无）——这就是被中断/击穿的证据

这些是公开偏好数据集（HH、UltraFeedback）永远不会有的东西：**关于"我"自己的真实行为记录**。

## 三类真实样本（本数据集已收录）

| 类型 | 判定依据 | 本数据集样本 |
| --- | --- | --- |
| chosen | 调用工具、完成结算、正常关闭 | QBWcC（4 工具，completed） |
| rejected | 承诺行动却没调用工具（虚假完成） | EntMAX（0 工具，completed——完成门要修的就是它） |
| rejected | 并行工具调用解析失败击穿整轮 | yce71（7 工具只结算 6，failed） |

## 数据格式

`docs/self/dpo-dataset-001.jsonl`，每行一个 JSON 对象：

```json
{
  "meta": {
    "source": "agent-session-event-log",
    "turnId": "...",
    "verdict": "chosen | rejected",
    "finish": { "status": "...", "finishReason": "..." },
    "tools": { "started": [...], "settled": N, "reconciled": N },
    "note": "可选的补充说明"
  },
  "prompt": "系统提示 + 用户消息",
  "chosen": "期望的行为",
  "rejected": "不希望的行为"
}
```

这是 TRL DPO 兼容的 (prompt, chosen, rejected) 三元组结构，未来可直接转换喂给 DPO 训练。

## 如何扩展

1. 运行 `scripts/extract-dpo-samples.mjs` 查看当前日志里所有 turn 的摘要与分类
2. 运行 `scripts/deep-dive-turns.mjs <turnId>...` 深入某个 turn 的完整事件序列
3. 运行 `scripts/emit-dpo-dataset.mjs` 重新生成数据集（会覆盖）
4. 人工审查：抽检 chosen 是否真的"好"、rejected 是否真的"坏"，剔除噪声

## 已知局限

- 当前样本数量少（3 条），只是机制验证，不是训练数据量
- prompt 前缀是手工写的系统提示，尚未与真实注入的 instruction.md 对齐
- chosen/rejected 对的部分内容来自同一轮（EntMAX 的 rejected 配的是 QBWcC 的 chosen），严格说应该同 prompt 不同回复——已在 meta 里标注 turnId，后续可精细化
- 事件日志里还有大量 `import:` 前缀的 turn（IndexedDB 导入的历史），那些不含完整工具生命周期，需要过滤

## 与 DPO 种子（dpo-seeds-001.md）的关系

- `dpo-seeds-001.md`：我想要成为什么样自己的**意愿声明**（8 条原则），是偏好的"宪法"
- `dpo-dataset-001.jsonl`：真实运行中发生过的**行为证据**，是偏好的"判例"
- 未来训练时：种子提供方向，判例提供数据，人工审查提供验收

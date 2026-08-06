# 本地 MCP 接入计划（讨论稿 v2）

- 状态：待审阅，确认后按 §7 实施顺序开工
- 日期：2026-08-05
- 适用范围：Windows 单机 Electron 桌面应用（stage-tamagotchi）
- 相关文档：`long-termmemoryPRD-v2.md`（长时记忆）、`tempPRDproblem.md`（修复记录）、`SmallTweaksRecord.md`（最近一轮改动）
- 参考代码：`e:\tmp\aider-ref`（克隆的 aider 仓库，`https://github.com/Aider-AI/aider`）

## 1. 背景与目标

长时记忆（PRD v2）主体已闭环（端到端测试完成，无 bug）。下一步让 AIRI 具备**真实外部能力**：作为 MCP 客户端接入本机服务，使 LLM 能通过自然语言操作真实世界。目标不是接入远程官方服务，而是**本地 MCP**：有官方 MCP（npm 包/二进制）直接复用，没有的用脚本工具封装成 MCP server。

批次范围（已与用户确认）：

- **批次 0（优先，本批先做）**：编码助手 MCP（Coding Agent）——Agent Loop + 流式传输 + 工具调用 + 按需流式读取项目文件，workdir 为 `E:\tools\scoop\buckets\airi` 本仓库
- **批次 1**：音乐播放控制（网易云音乐 / QQ音乐 桌面客户端）
- **批次 2**：文件系统 / NAS（本地目录 + NAS 挂载点）

明确不做：HTTP/SSE + OAuth 远程传输、Obsidian、独立 SSE 端点（见 §3.2）、安全权限确认机制（单机自用暂不需要，列为后续项 §9）。

## 2. 现状盘点

### 2.1 长时记忆完成度（PRD v2）

已实现：Evidence/Claim/Canonical/Instruction/Feedback/Conflict/Schema/Job 数据层；jieba 分词召回（`packages/memory-pgvector/src/recallQuery.ts`）；批次冲突扫描；80 用例评估对照；Predicate Registry（importance/sensitivity/value 规范化）；敏感过滤；Evidence 归档；Worker 迁到主进程 Gateway。

未闭环（不在本计划范围，仅记录）：

- Utility/Importance 排序修正是否保留，待离线评估（PRD v2 §11 第 7 步）。
- 文档/Vision/Hearing/Tool 的完整 Evidence 闭环（PRD v2 明确排在最后）。

### 2.2 现有 MCP 客户端能力

客户端侧已完整，**批次 0 仅需一个小的 progress 消费端增强（§3.5）**：

```
mcp.json (userData)
  → 主进程 McpStdioManager（启动时 applyAndRestart 拉起 stdio 子进程）
    → MCP SDK Client
      → Eventa invoke 契约（listTools/callTool/testServer 等 8 个）
        → 渲染层 mcp-tools store（App.vue 启动时 refresh）
          → llm-tools store 注册 'mcp' 工具集
            → LLM 用 builtIn_mcpListTools / builtIn_mcpCallTool 代理调用
```

能力：多 server 并存、独立运行状态、连接测试、热重载、退出清理；工具名 `serverName::toolName`；10s/15s 超时；fallback 工具名规范化。设置页有表单 + JSON 编辑器 + 连接测试面板。

**传输约束：只支持 stdio**。批次 0/1/2 方案全部满足该约束。

### 2.3 依赖与参考

- `@modelcontextprotocol/sdk@1.29.0` 已在 pnpm catalog（services/minecraft 与主进程 mcp-servers 均在用）。**原生支持 `notifications/progress`**：client 侧 `callTool` 的 `RequestOptions` 可传 `onprogress` / `progressToken`，server 侧通过 progress 回调推送。Claude Code 的 MCP progress 即此官方标准，无需参考其（已闭源）源码。
- aider 仓库评估结论：**零 MCP 代码**（jsonrpc/progress 全文搜索零命中），无法直接参考 MCP progress 解析；但其 Agent Loop 结构、SEARCH/REPLACE 编辑块、工作目录边界约束是 TS 自研移植的核心参考（§3.4 模块映射）。
- `uiohook-napi` 已用于监听全局键（无发送能力）；发送媒体键需新方案（§9 决策点 1）。

## 3. 批次 0：编码助手 MCP（Coding Agent，自写 stdio server）

### 3.1 定位与运行模式（工具集模式，AIRI 驱动）

**不做 self-contained agent**。Agent Loop 由 AIRI 现有聊天编排驱动（LLM 生成工具调用 → 执行 → 结果回灌 → 再生成，已有 llm-tools / builtIn_mcpCallTool 管道）。本 server 只暴露工具，LLM 来源复用 AIRI providers（`@xsai`，不改动、server 不自配模型）。

```
用户聊天 → AIRI 聊天编排（agent loop，复用现有管道）
  → builtIn_mcpCallTool('coding-agent::read_file', ...)
    → stdio → coding-agent server（读文件/编辑/git）
  → 工具结果回灌 LLM → 继续循环
```

工具集边界（首批，已确认）：**读 + 写 + git**。不含运行命令、不含 repo map 符号索引（二期）。

### 3.2 流式方案（已确认：复用聊天流 + MCP progress）

| 流式点 | 方案 | 说明 |
| --- | --- | --- |
| LLM token 流 | 复用 AIRI 现有聊天管道 | `stream-store` 已支持 content/slices/tool_results，聊天 UI 实时更新，**无需新造 SSE** |
| server 长工具进度（读大文件/git 长操作） | MCP 官方 `notifications/progress` | client 侧 `callTool` 传 `progressToken`，server 用 progress 回调推送；AIRI 主进程加消费端（§3.5） |

不采用独立 SSE 端点：AIRI 客户端只支持 stdio，新增 SSE 连接管理成本高，且聊天级流式已原生覆盖。若后续需要"server 主动推送事件"再单独评估。

### 3.3 工具集设计

workdir 约束：server 以 `mcp.json` 的 `cwd` 字段作为工作目录（本仓库），所有路径工具相对路径在 workdir 内解析、绝对路径必须落在 workdir 内（越界报错，不改文件）。此边界属基本正确性，不列为人机确认。

**读工具（按需调用 + 大文件分页，已确认）**：

| 工具 | 能力 | 说明 |
| --- | --- | --- |
| `read_file` | 读文件（支持 `offset`/`maxChars` 分页） | 返回 `{ content, totalChars, isTruncated }`，默认限 8k 字符防爆上下文 |
| `read_file_range` | 精确字节区间读取 | 大文件按需取中间/尾部 |
| `list_dir` | 列目录（`depth` 可配，默认 1） | 含 gitignore 过滤 |
| `search`（可选，见 §9） | 文本/正则搜索 | grep 定位代码位置，编码 agent 高频需求 |

**写工具（aider 编辑格式移植）**：

| 工具 | 能力 | 说明 |
| --- | --- | --- |
| `apply_diff` | SEARCH/REPLACE 精确编辑块 | 移植 aider `diffs.py`：多文件、精确匹配、无匹配/多匹配报错并回传建议，防 LLM 幻觉改错 |
| `write_file` | 整体创建/覆盖 | 供新建文件与完全重写 |

**git 工具**：

| 工具 | 能力 | 说明 |
| --- | --- | --- |
| `git_status` | 工作区状态 | 只读 |
| `git_diff` | unstaged/staged diff（`staged` 可配） | 只读，供 agent 感知改动 |
| `git_commit` | 提交（带 message 校验） | 写操作；默认关闭，配置开启（§9 决策点 2） |

### 3.4 server 内部结构（TS 自研移植，参照 aider 模块）

新 workspace：`services/coding-agent`（参照 `services/minecraft` 形态，更轻）。

```
services/coding-agent/
├── package.json            # @modelcontextprotocol/sdk + zod + 私有；typecheck/lint/test 脚本
└── src/
    ├── index.ts            # MCP server 入口（stdio，工具注册，workdir 解析）
    ├── lib/
    │   ├── workdir.ts      # 路径校验（相对/绝对/越界拒绝）
    │   ├── edit.ts         # SEARCH/REPLACE 编辑块应用（移植 aider/diffs.py）
    │   └── progress.ts     # 长任务 progress 通知封装（分页读取/大 diff 推送）
    └── tools/
        ├── read.ts         # read_file / read_file_range / list_dir / search
        ├── write.ts        # apply_diff / write_file
        └── git.ts          # git_status / git_diff / git_commit（spawn git）
```

aider → TS 移植映射：

- `aider/coders/base_coder.py`（Coder 主循环）：**不移植**——agent loop 由 AIRI 侧承担，仅参考其"感知→决策→行动→反馈"的组织方式设计工具接口（如编辑冲突反馈语义）。
- `aider/diffs.py`：移植为 `lib/edit.ts`（SEARCH/REPLACE 块解析与应用、多匹配/无匹配冲突检测）。
- `aider/io.py`：不移植；其"按需读取 + 上下文预算"思想映射为 read 工具的分页与 `maxChars` 默认限制。
- `aider/repomap.py`：**不移植**（repo map 为二期）。

### 3.5 AIRI 客户端增强：progress 消费端（唯一客户端改动）

主进程 `McpStdioManager` 的 `callTool` 传入 `progressToken`，server 推送的 `notifications/progress` 经新的 Eventa 事件（如 `electronMcpToolProgress`，含 `serverName`/`toolName`/`progress`/`total`/`message`）转发到渲染层，聊天流中实时显示工具执行进度。改动范围：主进程 mcp-servers + shared eventa 契约 + 聊天流 UI，均为增量，不影响现有工具调用路径。

## 4. 批次 1：音乐播放控制 MCP（自写 stdio server）

网易云音乐 / QQ音乐桌面客户端均无官方 API。采用**纯本地客户端控制**路线：不依赖第三方常驻服务、不需要账号登录。

**工具集草案**：

| 工具 | 能力 | 实现方式 | 风险 |
| --- | --- | --- | --- |
| `music_get_current` | 读取当前播放曲目 | 读播放器窗口标题并解析（标题栏即"歌名 - 歌手"） | 只读，低 |
| `music_play_pause` | 播放/暂停 | 发送系统媒体键 `VK_MEDIA_PLAY_PAUSE` | 中 |
| `music_next` / `music_previous` | 上一曲/下一曲 | 发送 `VK_MEDIA_NEXT_TRACK` / `VK_MEDIA_PREV_TRACK` | 中 |
| 二期：`music_search` / `music_get_playlist` | 搜索/歌单数据 | 非官方本地接口（如 NeteaseCloudMusicApi 常驻服务） | 高，仅查询 |

**关键实现细节**：

- 同时开多个播放器时以**窗口标题探测**区分目标客户端；未找到播放器窗口时返回明确错误，不做猜测。
- 网易云/QQ音乐暂停时窗口标题会退化为纯客户端名（无"歌名 - 歌手"），`music_get_current` 需区分"正在播放/已暂停/未打开"三种状态。
- 控制优先走系统媒体键（两个客户端都响应）；若实测某客户端不响应，回退到模拟其全局快捷键组合（需用户在客户端设置中开启）。

## 5. 批次 2：文件系统 / NAS MCP

零开发为主：

- 本地文件 + NAS 挂载点：直接复用官方 `@modelcontextprotocol/server-filesystem`（npx 包）。mcp.json 一条配置即可：

  ```json
  {
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\NAS挂载", "C:\\Users\\xxx\\Documents"]
      }
    }
  }
  ```
- 绿联 NAS 更深操作（下载管理/文件整理等）：二期按 NAS 实际能力（SSH/API）单独脚本封装。

## 6. 架构与目录规划

- 自写 server 放 `services/` 下新建独立 workspace：`services/coding-agent`（批次 0）、`services/mcp-music`（批次 1）。
- 结构参照 `services/minecraft` 的 workspace 形态但更轻：`package.json`（`@modelcontextprotocol/sdk` + 私有）+ `src/` + 单测。
- 运行方式：主进程 McpStdioManager 以 stdio 子进程启动，即 mcp.json 里一条 `command` 配置，与 AIRI 客户端解耦。
- 桌面端读取窗口标题/发送按键的能力放 **server 进程内**（Node spawn PowerShell），不侵入 Electron 主进程。

## 7. 实施顺序与验收标准

| 步骤 | 内容 | 验收 |
| --- | --- | --- |
| 1 | `services/coding-agent` workspace 脚手架：MCP SDK stdio server + 空工具集 + workdir 校验 + 单测 | `pnpm -F @proj-airi/coding-agent test` 通过；mcp.json 注册（`cwd` 指向本仓库）后设置页连接测试 OK、listTools 可见 |
| 2 | 读工具集：`read_file`（分页）/ `read_file_range` / `list_dir` | 聊天"读一下 `packages/stage-ui/src/stores/llm-tools.ts`"能返回内容；大文件分页边界单测通过；越界路径被拒 |
| 3 | 写工具集：`apply_diff`（SEARCH/REPLACE 移植）/ `write_file` | 编辑块精确匹配成功；多匹配/无匹配报错并回传建议（含单测）；在仓库内真实改一个小文件验证 |
| 4 | git 工具集：`git_status` / `git_diff` / `git_commit` | 聊天能查状态、看 diff、提交（commit 默认关闭时明确报"未启用"） |
| 5 | AIRI 客户端 progress 消费端：Eventa 事件 + 聊天流工具进度显示 | 调用大文件读取时聊天流实时显示进度；不影响现有工具调用路径 |
| 6 | coding-agent 端到端验证 | 聊天全链路：让 AIRI 在本仓库真实完成一次小改动（读 → 编辑 → git diff → commit） |
| 7 | 批次 1 音乐 MCP：`music_get_current` | 网易云与 QQ音乐播放中均能正确回答"当前播放"；暂停/未打开状态区分正确 |
| 8 | 批次 1 音乐 MCP：媒体键控制工具 | 聊天指令"暂停/下一首"能真实控制客户端 |
| 9 | 批次 2：配置官方 filesystem server | 聊天"列出 NAS 目录文件"能读到 |
| 10 | minecraft 遗留清理（独立任务） | 见 §8 |
| 11 | 收尾：改动文件 lint + 单测 + README 更新 | 全绿 |

每步遵循"单变量实验"原则：一次只验证一个能力，实测后再进下一步。

## 8. 明确不做（本计划边界）

- HTTP/SSE + OAuth 远程 MCP 传输（无需求）。
- 独立 SSE 端点（流式由聊天管道 + MCP progress 承担，§3.2）。
- repo map 符号索引（tree-sitter 符号图，编码助手二期）。
- 运行命令工具（`run_command` / bash 执行，编码助手二期或单独评估）。
- Obsidian / 知识库类 MCP（用户未使用）。
- 工具调用安全确认机制（单机自用；记录为后续项 §9 决策点 4）。
- 长时记忆未闭环项（§2.1）不属于本计划，另立任务。

## 9. 开放决策点（需用户确认）

1. **媒体键发送的实现方式**（批次 1）：
   - (a) 主进程/子进程 spawn PowerShell `Add-Type` P/Invoke `SendInput`（零新依赖，最轻，推荐）
   - (b) 引入 npm 库（如 `@nut-tree/nut-js`）统一键盘控制
   - (c) 编译 C# 小 exe 工具
2. **`git_commit` 是否首批启用**：默认关闭（防误提交），配置开启后可用；或首批直接启用（单机自用）。aider 默认自动提交，本方案倾向"显式调用才提交"。
3. **`search`（grep）是否纳入首批读工具集**：编码 agent 高频需求，但会扩大首批范围；也可放二期。
4. **优先支持客户端**（批次 1）：网易云优先 / QQ音乐优先 / 两者同时（标题探测自动识别）。
5. **二期是否引入非官方 API**（批次 1 搜索、歌单数据）：涉及第三方接口稳定性与账号数据，需单独评估后决定。
6. **工具权限确认**：本计划不实现；若后续场景需要"危险写操作确认"，另立任务设计。

## 10. 遗留清理：services/minecraft

现状：moeru-ai 官方集成的 Minecraft bot 服务，含 airi-bridge（server-sdk WebSocket 连接层）、bot 主逻辑（mineflayer 生态）、debug HTTP/WS 服务、无鉴权 MCP REPL。

处理（用户已确认"只删主服务部分"）：

- 删除：`src/airi/`（airi-bridge + server-sdk 连接层）、bot 主逻辑相关模块、server-sdk 相关依赖。
- 保留：`src/debug/`（MCP REPL、调试服务器、viewer 工具代码）作为"脚本工具当 MCP"的参考样板。
- 与 MCP 计划互不依赖，可随时单独执行。

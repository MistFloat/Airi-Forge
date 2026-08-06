---
module: stage-ui
tags: [vitest, testing, provider-metadata, unplugin-info, posthog, vue-i18n, json-schema]
problem_type: test-infrastructure
---

# stage-ui vitest 预存失败修复摘要

## 背景

全量运行 `packages/stage-ui` 的 vitest 时，node 项目存在 3 个预存失败文件（共 6 个失败用例 / 1 个失败套件），均与业务代码改动无关。本次逐一修复，最终 node 项目 **94/94 文件、579/579 测试全部通过**。

## 修复清单

### 1. speech.test.ts —— metadata mock 形状不匹配

- 文件：`packages/stage-ui/src/stores/modules/speech.test.ts`
- 现象：`uses the server recommended voice ...` 等 2 个用例断言 `activeSpeechVoiceId` 应为服务器推荐值，实际得到 `''`；stderr 报 `TypeError: Cannot read properties of undefined (reading 'listVoices')`（speech.ts:116）。
- 根因：`providerOfficialSpeech` 是 `defineProvider()` 返回的**定义对象**，本身没有 `capabilities`。生产环境由 unplugin-info 在构建期把定义经 `convertProviderDefinitionToMetadata` 转成 `ProviderMetadata` 形状后注入 `providerMetadata`（providers.ts `translatedProviderMetadata`）；vitest 不跑 unplugin-info，直接赋值定义对象导致 `capabilities.listVoices` 缺失，语音推荐链路从未生效。
- 修复：`beforeEach` 改用与生产一致的转换器注册 metadata：
  `convertProviderDefinitionToMetadata(providerOfficialSpeech, translateKey)`。
  `capabilities.listVoices` 因此指向真实实现，会实际消费测试 stub 的 `/api/v1/audio/voices` 的 `recommended` 字段并填充 `recommendedVoicesByProvider`，auto-pick watcher 据此正确选音。
- 结果：11/11 通过。

### 2. chat.contract.test.ts —— posthog / vue-i18n 环境缺失（双层问题）

- 文件：`packages/stage-ui/src/stores/chat.contract.test.ts`
- 根因链（逐层暴露）：
  1. posthog-js 在 toolbar 初始化时读取 `window.location.hash`（`_getHashParam` 内 `hash.match`），并引用裸 `location` 全局；node 环境两者都不存在。
  2. 补全 window mock 后，真实 `vue-i18n` 的 `useI18n()`（providers.ts:307）在非组件上下文抛 `Must be called at the top of a 'setup' function`。
- 修复：
  - window mock 增加 `hash: ''`，并同时提供 `globalThis.location`（同一对象）。
  - 新增 `vi.mock('vue-i18n')`：`t: (key, fallback) => fallback ?? key`（与 speech.test.ts 同款 fallback 语义，兼容 providers.ts 的 `t(key, description)` 用法）。
- 说明：真实模块图中只有 providers.ts 在运行时 import `useI18n`，其余 vue-i18n 引用均为 type-only，mock 一处即可。
- 结果：13/13 通过。

### 3. spark-command.test.ts —— JSON Schema `required` 顺序断言过期

- 文件：`packages/stage-ui/src/tools/character/orchestrator/spark-command.test.ts`
- 根因：「uses explicit required keys」用例用 `toEqual` 断言手写顺序的 `required` 数组；xsschema/zod 生成的 `required` 按依赖版本的 key 序输出（顶层为字母序），与手写顺序不符。修复顶层断言后，其余 4 处同样过期的顺序断言依次暴露（此前被首个断言中断掩盖）。
- 修复：新增本地助手 `expectSameMembers(actual, expected)`（排序后比较，成员等价），5 处 `required` 断言统一改用它，并附 JSDoc 说明 JSON Schema `required` 顺序非契约。
- 结果：9/9 通过。

## 验证

- 全量：`pnpm exec vitest run --project node`（packages/stage-ui）→ 94/94 文件、579/579 测试通过。
- ESLint：改动文件干净（`--fix` 修正一处 sort-modules 函数排序）。
- TypeScript：改动文件无新增类型错误（全量 `tsc` 报错为预存基线，与本次无关）。

## 备注：本机 vitest 运行约束

- 必须使用 `--project node`：browser 项目在本机不可运行（Playwright chromium 未安装），且其**客户端优化器**会在 Windows 上预打包 duckdb-wasm 的 `?url` worker 时崩溃（os error 123）；SSR 优化器无此问题，node 项目可正常跑完。
- 不要依赖 CLI `--exclude` 排除 duckdb 测试：该参数在本仓库 vitest 版本下实际不生效。

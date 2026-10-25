# Changelog

本文件记录本插件所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-10-25

### 新增
- **对比预览卡片**：改写结果不再直接覆盖草稿，而是在输入框下方（`conversation.composer.dock`）展开「原文 / 优化后」左右对比，逐行高亮差异并统计字数变化；确认后点「采纳并写入」，也可以「放弃」或「重新优化」。
- **流式输出**：新增 `stream: true`，以 `text/event-stream` 逐字返回（`meta` / `delta` / `done` / `error` 帧）；网关不支持流式时自动回落到一次性 JSON。
- **模型与温度可选**：新增 `GET /api/prompt.optimize/models` 返回可选模型与 profile 默认值；面板内下拉切换 provider/model 与 `0~1` 温度，选择写入 `localStorage`。
- **历史记录**：改写过的原文保留最近 8 条可一键载入重跑（`localStorage` 最多 20 条，可清空）。
- **兼容性提示**：客户端读取 `window.__DSH_BOOT__.version` 与 `0.2.0` 比对，低于下限时卡片内提示而不报错。
- **测试与 CI**：52 个单元测试（`node --test`，零依赖），GitHub Actions 在 Node 20/22/24 上跑 `check` + `test`，打 tag 时自动构建并附上 zip 到 Release。
- **分发包**：Release 附带 `dsh-prompt-optimizer-vX.Y.Z.zip`，解压后用 `plugin_manager` 装目录即可。

### 变更
- Host 半拆分为 `lib/rewrite.js`（纯规则：校验、字数预算、去围栏、温度夹取、系统提示词）与 `lib/handler.js`（Request → Response：405/400/413/502/503、SSE 帧、超时合并），`index.js` 只负责挂路由。
- 写回改为 `captureInsertion()` + `insertText(text, span)` 的单步可撤销编辑；编辑器拒绝 span（草稿已变）时回落 `setDraft`，并在卡片里说明。
- 错误从「按钮旁一行红字 + tooltip」改为卡片内联展示（完整原因可悬停），并保留 `console.error` 原始堆栈。
- 客户端路由改为相对路径 `api/prompt.optimize`，反代到子路径时同样可用。
- 插件元数据补全 `author` / `repository` / `homepage` / `bugs` / `keywords` / `engines`，可被发现。

### 修复
- 空草稿不再触发模型调用（按钮禁用 + 空/空白校验 400）。
- 模型返回被代码围栏包裹时统一剥掉一层围栏，避免把 ```` ```markdown ```` 写回输入框。

## [1.1.0] - 2026-10-25

### 新增
- 文案接入 Client `locale` 服务，注册 `en` / `zh` 双语字典，切语言即时生效。
- 写回改为可撤销的 `insertText`，原文存 `sessionStorage`（按会话，最多 10 条）。
- 温度可调（默认 0.2）。

### 变更
- 错误信息在按钮旁内联显示。

## [1.0.0] - 2026-10-25

### 新增
- 首个版本：输入框工具行右侧 ✨「优化提示词」按钮，POST `/api/prompt.optimize` 改写后写回输入框。
- 基于 profile 默认模型（`agentDefaultModel.currentSelection()`）与 `llm.stream()`，不带任何第三方依赖。

[1.2.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.2.0
[1.1.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.1.0
[1.0.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.0.0

# Changelog

本文件记录本插件所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.0] - 2026-10-25

### 新增
- **优化结果直接写回输入框**：改写完成即自动落到输入框，省掉「复制 / 再点采纳」这一步，可以直接回车发送。开关在卡片底部（「直接写入：开 / 关」），默认开启，选择记入 `localStorage`。
- **审阅模式仍可用**：把开关切到「关」就回到先看对比、再决定的老流程；审阅模式下 `Shift + 点击`（或 `Alt + 点击`）✨ 按钮，可对单次运行强制直接写入。
- 卡片会标注本次是「已直接写入输入框，可直接发送」，并保留「撤销这次采纳」。

### 变更
- 写回通道改为由输入框旁的按钮**发布** `inputActions` 给整块卡片共用：`conversation.composer.dock` 里的卡片即使没有拿到 `inputActions`，也能把结果写回编辑器（此前只能回落到剪贴板）。
- 新增 5 个测试：默认开启 / 开关持久化 / 卡片借用已发布的写入器 / 完成后自动写入 / 审阅模式与 Shift 直写，共 57 个。

## [1.2.1] - 2026-10-25

### 修复
- **按钮图标恢复为原本的 ✨**：1.2.0 把图标换成了内联 SVG，在宿主的输入行样式下会渲染成一个空白方框，看不出是什么。现在改回纯文本 `✨`（走系统 emoji 字体），并在旁边常显状态字（空闲「优化」/「优化中」/「查看优化」/「重试」），不会再出现无字按钮。
- 新增一条回归测试，断言按钮里必须同时含 `✨` 与「优化」文案，防止图标再次被换掉。

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

[1.2.1]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.2.1
[1.2.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.2.0
[1.1.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.1.0
[1.0.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.0.0

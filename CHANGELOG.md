# Changelog

本文件记录本插件所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.7.2] - 2026-10-30

### 修复
- **客户端错误路径抛 `ReferenceError: t is not defined`**：结果卡片 `start()` 的 `catch` 里调用了 `explainError(t, message)`，但 `t` 是 `apply()` 的局部常量，`createStore()` 内部的 `api` 作用域里并没有它。结果**任何一次改写失败**（上游报错、空答案、超时）都会在写错误状态之前抛 `ReferenceError`：面板永远停在「优化中…」，用户看不到任何错误提示，控制台只剩一条 `t is not defined`。改为 `explainError(api.locale, message)`（`apply()` 会把真正的翻译函数覆盖到 `store.locale` 上，`api === store`），错误状态现在会正常落盘并显示中文原因。回归测试：上游 502 必须把状态置为 `error` 且提示「模型没有返回正文」。
- **流式错误丢失状态码**：`sseResponse` 的 `catch` 分支只推 `{ type: 'error', message }`，把 `emptyAnswerError` 挂的 `status: 502` 丢掉了；客户端只能显示一句中文错误，无法区分「上游失败/空答案」与其它失败。现在 SSE error 帧与 JSON 路径一样携带 `status`，客户端用 `RequestError` 抛出。回归测试：流式空答案必须带 `status: 502`；客户端收到带 `status` 的 SSE error 帧后状态置为 `error`。
- **`AbortSignal` 兜底**：`requestSignal` 原来无条件调用 `AbortSignal.timeout(TIMEOUT_MS)`，运行时缺这个方法时会在路由应答之前抛 `TypeError`（`AbortSignal.any` 有 try 兜底，`timeout` 没有）。现在 `timeout` 与 `any` 都是可选的：`any` 缺失时退化为手动 `addEventListener` 链；两者都缺失时返回一个 `AbortController` 的 signal，保证路由总能正常应答。回归测试：去掉 `AbortSignal.timeout` / `AbortSignal.any` 后路由仍能正常应答。
- **`config.temperature` 死代码**：`lib/handler.js` 的 `resolveSelection` 会读 `bundleConfig.temperature`（优先级：请求体 → bundle config → 设置文件），但 `index.js:readConfig` 只透传 `{ provider, model }`，中间这一档从来没生效过。现在 `config.temperature` 是有限数字时一并透传。

### 变更
- `index.js` 的 `readConfig` 注释补上 `temperature` 字段示例。

## [1.7.1] - 2026-10-30

### 修复
- **伪造约束（invented constraint）**：之前模型可以把自己没根据的要求写成「引号里的用户原话」，例如草稿只说「补单测」，改写稿却出现「测试要全绿」「不改被测代码」—— 这等于把作者没说过的话冒充成用户要求，评测按不虚构（no_invention）判负。
  - `verifyAdded` 的高风险判定从 path/url/date 扩展到 **quote**：引文即对「这是用户原话」的主张，草稿里没有的引文必然是伪造归属（草稿里已有的引文会命中 source.includes，不会误报）。
  - `SYSTEM_PROMPT` 规则 1 追加「never quote words the user did not write: your own assumption stays an assumption, never an attributed requirement.」，从提示词侧减少这种写法。
  - 修复是自动闭环的：伪造引文一旦出现就标记为高风险，`lib/handler.js` 三条链路（JSON / SSE / 分块）已有的修复逻辑会立即触发一次「只删除、不新增」的修复轮；`ledgerScore` 对高风险扣分（kept*2 - high*3 - low），删掉伪造引文必然使分数上升，所以修复一定被接受。
  - 新增两个回归测试：伪造引文判高风险、引用草稿真实约束仍判干净。

## [1.7.0] - 2026-10-30

### 新增
- **工作区接地（context grounding）**：点 ✨ 时客户端把 `sessionId` 与会话标题投影随请求上传；Host 通过 `agents` / `workingDirectory` 服务解析出当前会话的工作目录，作为「只读上下文」块前置到草稿（`buildMessages(text, context)`），改写模型第一次知道任务发生在哪个目录、哪条会话里。所有查找都是尽力而为：服务缺失、会话已关、id 未知都退化为「无上下文」，行为与 1.6.0 完全一致，绝不因此报错。
- 结果卡片在接地生效时显示「已接工作区：<cwd>」；响应（JSON 与 SSE done 帧）新增 `grounding: { cwd, title } | null`。
- `index.js` 取 `agents` / `workingDirectory` 用 try 包裹的 `scope.get`，不改动 `ctx.inject` 的服务名列表 —— 往 inject 里加名字会把路由注册卡死（历史教训）。

### 安全说明
- 上传的只有会话 id、标题（截断 160 字符、去换行）与解析出的工作目录路径，**不含任何对话内容、文件内容或密钥**。不想启用可在网络层屏蔽请求体中的 `sessionId`/`title` 字段（缺字段即回到无接地行为）。

## [1.6.0] - 2026-10-30

目标：不再只是「把草稿改写得更专业」，而是让改写真正提高任务被做成的概率，并且可以被度量。

### 新增
- **模型自适应**：新文件 `lib/model-profile.js` 按模型 id 判断推理型 / 指令型。推理型不再被要求「先规划」（预算已花在推理里），改为要求「正文不复述推理」，输出预算给到 `REASONING_MODEL_BUDGET = 8000`；指令型保留 plan-first 并要求一个极短示例。`buildSystemPrompt(preset, { model, provider })` 在其后追加这段画像；不传模型时提示词与 1.5.4 完全一致。
- **静态契约检查**：新文件 `lib/contract.js` 的 `checkContract(text)` 检查占位符、正文前寒暄、可判定的验收、验证方式、停止条件、超长与泄密，返回 `{ ok, score, issues }`。优化响应（JSON 与 SSE done 帧）新增 `contract`，客户端在结果卡片底部显示「契约检查：n 项待补」并可用 title 查看逐条原因。
- **评测回路 `bench/`**：`bench/drafts.jsonl` 20 条真实草稿 + `bench/run.mjs`。Level 1 离线契约检查（`npm run bench -- --check`，可进 CI）；Level 2 原稿 vs 优化稿双盲判分，四维（satisfies / fidelity / executable / format）0–5，左右顺序按条目奇偶翻转，输出胜率与逐条明细。`bench/README.md` 写明用法与判读规则（胜率 ≤ 50% 视为改动无效）。
- **响应携带模型画像**：优化响应新增 `profile: { family, reasoning, tokenBudget }`；`/models` 增加 `profile` 与 `maxOutputTokensLimit`。

### 变更
- **输出预算提高**：`MAX_OUTPUT_TOKENS` 3000 → **6000**；`MAX_OUTPUT_TOKENS_LIMIT` 4000 → **12000**；空响应重试上限 `RETRY_TOKEN_CAP` 8000 → **24000**；设置页档位改为 3000 / 6000 / 8000 / 12000（旧文件里的 1600 仍可用，只是偏小）。
- 设置面板「最大长度」默认值随 `normalizeSettings` 变为 6000。
- `SYSTEM_PROMPT` 增加第 7 条：可执行任务必须写清验证方式（命令、测试或产物），并说明失败时报告什么。

## [1.5.4] - 2026-10-29

### 修复
- **预设名称显示英文**：设置面板的预设下拉（General / Writing / Coding / Analysis / Agent task）改为从语言包取中文，语言包没生效时也回退到「通用 / 写作 / 编程 / 分析 / 智能体任务」，不再直接显示 Host 传来的英文 label。
- **「优化失败：The model returned no text」**：思考型模型（如 sn-deepseek-v4-1-flash）可能把输出预算全花在推理上、正文一个字都没有。现在首次没有正文会静默用双倍预算（上限 8000）重试一次；重试仍为空才报错，并在检测到只输出过推理时把原因写进错误信息，客户端再翻成中文提示「把最大长度调大后重试」。
- **默认输出上限 1600 → 3000**：1600 对思考型模型偏小，容易恰好耗尽在推理上。
- **VERSION 版本号**：index.js 的 `VERSION` 仍是 1.5.2、与 package.json 的 1.5.3 不一致，导致 `package.test.js` 失败；一并修到 1.5.4。

## [1.5.3] - 2026-10-29

### 新增
- **可执行调用包**：系统提示词从「润色成结构化提示词」改为七段交付——目标 / 已知与未知 / 约束 / 交付物与验收 / 方法要求 / 验证要求 / 边界与停止条件。未知项写成显式的「假设条款」而不是 `[待补充]` 占位符，验收条件必须能被判定。
- **锚点账本**：结果卡片底部多一行凭证，报告草稿里的路径、命令、数字、日期、否定约束保留了几条（如 `锚点 12/12 保留`）；漏了会自动再补一轮，补不回来就如实写「缺 n 处」，并把缺的原文列在提示里。
- **反向账本**：检测改写里凭空多出来的事实（路径、URL、日期算高风险，数字与否定算低风险），高风险触发一次修复并要求删除或改成假设；只有 `ledgerScore` 确实改善才采纳修复版，避免「删了编造但丢了约束」被判为更好。
- **长稿切段**：超过 24000 字符的草稿按空行切成多段、逐段改写、再按原顺序拼回（硬切不会劈开 emoji 代理对），不再直接 413；卡片凭证追加「分 n 段」。

### 变更
- `MAX_INPUT_CHARS` 的语义从「超过就拒绝」改为「单次调用预算」；新增 `MAX_DRAFT_CHARS = 120000` 作为硬上限，超过才提示用户分批。
- 长稿强制单候选，否则 3 段 × 3 候选 = 9 次调用。
- 凭证行在没有锚点的草稿上也显示，否则「只做了编造清理」的改写看起来什么都没发生。

### 测试
- 新增 `test/anchors.test.js`、`test/ledger.test.js`、`test/added.test.js`，以及 `tools/local-demo.mjs` 离线演示（丢锚点补一轮 / 一次到位 / 修复更差被拒 / 编造被删四个场景）。共 107 个测试。

## [1.5.2] - 2026-10-25

### 修复
- 设置卡片在没有结果时的右上角 ✕ 点了没反应：关闭按钮现在同时收起设置条，不再留下一个关不掉的空卡片。

## [1.5.1] - 2026-10-25

### 修复
- **第一次优化之前打不开设置页**：设置页原本只挂在结果卡片里，而卡片在没有结果时渲染 `null`，于是全新装好的人根本点不到 ⚙。现在输入框工具行的 ✨ 旁边多了一个小 ⚙，点它就能在还没有任何改写结果时展开设置卡片（卡片标题显示「设置」），第一次改写之前也能先调好预设和温度。
- 设置卡片在无结果状态下只渲染设置条，不出现空白对比列与没用的底部按钮。

## [1.5.0] - 2026-10-25

### 新增
- **插件自己的设置页**：卡片右上角 ⚙ 展开就地编辑条，可改「预设 / 候选数 / 最大长度 / 温度」后保存，不用碰 `cordis.patch.yml`。改动前必须先重启或重载插件才生效的时代结束了。
- **偏好持久化**：设置写入 `~/.dsh/prompt-optimizer.json`（先写临时文件再 `rename`，不会写坏），跨浏览器、跨应用重启都在；「恢复默认」把文件写回出厂值。
- **场景预设**：通用 / 写作 / 编程 / 分析 / 智能体任务，在基础改写规则上追加该场景的取向（如编程强调验收标准与错误处理），系统提示词由 Host 按预设拼装。
- **多候选择优**：候选数 2–3 时并行生成多版，Host 按「标题层级 + 列表项 + `键: 值` 行 + 长度」打分（含 `TODO` / 占位符 / “这是为你写的”这类口水话扣分），返回分数最高的一版；`spreadTemperature` 让各候选温度略有差异，避免几版雷同。
- Host 新增 `GET/POST /api/prompt.optimize/settings`：GET 返回当前设置 + 取值范围 + 预设列表，POST 合并补丁（非法值 400 / 落盘失败 503），`{ reset: true }` 恢复默认。

### 变更
- 温度归属改为 Host：设置页成功读到配置后，客户端不再在请求里发温度，避免 `localStorage` 与磁盘文件互相覆盖。
- 设置页读不到配置时显示「设置读取失败」+「重试」，不静默吞错。
- 卡片在没有结果时本来渲染 `null`；现在只要设置页打开着就保持挂载，第一次优化之前也能改设置。
- 新增 23 个测试（`test/settings.test.js`、handler 的设置路由与候选择优、client 的设置面板读写），共 80 个。

## [1.4.0] - 2026-10-25

### 新增
- **改写用哪个模型，跟着对话框走**：点 ✨ 时读取输入框上方模型选择器当前选中的模型（`modelSelection` 投影），随请求一起发给 Host，改写与对话使用同一个模型，不再回落到 profile 默认值。
- **零配置即可用**：Host 按「请求 → 插件配置 → profile 默认 → LLM 服务公布的第一个模型」顺序解析，全新机器上没有任何默认模型也能直接改写，不再出现 `No default model is selected`。
- **可选 bundle 配置**：patch 行里写 `config: { provider, model, temperature }` 即可钉死模型与温度；只填一半的配置会被忽略而不是猜。
- 结果里新增 `source` 字段（`request` / `config` / `profile` / `catalogue`），Host 日志也会记录本次模型来自哪一级，便于排查“为什么用了这个模型”。
- 面板模型下拉的自动项改为「跟随对话（provider / model）」，一眼能看出当前跟的是哪个模型。

### 变更
- 系统提示词对语言不做任何假设：保留输入的语言与术语，中英文提示词都按原文语言产出。
## [1.3.2] - 2026-10-25

### 变更
- **默认不弹结果面板**：直接写入模式下，改写完成只把文本落进输入框，卡片保持收起；想核对差异或改主意时，点输入框右侧的 ✨（此时显示「查看优化」）再展开。审阅模式（关掉直接写入）仍会在完成时打开卡片，因为要你选「采纳 / 放弃」。
- 按钮语义更明确：输入框里的文字**就是**上次结果时，按钮是「查看优化 / 收起」；一旦你改动了输入框，按钮自动回到「优化」，可以直接对改过的文字再优化一轮。

## [1.3.1] - 2026-10-25

### 修复
- **点击优化一律 HTTP 404**：Host 半的 `apply` 直接 `ctx.get('connection')` 探测服务，可能早于 connection 服务就绪，路由被静默跳过——客户端照常渲染，Host 路由却不存在，于是每个请求都 404。改为 `ctx.inject(['connection'], …)` 声明依赖，路由必然注册。
- 客户端在 404 时会按 `location.origin` 再请求一次（兼容被路径前缀包裹的 shell），并把实际请求的 URL 写进错误信息，便于下次一眼定位。
- Host 半新增面包屑日志 `%TEMP%\dsh-prompt-optimizer.log`（路由注册 / 请求路径 / 错误），不再依赖插件作者看不到的 stdout。

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

[1.5.2]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.5.2
[1.5.1]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.5.1
[1.5.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.5.0
[1.4.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.4.0
[1.3.2]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.3.2
[1.3.1]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.3.1
[1.3.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.3.0
[1.2.1]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.2.1
[1.2.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.2.0
[1.1.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.1.0
[1.0.0]: https://github.com/x-cj1989/dsh-prompt-optimizer/releases/tag/v1.0.0
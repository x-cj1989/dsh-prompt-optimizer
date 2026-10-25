# dsh-prompt-optimizer

[![CI](https://github.com/x-cj1989/dsh-prompt-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/x-cj1989/dsh-prompt-optimizer/actions/workflows/ci.yml)
[![](https://img.shields.io/badge/license-MIT-4c1?style=flat-square)](LICENSE)
[![](https://img.shields.io/badge/version-1.5.2-4D6BFE?style=flat-square)](https://github.com/x-cj1989/dsh-prompt-optimizer/releases)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 输入框加一个 **✨「优化提示词」** 按钮：把随手写的一句话改写成结构化的专业提示词，**先看对比、再决定要不要写回**，写回是一步可撤销的编辑。

```
你写： 帮我写个安全生产报告，下周一下午班前会用，重点讲高空作业和动火作业
                    ↓ 点 ✨
改写： ## 角色与目标 / ## 任务 / ## 背景与约束 / ## 输出格式 / ## 质量要求 …
                    ↓ 左右对比 + 字数变化 → 采纳 / 放弃 / 重新优化
```

> 想加截图：把图片放到 `docs/button.png`，再把下面这行取消注释。
>
> <!-- ![composer](docs/button.png) -->

## 功能

- **直接写回输入框（默认开）**：改写完成就落进输入框，不用再复制粘贴、也不用再点一次「采纳」，**结果面板保持收起、不打断你**；想看差异或改主意时点一下按钮（此时显示「查看优化」）再展开。`Ctrl+Z` 一步撤回。想先看再决定，点卡片里的「直接写入：开」切到审阅模式；审阅模式下 `Shift + 点击` 按钮可临时直接写入一次。
- **先预览后写回**：审阅模式下的行为——改写结果不直接覆盖你的草稿，而是在输入框下方展开对比卡片（左原文 / 右优化后，逐行高亮差异、统计字数增减），点「采纳并写入」才落到输入框；「放弃」什么都不做。
- **按钮自己会变**：输入框内容就是上次的改写结果时，按钮是「查看优化 / 收起」；你一动输入框，按钮回到「优化」，可以直接对改过的文字再优化一轮。
- **流式输出**：`text/event-stream` 逐字上屏，长提示词不用干等；网关不支持流式时自动回落到一次性 JSON。
- **可撤销**：写回是一条 `captureInsertion + insertText` 编辑，`Ctrl+Z` 一步撤回；原文另存 `sessionStorage`（按会话，最多 10 条），刷新页面后「撤销」仍可用。
- **模型可选**：面板里下拉选择 provider/model（列表来自 `llm.listModels`），默认跟随 profile 的 `agentDefaultModel`；选择记在 `localStorage`。
- **温度可选**：`0 ~ 1`，默认 `0.2`（改写是收敛任务，低温度让同一稿两次结果基本一致）。
- **设置页（1.5.0+）**：卡片右上角 ⚙，预设 / 候选数 / 最大长度 / 温度都在里面改，存 `~/.dsh/prompt-optimizer.json`，跨浏览器跨重启都在，不用改任何配置文件。
- **多候选择优（1.5.0+）**：候选数 2–3 时并行生成多版，Host 端按「标题 + 列表 + `键: 值` + 长度」打分，自动挑结构最完整的一版，含占位符或口水话的会被扣分。
- **历史 8 条**：改写过的原文可一键载入重跑，`localStorage` 里最多留 20 条，可清空。
- **零依赖 + 81 个测试**：Host 规则、HTTP 路由、SSE 分帧、槽位注册、直接写入/采纳/撤销全部有单元测试，`npm test` 即可跑。
- **中英双语 UI**：字典注册到 Client `locale` 服务，切语言即时生效，查不到时回落内置中文。

## 安装

需要已经能跑的 DSH（Web GUI），版本 **≥ 0.2.0**。插件是**零依赖**的，不需要 `pnpm install`。

**方式一：用 `plugin_manager` 装本地目录（推荐）**

```
plugin_manager  action=install_bundle  target=<本仓库的绝对路径>
```

已经装过的情况下要先 `remove_bundle`（同一个 target），再 `install_bundle`。

**方式二：手工 link 进 profile**

```bash
pnpm --dir ~/.dsh/profiles/<profile> add link:<本仓库的绝对路径>
```

然后在该 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: dsh-prompt-optimizer
      name: '@local/dsh-prompt-optimizer'
```

装完 **Ctrl+R 刷新页面**。替换已安装的包后必须刷新页面：客户端那半边是模块代际，旧代际不会自己换掉。

## 使用

1. 在输入框写点什么（空草稿时按钮是禁用的，避免空跑一次模型）。
2. 点 ✨ → 按钮变「优化中」（再点一次可取消），下方卡片开始流式出现改写结果。
3. **默认直接写入**：改写一结束，输入框里的草稿就被替换成专业提示词，直接回车发送即可；写错了 `Ctrl+Z` 撤回，卡片里也有「撤销这次采纳」。
4. 卡片照常显示对比（红色删掉的行 / 蓝色改写后的行 / `字数 32 → 210（+178）`），想改成审阅模式就点「直接写入：开」；审阅模式下先看对比，再点「采纳并写入」。
5. 卡片底部的模型下拉只决定这一次用哪个模型；温度、预设这些固定偏好点卡片右上角的 **⚙ 设置**（下一节）。

## 设置页（1.5.0+）

输入框工具行里 ✨ 旁边的小 **⚙**（以及结果卡片右上角的 ⚙）打开设置页：展开一个就地编辑条，改完点「保存」即可，不需要动 `cordis.patch.yml`，也不需要重启：

| 选项 | 可选值 | 默认 | 说明 |
|---|---|---|---|
| 预设 | 通用 / 写作 / 编程 / 分析 / 智能体任务 | 通用 | 在基础改写规则上追加一段该场景的取向说明（例如编程场景强调「验收标准与错误处理」） |
| 候选数 | 1 / 2 / 3 | 1 | 并行生成多版，Host 按结构完整度打分挑最好的一版，其余丢弃 |
| 最大长度 | 800 / 1600 / 2400 / 3200 | 1600 | 单次输出的 token 上限 |
| 温度 | 0.2 稳定 / 0.5 / 0.7 灵活 / 1.0 | 0.2 | 改写是收敛任务，低温度让同一稿两次结果基本一致 |

- 设置存在 `~/.dsh/prompt-optimizer.json`（原子写入：先写临时文件再改名），**换浏览器、重启应用都还在**；「恢复默认」会把文件写回出厂值。
- 读不到设置时面板显示「设置读取失败」+「重试」，不会静默吞掉错误。
- 设置页一旦成功读到配置，温度就交给 Host 决定（客户端不再自己发温度），避免 `localStorage` 与磁盘文件互相打架。

## 隐私

- 草稿只会发给**你自己 profile 里配置的那个模型提供商**（默认模型，或你在下拉里选的那个），不经过任何第三方服务、不上传作者服务器。
- 改写结果只存在浏览器里（`localStorage` 历史 8 条、`sessionStorage` 撤销快照）；**不落盘、不写日志、不发消息**。
- 插件不读 `~/.dsh` 下的任何配置、不写 profile 配置、不申请新的权限；除了那一次模型调用没有副作用。
- 历史里有敏感内容时点卡片里的「清空」，或清掉浏览器站点数据。

## 兼容性

| 项 | 要求 |
|---|---|
| DSH | `>= 0.2.0`（客户端启动时读 `window.__DSH_BOOT__.version` 比对，低于此版本卡片顶部提示但不报错） |
| 平台 | 只要 Web 界面（Desktop / `dsh web` 都行） |
| 宿主 | Host 半用 `node:crypto`，无需第三方包；profile 里 `link:` 进来的组合包**无法** `import` DSH 自身的 `@deepseek-ai/*` 包，这是硬约束 |
| 已测 | DSH `0.2.1-rc.3` / Node 24 / Windows；CI 覆盖 Node 20、22、24 |

## 工作原理

两个半边，都在同一个组合包里：

```
index.js          Host 半 ─ 把 lib/handler.js 的三条路由挂到已认证 Web 桥
                  ├ POST /api/prompt.optimize          改写（JSON 或 SSE）
                  ├ GET  /api/prompt.optimize/models   模型目录 + profile 默认
                  └ GET/POST /api/prompt.optimize/settings 读取 / 保存偏好
lib/rewrite.js    纯规则：校验、字数预算、去围栏、温度夹取、预设、候选打分、SYSTEM_PROMPT
lib/settings.js   ~/.dsh/prompt-optimizer.json 的原子读写与校验
lib/handler.js    Request → Response：405/400/413/502/503、SSE 帧、超时合并
client.js         Client 半 ─ 两个槽位
                  ├ conversation.input.right   ✨ 按钮（order 20）
                  └ conversation.composer.dock 对比卡片（order 5，idle 时渲染 null）
```

- 路由走页面**同源 fetch**，用浏览器自己的签名 cookie 过鉴权，插件里不放任何 token，也就不存在把密钥写进前端的问题。
- 写回优先 `captureInsertion()` + `insertText(text, span)`（一步可撤销）；编辑器拒绝 span（例如草稿已变）时回落 `setDraft`，并在卡片里说明。
- 卡片在插槽里用 `flex:1 1 100%` 独占一行，不挤压其他 dock 入口；没有结果时渲染 `null`，完全不占版面。

## 可调参数

| 位置 | 常量 | 默认 | 说明 |
|---|---|---|---|
| `lib/rewrite.js` | `MAX_INPUT_CHARS` | `24000` | 超过直接 413，避免把长文灌进上下文 |
| `lib/rewrite.js` | `MAX_OUTPUT_TOKENS` | `1600` | 一次改写的输出上限 |
| `lib/rewrite.js` | `DEFAULT_TEMPERATURE` | `0.2` | 改写是收敛任务 |
| `lib/rewrite.js` | `TIMEOUT_MS` | `120000` | 单次调用超时（与页面取消信号合并） |
| `lib/rewrite.js` | `SYSTEM_PROMPT` | 见文件 | 改写规则本身，想改风格就改这里 |
| `lib/handler.js` | `ROUTE` / `MODELS_ROUTE` / `SETTINGS_ROUTE` | `/api/prompt.optimize`… | Host 侧路由路径 |
| `lib/settings.js` | `SETTINGS_FILE_NAME` | `prompt-optimizer.json` | 偏好文件名，落在 `~/.dsh/` 下（设置页改的就是它） |
| `client.js` | `BUTTON_SLOT` / `PREVIEW_SLOT` | 见上 | 想挪位置就换槽位 |
| `client.js` | `ROUTE` | `api/prompt.optimize` | 相对路径，反代子路径下也成立 |
| `client.js` | `REQUIRED_DSH` | `0.2.0` | 兼容性下限 |
| `cordis.patch.yml` | `config.provider` / `config.model` | 空 | 钉死改写模型；留空则跟随对话 |
| `cordis.patch.yml` | `config.temperature` | 空（用 `0.2`） | 钉死温度，仍会被设置页覆盖 |

### 模型是怎么选的（1.4.0+）

改写用的模型按下面的顺序解析，前面命中就停：

| 顺序 | 来源 | 什么时候用它 |
|---|---|---|
| 1 | 请求里的 `provider` / `model` | 默认就是**对话框里当前选中的模型**（读 `modelSelection` 投影），或你在结果卡片下拉里手动钉的模型 |
| 2 | 插件配置 | patch 行里写了 `config: { provider, model }` |
| 3 | profile 默认 | `agentDefaultModel.currentSelection()` |
| 4 | LLM 服务公布的第一个模型 | 上面都没有时兜底，**全新机器零配置也能用** |

Host 日志（`%TEMP%\dsh-prompt-optimizer.log`）会记下每次实际用的 `provider / model` 和来源级别（`request` / `config` / `profile` / `catalogue`）。只有连一个模型都列不出来时才返回 503。

想钉死模型又不改代码，在 `cordis.patch.yml` 的插件行里加 `config` 即可：

```yaml
- insert:
    - id: prompt-optimizer
      name: '@local/dsh-prompt-optimizer'
      config:
        provider: deepseek-account
        model: deepseek-chat
        temperature: 0.3
```

改写规则（不是简单润色）：

1. 保留原意、语言和所有具体信息（人名、数字、日期、路径、约束、示例），不丢要求，不编造；
2. 只补真正有用的结构：角色/目标 → 任务 → 上下文与约束 → 输出格式 → 成功标准 → 边界条件；
3. 直接可用，不带「这是你的提示词」之类的元话语，不放 `[这里填X]` 占位符；
4. 已经足够完整的草稿只做收紧，不硬套小节；
5. 与用户同语言输出，只返回 Markdown。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 卡片顶部提示「DSH 版本偏旧」 | `window.__DSH_BOOT__.version` 低于 `0.2.0`；升级 Harness |
| 红色提示 `401` / `dsh web authentication required` | 页面会话没被接受。用 `dsh web` 打印的带 `?token=` 的地址重新进入 |
| `No default model is selected in this profile` | profile 里没选默认模型，先选一个（或在卡片里手动选） |
| 按钮根本不出现 | 刷新页面；仍不出现就查 `cordis.patch.yml` 里有没有这一条、包名是否 `@local/dsh-prompt-optimizer` |
| 点了没反应，按钮变「重试」 | 悬停看完整原因；DevTools Console 里搜 `[prompt-optimizer]` |
| 提示 `HTTP 404` | Host 半的路由没注册上。1.3.1 起会写面包屑日志：`%TEMP%\dsh-prompt-optimizer.log`，里面有 `registered route …` 就说明路由在；重新安装插件后需要重开一次 DSH（Host 半只随进程启动加载） |
| 装完之后输入框的语音/其他小控件消失 | 客户端插件代际变旧，Ctrl+R 刷新页面即可恢复 |
| 流式半天没字 | 网关不支持 SSE 时会自动回落一次性返回；若仍卡住，看 Network 里的 `prompt.optimize` 请求 |
| 想确认鉴权通不通（不点按钮） | 控制台：`await (await fetch('api/prompt.optimize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'帮我写个周报'})})).text()` |

## 开发与测试

```bash
npm test        # node --test，81 个用例，无需安装依赖
npm run check   # 五个入口文件的 node --check 语法检查
npm run verify  # check + test
```

- 测试用 Node 内置 runner，零依赖：`test/rewrite.test.js`（规则/预设/候选打分）、`test/handler.test.js`（路由/SSE/错误码/设置读写）、`test/settings.test.js`（设置文件的合并、校验、原子写入）、`test/client.test.js`（伪浏览器里加载 `client.js`，验证槽位注册、diff、SSE 分帧、采纳与撤销、设置面板读写）、`test/package.test.js`（清单/文件列表/双语字典/README 结构一致性）。
- 改完代码用 `plugin_manager` 重装一次（先 `remove_bundle`），再 Ctrl+R 刷新页面看效果。

## 目录结构

```
.
├── package.json         组合包清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml     Loader 补丁：把本插件插进 profile
├── index.js             Host 半入口（挂路由）
├── lib/rewrite.js       纯改写规则与校验
├── lib/settings.js      偏好文件的原子读写
├── lib/handler.js       三条路由的 Request → Response 实现
├── client.js            Client 半（按钮 + 对比卡片）
├── locale/{en,zh}.json  插件在「插件」页里的标题与描述
├── icon.svg             插件图标
├── test/*.test.js       单元测试
├── CHANGELOG.md         版本记录
└── LICENSE              MIT
```

`locale/` 里的两份 JSON 是**插件元数据**；按钮与卡片的文案字典注册在 `client.js` 里，两者作用不同。

## 致谢

骨架来自 DSH 自带 `cordis-plugin-development` 技能的 `templates/decoration`，路由写法参考了 `dsh-session-log-export`，模型调用参考了 `dsh-session-title-llm`。

## License

[MIT](LICENSE) © 2026 x-cj1989

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

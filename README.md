# dsh-prompt-optimizer

[![CI](https://github.com/x-cj1989/dsh-prompt-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/x-cj1989/dsh-prompt-optimizer/actions/workflows/ci.yml)
[![](https://img.shields.io/badge/license-MIT-4c1?style=flat-square)](LICENSE)
[![](https://img.shields.io/badge/version-1.2.0-4D6BFE?style=flat-square)](https://github.com/x-cj1989/dsh-prompt-optimizer/releases)

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

- **先预览后写回**：改写结果不直接覆盖你的草稿，而是在输入框下方展开对比卡片（左原文 / 右优化后，逐行高亮差异、统计字数增减），点「采纳并写入」才落到输入框；「放弃」什么都不做。
- **流式输出**：`text/event-stream` 逐字上屏，长提示词不用干等；网关不支持流式时自动回落到一次性 JSON。
- **可撤销**：写回是一条 `captureInsertion + insertText` 编辑，`Ctrl+Z` 一步撤回；原文另存 `sessionStorage`（按会话，最多 10 条），刷新页面后「撤销」仍可用。
- **模型可选**：面板里下拉选择 provider/model（列表来自 `llm.listModels`），默认跟随 profile 的 `agentDefaultModel`；选择记在 `localStorage`。
- **温度可选**：`0 ~ 1`，默认 `0.2`（改写是收敛任务，低温度让同一稿两次结果基本一致）。
- **历史 8 条**：改写过的原文可一键载入重跑，`localStorage` 里最多留 20 条，可清空。
- **零依赖 + 52 个测试**：Host 规则、HTTP 路由、SSE 分帧、槽位注册、采纳/撤销全部有单元测试，`npm test` 即可跑。
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
3. 看对比：红色是删掉的原文行，蓝色是改写后的行，标题旁有 `字数 32 → 210（+178）`。
4. **采纳并写入** / **放弃** / **重新优化**；写错了在输入框里 `Ctrl+Z` 撤回。
5. 想换模型或温度，直接在卡片底部改，下次沿用。

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
index.js          Host 半 ─ 把 lib/handler.js 的两条路由挂到已认证 Web 桥
                  ├ POST /api/prompt.optimize       改写（JSON 或 SSE）
                  └ GET  /api/prompt.optimize/models 模型目录 + profile 默认
lib/rewrite.js    纯规则：校验、字数预算、去围栏、温度夹取、SYSTEM_PROMPT
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
| `lib/handler.js` | `ROUTE` / `MODELS_ROUTE` | `/api/prompt.optimize`… | Host 侧路由路径 |
| `client.js` | `BUTTON_SLOT` / `PREVIEW_SLOT` | 见上 | 想挪位置就换槽位 |
| `client.js` | `ROUTE` | `api/prompt.optimize` | 相对路径，反代子路径下也成立 |
| `client.js` | `REQUIRED_DSH` | `0.2.0` | 兼容性下限 |

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
| 装完之后输入框的语音/其他小控件消失 | 客户端插件代际变旧，Ctrl+R 刷新页面即可恢复 |
| 流式半天没字 | 网关不支持 SSE 时会自动回落一次性返回；若仍卡住，看 Network 里的 `prompt.optimize` 请求 |
| 想确认鉴权通不通（不点按钮） | 控制台：`await (await fetch('api/prompt.optimize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'帮我写个周报'})})).text()` |

## 开发与测试

```bash
npm test        # node --test，52 个用例，无需安装依赖
npm run check   # 四个入口文件的 node --check 语法检查
npm run verify  # check + test
```

- 测试用 Node 内置 runner，零依赖：`test/rewrite.test.js`（规则）、`test/handler.test.js`（路由/SSE/错误码）、`test/client.test.js`（伪浏览器里加载 `client.js`，验证槽位注册、diff、SSE 分帧、采纳与撤销）、`test/package.test.js`（清单/文件列表/双语字典/README 结构一致性）。
- 改完代码用 `plugin_manager` 重装一次（先 `remove_bundle`），再 Ctrl+R 刷新页面看效果。

## 目录结构

```
.
├── package.json         组合包清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml     Loader 补丁：把本插件插进 profile
├── index.js             Host 半入口（挂路由）
├── lib/rewrite.js       纯改写规则与校验
├── lib/handler.js       两条路由的 Request → Response 实现
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

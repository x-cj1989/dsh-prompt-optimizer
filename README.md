# dsh-prompt-optimizer

[![](https://img.shields.io/badge/license-MIT-4c1?style=flat-square)](LICENSE)
[![](https://img.shields.io/badge/version-1.1.0-4D6BFE?style=flat-square)](https://github.com/x-cj1989/dsh-prompt-optimizer/tags)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 界面加一个 **「优化提示词」** 按钮：把输入框里随手写的一句话，用你当前 profile 的默认模型改写成一份结构化的专业提示词，直接写回输入框，改完可以一键撤回。

> 想加截图：把图片放到 `docs/button.png`，再把下面这行取消注释。
>
> <!-- ![composer](docs/button.png) -->

## 它做什么

- 位置：输入框工具行右侧、发送键左边（槽位 `conversation.input.right`，`order: 20`）。
- 点击 → 读当前草稿 → POST `/api/prompt.optimize` → 默认模型改写 → 写回输入框。
- 四个状态：`✨ 优化提示词` → `优化中`（图标转圈、禁用）→ `撤销` / `重试`。
- 写回是**一条可 Ctrl+Z 的编辑**；改写前的原文另外暂存在 `sessionStorage`（按会话，最多 10 条），刷新页面、连续改写多次后「撤销」仍然可用。
- 失败时按钮旁出现一行红色原因（完整文本在 tooltip 里），同时 `console.error` 打出原始错误。
- 文案走 Harness 的 Client `locale` 服务，注册了 `en` / `zh` 两套字典，切语言即时生效；查不到时回落内置中文。

改写规则是固定的，不是简单润色：

1. 保留原意、语言和所有具体信息（人名、数字、日期、路径、约束、示例），不丢要求，不编造；
2. 只补真正有用的结构：角色/目标 → 任务 → 上下文与约束 → 输出格式 → 成功标准 → 边界条件；
3. 直接可用，不带「这是你的提示词」之类的元话语，不放 `[这里填X]` 占位符；
4. 已经足够完整的草稿只做收紧，不硬套小节；
5. 与用户同语言输出，只返回 Markdown。

## 工作原理

两个半边，都在同一个组合包里：

```
index.js    Host 半 ── 注册 POST /api/prompt.optimize（已认证 Web 桥）
                    └─ 用 ctx.get('llm').stream() + agentDefaultModel.currentSelection()
client.js   Client 半 ─ 往 conversation.input.right 注册一个按钮
                    └─ useInput 读草稿 / captureInsertion+insertText 写回 / setDraft 兜底
```

- 路由走页面的**同源 fetch**，用浏览器自己的签名 cookie 过鉴权，插件里不放任何 token。
- 不落盘、不发消息、不写 profile 配置；除了那一次模型调用没有副作用。
- 只用 Node 内置 `node:crypto`，没有第三方依赖 —— profile 里 `link:` 进来的组合包**无法** `import` DSH 自身的 `@deepseek-ai/*` 包，这是硬约束。

## 安装

需要已经能跑的 DSH（Web GUI）。

**方式一：用 `plugin_manager` 装本地目录（推荐）**

```
plugin_manager  action=install_bundle  target=<本仓库的绝对路径>
```

已经在装过的情况下要先 `remove_bundle`（同一个 target），再 `install_bundle`。

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

装完刷新页面（Ctrl+R）。改完代码重新装一次即生效；替换已安装的包后，客户端那半边建议刷新一次页面。

## 可调参数

都在 `index.js` / `client.js` 顶部：

| 位置 | 常量 | 默认 | 说明 |
|---|---|---|---|
| `index.js` | `ROUTE_PATH` | `/api/prompt.optimize` | Host 侧路由路径 |
| `index.js` | `MAX_INPUT_CHARS` | `24000` | 超过直接 413，避免把长文灌进上下文 |
| `index.js` | `MAX_OUTPUT_TOKENS` | `1600` | 一次改写的输出上限 |
| `index.js` | `TEMPERATURE` | `0.2` | 改写是收敛任务，低温度让同一稿两次结果一致 |
| `index.js` | `TIMEOUT_MS` | `120000` | 单次调用超时 |
| `index.js` | `SYSTEM_PROMPT` | 见文件 | 改写规则本身，想改风格就改这里 |
| `client.js` | `SLOT` | `conversation.input.right` | 想挪位置就换槽位 |
| `client.js` | `ROUTE` | `api/prompt.optimize` | 相对路径，反代子路径下也成立 |

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| 按钮旁的红色提示是 `401` / `dsh web authentication required` | 页面会话没被接受。刷新页面重开（用 `dsh web` 打印的带 `?token=` 的地址进入），再试 |
| `No default model is selected in this profile` | profile 里没选默认模型，先选一个 |
| 按钮根本不出现 | 刷新页面；仍不出现就查 `cordis.patch.yml` 里有没有这一条、包名是否 `@local/dsh-prompt-optimizer` |
| 点了没反应，按钮变「重试」 | 悬停按钮看完整原因；同时看 DevTools Console 里 `[prompt-optimizer]` 开头的日志 |
| 装完之后输入框的语音/其他小控件消失 | 客户端插件代际变旧，Ctrl+R 刷新页面即可恢复 |
| 想确认鉴权通不通（不点按钮） | 控制台跑：`await (await fetch('api/prompt.optimize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'帮我写个周报'})})).text()` |

## 目录结构

```
.
├── package.json       组合包清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml   Loader 补丁：把本插件插进 profile
├── index.js           Host 半
├── client.js          Client 半
├── locale/{en,zh}.json 插件在「插件」页里的标题与描述
├── icon.svg           插件图标
└── LICENSE            MIT
```
`locale/` 里的两份 JSON 是**插件元数据**；按钮文案的字典注册在 `client.js` 里，两者作用不同。

## 致谢

骨架来自 DSH 自带 `cordis-plugin-development` 技能的 `templates/decoration`，路由写法参考了 `dsh-session-log-export`，模型调用参考了 `dsh-session-title-llm`。

## License

[MIT](LICENSE) © 2026 x-cj1989

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

# 安全策略

本插件运行在你自己机器上的 DeepSeek Harness 里，风险面很小，但仍有几点值得写清楚。

## 报告问题

发现安全问题请**不要**开公开 issue，用 GitHub 的 [私密漏洞报告](https://github.com/x-cj1989/dsh-prompt-optimizer/security/advisories/new) 或直接邮件联系仓库作者。请附上 DSH 版本、复现步骤和你观察到的实际影响。

## 设计上的边界

- **没有内置凭据**：客户端用页面自己的同源 fetch 调 `/api/prompt.optimize`，鉴权由 Harness 的签名 cookie 完成，插件里不存在 token、API key 或任何硬编码密钥。
- **不越权**：只注册两条路由（`POST /api/prompt.optimize`、`GET /api/prompt.optimize/models`）和两个 UI 槽位；不读 `~/.dsh` 配置、不写 profile、不起子进程、不开端口。
- **只发给你选的模型**：草稿文本仅通过 Host 半的 `llm.stream()` 发往你 profile 里配置的提供商，没有其他出站请求。
- **零第三方依赖**：只用 Node 内置模块，没有供应链面。
- **本地留存**：历史与撤销快照只存在浏览器 `localStorage` / `sessionStorage`；卡片里有「清空」。

## 支持范围

只有最新发布版本接受安全修复。旧版本请先升级再报告。

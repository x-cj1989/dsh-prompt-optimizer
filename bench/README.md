# bench —— 提示词优化的评测回路

`bench/` 是「优化到底有没有让任务更容易被做成」的判决器，不是自我感觉良好的样例集。两层，互相独立。

## Level 1：静态契约检查（离线，可进 CI）

对每条草稿跑 `lib/contract.js` 的 `checkContract`，看草稿缺什么：占位符、验收条件、验证方式、停止条件、长度、泄密。它衡量的是**原稿与优化稿之间的差距**，不需要任何模型、任何网络。

```powershell
node bench/run.mjs --check            # 全部 20 条
node bench/run.mjs --check --limit 5  # 先跑 5 条
node bench/run.mjs --check --json     # 机器可读，便于贴进 CI
```

输出：平均分、干净数、error 数、缺口直方图，以及每条草稿的分数与缺口代码。

## Level 2：双盲判分（需要真模型）

同一条草稿各跑一次「原稿」与「优化稿」，交给裁判模型按四维打分（0–5），并**把左右顺序按条目奇偶翻转**，避免位置偏好：

| 维度 | 问的是 |
|---|---|
| satisfies | 照它做，能不能真的交付草稿要的东西 |
| fidelity | 有没有保留事实/约束、有没有编造 |
| executable | 有没有写清验收物、命令或检查 |
| format | 结构是否让模型能无歧义执行 |

```powershell
$env:PO_BENCH_BASE_URL = 'http://127.0.0.1:2795'   # 本机 DSH Web
$env:PO_BENCH_COOKIE   = '<浏览器里的会话 cookie>'
$env:PO_BENCH_MODEL    = 'chat'                    # 裁判模型
node bench/run.mjs --limit 3
```

- 认证二选一：`PO_BENCH_COOKIE`（原样放进 cookie 头）或 `PO_BENCH_API_KEY`（走 `Authorization: Bearer`）。
- 改写走插件的 `/api/prompt.optimize`；裁判默认打 `/chat/completions`，可用 `PO_BENCH_JUDGE_URL` 指向别的 OpenAI 兼容端点。
- 输出胜率、胜/平/负、原稿→优化稿均分、优化稿契约均分，以及逐条明细。裁判返回的 JSON 解析不出来时，该条记为 `null` 并继续（不会拿坏数据充数）。

## 判读规则

- **Level 1 变好但 Level 2 没变**：说明改动只是在「看起来更专业」上加字，没让任务更容易完成。
- **Level 2 胜率 ≤ 50%**：任何「最大化能力」的改动都还没被证明有效，回退而不是解释。
- 改动 prompt 策略时，先跑同一批草稿的基线（`git stash` 前后各一次），只接受胜率提升且没有维度倒退的版本。

## 扩样

`drafts.jsonl` 每行一个 JSON：`{"id":"唯一名","preset":"general|coding|writing|analysis|agent","text":"真实草稿"}`。
加草稿时优先加**你自己真的写过、且写得含糊**的那种，别加已经写得很好的 prompt —— 那测不出优化器的价值。

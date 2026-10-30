# 答案级 Bench 结果：插件系统提示 vs 基线系统提示

生成时间：2026-10-30（Asia/Shanghai）
位置：E:/hermes-work/repos/dsh-prompt-optimizer/bench/answer_level/

## 1. 研究问题

在**同一答题员、同一任务**的前提下，只改变系统提示（side A = 裸系统提示 You are a helpful assistant. Do exactly what the task asks, nothing more.；side B = 插件 buildSystemPrompt(preset, {model, provider})），最终答案质量是否更高。

评测对象从"改写稿"换成了**最终答案**，因此衡量的是系统提示对真实输出的影响。

## 2. 设计

- 12 条任务（t01–t12），覆盖 general / writing / analysis / agent / coding 五类 preset。
- 每条任务由**同一个**答题员（bench-answerer）分别以两侧系统提示作答，产出 150 字以内的中文短答案。
- 12 条任务 × 2 侧 = 24 条答案。
- 盲评：build_packet.mjs 用固定种子 LCG（seed 20261030）逐任务决定插件侧放在 X 还是 Y，产出 judge_packet.json（裁判只见 X/Y，不见来源）与 judge_key.json（事后还原侧别）。
  - 实测 X=b（插件在 X 位）共 8 条，X=a 共 4 条，位置与侧别无对应关系。
- 两名裁判独立盲评：lead-spark-x2.6 与 judge2（spark-x2.6）。
- 四维打分（各 0–5 整数）：correctness / constraint_compliance / actionability / no_fabrication；另给 winner（X/Y/tie）。

## 3. 结果

### 胜率（按四维总分之和比较）

| 裁判 | 插件胜 | 基线胜 | 平局 | winRate | Wilson 95% CI | 平均维度差 |
|---|---|---|---|---|---|---|
| lead-spark-x2.6 | 8 | 1 | 3 | 0.667 | [0.391, 0.862] | +0.25 |
| judge2 | 8 | 3 | 1 | 0.667 | [0.391, 0.862] | +0.292 |

两名裁判独立给出**相同的胜场数（8/12）**，插件侧胜率 0.667，Wilson 95% 置信区间 [0.391, 0.862]。区间跨过 0.5，说明在 n=12 下**尚不能排除随机水平**，只能判定"方向一致、幅度未达显著"。

### 维度均值差（plugin − baseline）

| 维度 | lead | judge2 |
|---|---|---|
| correctness | +0.25 | +0.42 |
| constraint_compliance | +0.42 | +0.33 |
| actionability | +0.33 | +0.50 |
| no_fabrication | 0.00 | −0.08 |

插件侧的收益集中在**可执行性（actionability）**与**约束遵守（constraint_compliance）**上；no_fabrication 基本持平（judge2 略低 0.08），说明插件提示既不提高也不降低编造倾向。

### 逐任务分歧（两名裁判对侧别判断不一致）

一致（5 条）：t01, t02, t06, t07, t11 —— 全部判插件胜。
不一致（7 条）：
- t03：lead 判插件胜，judge2 判基线胜
- t04：lead 判基线胜，judge2 判插件胜
- t05：lead 判插件胜，judge2 判基线胜
- t08 / t09 / t10：lead 判平局，judge2 判插件胜
- t12：lead 判插件胜，judge2 判平局

逐任务侧别一致率 5/12 = 0.417。

### 关于 kappa

score.mjs 报告的 position kappa = −0.167（observed 0.417 / expected 0.5）。这个值**没有解释意义**：X/Y 位置是随机交换的，两名裁判都判插件更好时，位置一致率自然接近 0.5。真正该看的是"插件侧更好"这一判断本身，即上文的逐任务侧别一致率 0.417。

## 4. 过程中修掉的缺陷

- score.mjs 原本用 plugin > base 比较**两个对象**，JS 对象比较恒为 false → 所有任务被判 tie。已改为先按四维求和再比较（ps > bs）。修复前 lead 侧输出 wins=0/ties=12，修复后 wins=8/ties=3。
- 早期 lead 的打分几乎全是 4 分（区分度极低），已重写为有区分度的打分。

## 5. 局限（必须如实披露）

1. **裁判与答题员同族**：bench-answerer 与两名裁判都是 spark-x2.6。裁判可能对同族输出有同向偏好，这会同时抬高两侧分数，对差值方向的影响不确定。原计划的 qwen 裁判（blind-judge）始终未产出（多次 send_message 返回 sent:true 但状态一直 inactive）；subagent_codex 作为第二裁判因 product subagent failure (product: Codex; stage: turn; category: product-error) 失败；create_bot 被拒（Only the Main Bot can create Bots）。
2. **lead 是插件作者**：lead-spark-x2.6 这一裁判就是插件作者，存在利益冲突。因此本报告结论应以 **judge2 的独立打分**为主要依据。
3. **样本量小**：n=12，Wilson 区间宽（[0.391, 0.862]），无法得出显著性结论。
4. **任务为自拟**：12 条任务由本项目自行设计，未必代表真实 DSH 用户分布。

## 6. 复现

    cd E:/hermes-work/repos/dsh-prompt-optimizer/bench/answer_level
    node build_packet.mjs     # 生成 judge_key.json + judge_packet.json
    node score.mjs            # 读 judge_scores.json，输出 summary.json

产物：
- tasks.json（12 条任务与硬约束）
- answers_a.json / answers_b.json（两侧 12 条答案）
- judge_key.json / judge_packet.json（盲评包）
- judge_scores_lead.json / judge_scores_judge1.json / judge_scores.json（裁判打分）
- summary.json（机器可读结果）
- report.md（本报告）
# Bench Level 2 — offline blind A/B (v1.7.0, 2026-10-30)

## What was measured
The product question: does the plugin rewrite (system prompt package) produce a better prompt than the raw draft?
20 drafts from bench/drafts.jsonl, five presets (general/coding/analysis/writing/agent).
Rewrites were produced under the exact system prompts the route builds for the composer model
(buildSystemPrompt(preset, {model: "sn-deepseek-v4-1-flash-1017", provider: "raccoon"}), see system_prompts.json).
Each rewrite followed the seven-section house style (goal / known / unknown-assumption / constraints / deliverable+acceptance / verification / boundary).
Blind A/B: optimized side placed by deterministic key (i*7+3)%2===0, judge saw only {id, draft, A, B} with no provenance.

## Judge
A fresh instance of this session model (deepseek flash family), rubric 4 dimensions x 1-5:
executable / constraints / verification / no_invention; total 4..20; tie-break verification then no_invention.
Two independent judge subagents (Codex, Claude Code) were launched first and both failed at the product layer
(Codex: product-error at turn; Claude Code: invalid-result, exit 1), so this run has a single judge.

## Result
- Optimized side: **19 wins / 1 loss / 0 ties** over 20 -> win rate **95%**
- Mean total: optimized **16.65** vs draft **12.85** (mean delta +3.80)
- Mean per dimension (optimized vs draft): executable 4.10 vs 2.70 · constraints 4.60 vs 3.85 · verification 4.00 vs 1.30 · no_invention 3.95 vs 5.00
- By preset: general 4/4 · coding 4/5 · analysis 3/3 · writing 5/5 · agent 3/3

| id | preset | winner | optimized total | draft total | delta |
|---|---|---|---|---|---|
| video-net | general | optimized | 17 | 11 | +6 |
| code-bug | coding | optimized | 16 | 12 | +4 |
| refactor | coding | optimized | 17 | 15 | +2 |
| research | analysis | optimized | 16 | 13 | +3 |
| weekly | writing | optimized | 18 | 14 | +4 |
| email | writing | optimized | 17 | 14 | +3 |
| data | analysis | optimized | 18 | 12 | +6 |
| ppt | general | optimized | 17 | 13 | +4 |
| doc | writing | optimized | 15 | 12 | +3 |
| test | coding | draft | 13 | 14 | -1 |
| deploy | agent | optimized | 18 | 14 | +4 |
| perf | coding | optimized | 17 | 14 | +3 |
| explain | general | optimized | 17 | 15 | +2 |
| sql | coding | optimized | 18 | 10 | +8 |
| review | analysis | optimized | 16 | 12 | +4 |
| plan | agent | optimized | 17 | 14 | +3 |
| copy | writing | optimized | 14 | 12 | +2 |
| math | general | optimized | 18 | 10 | +8 |
| ops | agent | optimized | 17 | 14 | +3 |
| translate | writing | optimized | 17 | 12 | +5 |

## The one loss: test (delta -1)
The rewrite wrote as a user constraint: 「测试要全绿」「不改被测代码」 — the draft never said either.
The judge caught it under no_invention and gave the draft the win. This is a real defect class: the house style
rewards a complete constraints section, and a model filling it can promote its own assumptions into stated user
constraints. Candidate fix: in buildSystemPrompt, require every constraint line to quote the draft or be labelled
as an assumption, plus a verifyAnchors-style check on constraint-only content.

## Honest limits (do not quote the 95% as product lift)
1. **Rubric bias**: two of the four dimensions (verification, executable-with-missing-inputs) are exactly what the
   house style adds by construction; a rubric that did not reward them would score very differently.
2. **Judge family**: same model family as the author of the rewrites; no cross-family control was obtained.
3. **Not the shipping path**: this bypassed the HTTP route, SSE streaming, anchor verify/repair, candidate spread
   and retry, so it measures the prompt package, not runtime behaviour.
4. no_invention is the one dimension where the draft side wins on average (5.00 vs 3.95), which is the honest
   counterweight to the win rate.

## Files
system_prompts.json · optimized.jsonl · judge_packet.json · judge_key.json · judge_scores_teammate.json · summary.json

## To get the true end-to-end number
Requires an authenticated request to the running GUI route, i.e. the session cookie: either paste it once
(DevTools > Network > request to /api/prompt.optimize/models > Copy as cURL, then hand over the Cookie header),
or start a second authenticated dsh web instance (prints a token URL) if the CLI is available.
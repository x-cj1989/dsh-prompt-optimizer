/**
 * Offline demonstration of two passes: the anchor ledger and the repair pass.
 *
 * It runs the REAL HTTP routes from lib/handler.js against a fake LLM, so it
 * needs no network, no DSH restart and no model key:
 *
 *   node tools/local-demo.mjs
 */
import assert from 'node:assert/strict';

import { ROUTE, createRoutes } from '../lib/handler.js';
import { SYSTEM_PROMPT, extractAnchors, verifyAnchors } from '../lib/rewrite.js';

const DRAFT = '把 E:\\work\\a.py 在 2024年3月 前改好，输出 3 份，不要 emoji';
const DROPPED = '# 任务\n改好代码，并写一份说明';
const REPAIRED = '# 任务\n在 2024年3月 前改好 E:\\work\\a.py，输出 3 份，不要 emoji';

function makeLlm(first, second) {
  const seen = [];
  return {
    seen,
    async *stream(request) {
      seen.push(request);
      for (const text of seen.length === 1 ? first : second) yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

function routesWith(llm) {
  return createRoutes({
    getServices: () => ({ llm, defaultModel: { currentSelection: () => ({ provider: 'demo', model: 'fake' }) } }),
    pluginVersion: '1.6.0-local',
  });
}

function post(body) {
  return new Request('http://127.0.0.1:1234' + ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function line() {
  console.log('-'.repeat(72));
}

line();
console.log('1) 现在发给模型的系统指令（改写规则）');
line();
console.log(SYSTEM_PROMPT);

line();
console.log('2) 草稿里的硬锚点（纯确定性抽取，不调模型）');
line();
console.log('草稿: ' + DRAFT);
for (const anchor of extractAnchors(DRAFT)) console.log('  [' + anchor.kind + '] ' + anchor.value);

line();
console.log('3) 场景 A：第一遍漏掉锚点 -> 自动补一轮');
line();
const llmA = makeLlm([DROPPED], [REPAIRED]);
const a = await (await routesWith(llmA).optimize(post({ text: DRAFT }))).json();
console.log('第一遍（模型偷懒）: ' + DROPPED.replace(/\n/g, ' / '));
console.log('第二遍（修复指令节选）: ' + String(llmA.seen[1].messages[0].content[0].text).split('\n').slice(0, 3).join(' / '));
console.log('最终结果: ' + a.text.replace(/\n/g, ' / '));
console.log('模型调用次数: ' + llmA.seen.length);
console.log('账本: ' + JSON.stringify(a.ledger));
console.log('卡片凭证行: 锚点 ' + a.ledger.kept + '/' + a.ledger.anchors + ' 保留' + (a.ledger.repaired ? ' · 已自动补回' : ''));
assert.equal(llmA.seen.length, 2);
assert.equal(a.ledger.repaired, true);
assert.deepEqual(a.ledger.missing, []);

line();
console.log('4) 场景 B：一次就保住锚点 -> 只有一次调用');
line();
const llmB = makeLlm([REPAIRED], ['unused']);
const b = await (await routesWith(llmB).optimize(post({ text: DRAFT }))).json();
console.log('模型调用次数: ' + llmB.seen.length);
console.log('账本: ' + JSON.stringify(b.ledger));
console.log('卡片凭证行: 锚点 ' + b.ledger.kept + '/' + b.ledger.anchors + ' 保留');
assert.equal(llmB.seen.length, 1);
assert.deepEqual(b.ledger.missing, []);

line();
console.log('5) 场景 C：补一轮反而更差 -> 拒绝，保留第一版');
line();
const llmC = makeLlm([DROPPED], ['# 任务\n随便写点']);
const c = await (await routesWith(llmC).optimize(post({ text: DRAFT }))).json();
console.log('最终结果: ' + c.text.replace(/\n/g, ' / '));
console.log('账本: ' + JSON.stringify(c.ledger));
assert.equal(c.ledger.repaired, false);
assert.ok(c.ledger.missing.length > 0);

line();
line();
console.log('6) 场景 D：模型编了原文没有的文件名和日期 -> 自动要求删掉');
line();
const DRAFT_D = '帮我改一下这个脚本，让它更快';
const INVENTED = '# 目标\n修改 E:\\proj\\main.py，2026年11月前完成，让它更快';
const CLEAN = '# 目标\n修改用户提供的脚本，让它更快。若未给出目标文件，先停下并询问。';
const llmD = makeLlm([INVENTED], [CLEAN]);
const d = await (await routesWith(llmD).optimize(post({ text: DRAFT_D }))).json();
console.log('第一遍（模型自己补了细节）: ' + INVENTED.replace(/\n/g, ' / '));
console.log('第二遍（修复指令节选）: ' + String(llmD.seen[1].messages[0].content[0].text).split('\n').slice(0, 1).join(''));
console.log('最终结果: ' + d.text.replace(/\n/g, ' / '));
console.log('账本: ' + JSON.stringify(d.ledger));
const receiptD = [];
if (d.ledger.anchors > 0) receiptD.push('锚点 ' + d.ledger.kept + '/' + d.ledger.anchors + ' 保留');
else if (d.ledger.repaired) receiptD.push('已删掉编造内容');
if (d.ledger.added.length > 0) receiptD.push('补全 ' + d.ledger.added.length + ' 条未见于原文');
console.log('卡片凭证行: ' + receiptD.join(' · '));
assert.equal(llmD.seen.length, 2);
assert.equal(d.text, CLEAN);
assert.deepEqual(d.ledger.added, []);

line();
console.log('本地验证通过：路由、账本、丢锚点修复、编造检测、拒绝分支都按预期工作。');
console.log('（界面上的凭证行要等 DSH 重启后 Host 半重新加载才看得到。）');

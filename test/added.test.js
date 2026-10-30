import test from 'node:test';
import assert from 'node:assert/strict';

import { ROUTE, createRoutes } from '../lib/handler.js';
import { buildRepairMessages, ledgerScore, verifyAdded } from '../lib/rewrite.js';

const ORIGIN = 'http://127.0.0.1:1234';
const DRAFT = '帮我改一下这个脚本，让它更快';
const INVENTED = '# 目标\n修改 E:\\proj\\main.py，2026年11月前完成，让它更快';
const CLEAN = '# 目标\n修改用户提供的脚本，让它更快。若未给出目标文件，先停下并询问。';

test('verifyAdded flags invented paths and dates but ignores markdown numbering', () => {
  const found = verifyAdded(
    '帮我改脚本',
    '# 1. 目标\n修改 E:\\proj\\main.py，2026年11月前完成\n\n## 2. 步骤\n1. 读文件\n2. 改代码',
  );
  const values = found.high.map((entry) => entry.value);
  assert.ok(values.includes('E:\\proj\\main.py'), values.join(' | '));
  assert.ok(values.includes('2026年11月'), values.join(' | '));
  assert.ok(!values.includes('1') && !values.includes('2'), values.join(' | '));
  assert.deepEqual(found.low, []);
});

test('numbers, quotes and negations are low risk only', () => {
  const found = verifyAdded('写一份总结', '输出 3 段，不要加表情');
  assert.deepEqual(found.high, []);
  assert.ok(found.low.some((entry) => entry.value === '3'));
  assert.ok(found.low.some((entry) => entry.kind === 'negation'));
});

test('material already in the draft is never reported as invented', () => {
  const found = verifyAdded('在 E:\\a\\b.py 里改 3 处', '在 E:\\a\\b.py 里改 3 处，2024-03-15 前完成');
  assert.deepEqual(found.high.map((entry) => entry.value), ['2024-03-15']);
  assert.deepEqual(found.low, []);
});

test('ledgerScore prefers kept anchors and punishes invented facts', () => {
  assert.ok(ledgerScore({ kept: 4, added: [] }) > ledgerScore({ kept: 4, added: [{ risk: 'high' }] }));
  assert.ok(ledgerScore({ kept: 3, added: [] }) > ledgerScore({ kept: 3, added: [{ risk: 'high' }, { risk: 'high' }] }));
  assert.ok(ledgerScore({ kept: 4, added: [{ risk: 'low' }] }) > ledgerScore({ kept: 4, added: [{ risk: 'high' }] }));
});

test('buildRepairMessages can ask only for removal', () => {
  const messages = buildRepairMessages({ draft: '改脚本', previous: '改 E:\\x.py', added: ['E:\\x.py'] });
  const text = messages[0].content[0].text;
  assert.match(text, /Invented material that is not in the original draft/);
  assert.ok(text.includes('E:\\x.py'));
  assert.ok(!text.includes('Missing from your rewrite'));
  assert.match(text, /add nothing the draft does not support/);
});

function makeLlm2(first, second) {
  const seen = [];
  return {
    seen,
    async *stream(request) {
      seen.push(request);
      const deltas = seen.length === 1 ? first : second;
      for (const text of deltas) yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

function routesWith(llm) {
  return createRoutes({
    getServices: () => ({ llm, defaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } }),
    pluginVersion: '1.6.0',
  });
}

function post(body) {
  return new Request(ORIGIN + ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('an invented path costs exactly one repair pass and is removed', async () => {
  const llm = makeLlm2([INVENTED], [CLEAN]);
  const payload = await (await routesWith(llm).optimize(post({ text: DRAFT }))).json();
  assert.equal(payload.text, CLEAN);
  assert.equal(payload.ledger.repaired, true);
  assert.deepEqual(payload.ledger.added.map((entry) => entry.value), []);
  assert.equal(llm.seen.length, 2);
  assert.match(llm.seen[1].messages[0].content[0].text, /Invented material that is not in the original draft/);
});

test('a low-risk addition is reported and costs no extra call', async () => {
  const llm = makeLlm2(['# 目标\n写 3 段总结'], ['unused']);
  const payload = await (await routesWith(llm).optimize(post({ text: '写一份总结' }))).json();
  assert.equal(llm.seen.length, 1);
  assert.equal(payload.ledger.added.length, 1);
  assert.equal(payload.ledger.added[0].risk, 'low');
});

test('a repair that keeps the invented fact is refused', async () => {
  const llm = makeLlm2([INVENTED], [INVENTED]);
  const payload = await (await routesWith(llm).optimize(post({ text: DRAFT }))).json();
  assert.equal(llm.seen.length, 2);
  assert.equal(payload.text, INVENTED);
  assert.equal(payload.ledger.repaired, false);
  assert.equal(payload.ledger.added.filter((entry) => entry.risk === 'high').length, 2);
});

test('the candidate path also catches an invented fact', async () => {
  const llm = makeLlm2([INVENTED], [CLEAN]);
  const payload = await (await routesWith(llm).optimize(post({ text: DRAFT, candidates: 2 }))).json();
  assert.equal(payload.text, CLEAN);
  assert.equal(payload.ledger.repaired, true);
  assert.equal(llm.seen.length, 3);
});

test('a quoted constraint the draft never said is high risk', () => {
  const found = verifyAdded('给 settings 模块补单测', '# 约束\n「测试要全绿」「不改被测代码」\n# 目标\n补单测');
  const values = found.high.map((entry) => entry.value);
  assert.ok(values.includes('测试要全绿'), values.join(' | '));
  assert.ok(values.includes('不改被测代码'), values.join(' | '));
});

test('quoting the draft own constraint stays clean', () => {
  const found = verifyAdded('别太土，写 5 个 slogan', '# 约束\n「别太土」，5 个 slogan');
  assert.deepEqual(found.high, []);
  assert.deepEqual(found.low, []);
});

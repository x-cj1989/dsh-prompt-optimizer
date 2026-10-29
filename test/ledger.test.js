import test from 'node:test';
import assert from 'node:assert/strict';

import { ROUTE, createRoutes } from '../lib/handler.js';

const ORIGIN = 'http://127.0.0.1:1234';
const DRAFT = '把 E:\\work\\a.py 在 2024年3月 前改好，输出 3 份，不要 emoji';
const DROPPED = '# 任务\n改好代码并写好说明';
const REPAIRED = '# 任务\n在 2024年3月 前改好 E:\\work\\a.py，输出 3 份，不要 emoji';

function makeLlm({ first, second }) {
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

function parseSse(raw) {
  return raw
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5).trim()));
}

test('a dropped anchor triggers exactly one repair pass', async () => {
  const llm = makeLlm({ first: [DROPPED], second: [REPAIRED] });
  const payload = await (await routesWith(llm).optimize(post({ text: DRAFT }))).json();
  assert.equal(payload.text, REPAIRED);
  assert.equal(payload.ledger.repaired, true);
  assert.deepEqual(payload.ledger.missing, []);
  assert.equal(payload.ledger.kept, payload.ledger.anchors);
  assert.equal(llm.seen.length, 2);
  assert.match(llm.seen[1].messages[0].content[0].text, /Missing from your rewrite/);
});

test('a rewrite that keeps every anchor costs one model call and says so', async () => {
  const llm = makeLlm({ first: [REPAIRED], second: ['unused'] });
  const payload = await (await routesWith(llm).optimize(post({ text: DRAFT }))).json();
  assert.equal(llm.seen.length, 1);
  assert.equal(payload.ledger.repaired, false);
  assert.deepEqual(payload.ledger.missing, []);
});

test('a repair that keeps fewer anchors is refused', async () => {
  const llm = makeLlm({ first: [DROPPED], second: ['# 任务\n写点东西'] });
  const payload = await (await routesWith(llm).optimize(post({ text: DRAFT }))).json();
  assert.equal(payload.text, DROPPED);
  assert.equal(payload.ledger.repaired, false);
  assert.ok(payload.ledger.missing.length > 0);
});

test('the SSE stream announces the repair with a reset frame', async () => {
  const llm = makeLlm({ first: [DROPPED], second: [REPAIRED] });
  const events = parseSse(await (await routesWith(llm).optimize(post({ text: DRAFT, stream: true }))).text());
  assert.ok(events.some((event) => event.type === 'reset'));
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, REPAIRED);
  assert.equal(done.ledger.repaired, true);
});

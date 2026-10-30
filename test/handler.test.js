import test from 'node:test';
import assert from 'node:assert/strict';

import { MODELS_ROUTE, ROUTE, createRoutes } from '../lib/handler.js';

const ORIGIN = 'http://127.0.0.1:1234';

function makeLlm({ deltas = ['hel', 'lo'], fail = false, providers = ['p1'], models = ['m1', 'm2'], deltasPerCall = null } = {}) {
  const seen = [];
  return {
    seen,
    async *stream(request) {
      seen.push(request);
      if (fail) throw new Error('upstream exploded');
      const call = Array.isArray(deltasPerCall) ? deltasPerCall[seen.length - 1] : undefined;
      for (const item of call === undefined ? deltas : call) {
        yield typeof item === 'string' ? { type: 'text-delta', index: 0, text: item } : item;
      }
      yield { type: 'finish', reason: 'stop' };
    },
    async listProviders() {
      return providers;
    },
    async listModels() {
      return models;
    },
  };
}

function makeRoutes({ services = {}, deltas, fail, providers, models, config, deltasPerCall } = {}) {
  const llm = makeLlm({ deltas, fail, providers, models, deltasPerCall });
  const routeSet = createRoutes({
    getServices: () => ({ llm, defaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) }, ...services }),
    pluginVersion: '1.2.0',
    config,
  });
  return { routes: routeSet, llm };
}

function postJson(body, path = ROUTE) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseSse(raw) {
  const events = [];
  for (const frame of raw.split('\n\n')) {
    const line = frame.trim();
    if (!line.startsWith('data:')) continue;
    events.push(JSON.parse(line.slice(5).trim()));
  }
  return events;
}

test('POST rewrites a draft and reports the model used', async () => {
  const { routes, llm } = makeRoutes();
  const response = await routes.optimize(postJson({ text: '  帮我写个周报  ' }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.text, 'hello');
  assert.equal(payload.provider, 'deepseek');
  assert.equal(payload.model, 'chat');
  assert.equal(payload.pluginVersion, '1.2.0');
  assert.equal(llm.seen.length, 1);
  assert.equal(llm.seen[0].temperature, 0.2);
  assert.equal(llm.seen[0].messages[0].content[0].text, '帮我写个周报');
});

test('POST streams meta/delta/done frames when stream is true', async () => {
  const { routes } = makeRoutes({ deltas: ['# 角色', '\n- 任务'] });
  const response = await routes.optimize(postJson({ text: 'x', stream: true }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = parseSse(await response.text());
  assert.deepEqual(events[0], {
    type: 'meta',
    provider: 'deepseek',
    model: 'chat',
    source: 'profile',
    pluginVersion: '1.2.0',
    preset: 'general',
  });
  assert.deepEqual(events.filter((event) => event.type === 'delta').map((event) => event.text), ['# 角色', '\n- 任务']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, '# 角色\n- 任务');
});

test('the streamed text is fence-stripped in the done frame', async () => {
  const { routes } = makeRoutes({ deltas: ['```markdown\n', '# Prompt', '\n```'] });
  const events = parseSse(await (await routes.optimize(postJson({ text: 'x', stream: true }))).text());
  assert.equal(events.at(-1).text, '# Prompt');
});

test('an upstream failure surfaces as an error frame, not a broken stream', async () => {
  const { routes } = makeRoutes({ fail: true });
  const events = parseSse(await (await routes.optimize(postJson({ text: 'x', stream: true }))).text());
  const failure = events.at(-1);
  assert.equal(failure.type, 'error');
  assert.match(failure.message, /upstream exploded/);
});

test('the temperature is clamped before it reaches the model', async () => {
  const { routes, llm } = makeRoutes();
  await routes.optimize(postJson({ text: 'x', temperature: 5 }));
  assert.equal(llm.seen[0].temperature, 1);
});

test('an explicit provider/model override wins over the profile default', async () => {
  const { routes, llm } = makeRoutes({ services: { defaultModel: undefined } });
  const response = await routes.optimize(postJson({ text: 'x', provider: 'openai', model: 'gpt-x' }));
  assert.equal(response.status, 200);
  assert.equal(llm.seen[0].provider, 'openai');
  assert.equal(llm.seen[0].model, 'gpt-x');
});

test('non-POST methods are rejected on the optimize route', async () => {
  const { routes } = makeRoutes();
  const response = await routes.optimize(new Request(`${ORIGIN}${ROUTE}`, { method: 'GET' }));
  assert.equal(response.status, 405);
});

test('a non-JSON body is a 400', async () => {
  const { routes } = makeRoutes();
  const request = new Request(`${ORIGIN}${ROUTE}`, { method: 'POST', body: 'not json' });
  assert.equal((await routes.optimize(request)).status, 400);
});

test('an empty draft is a 400 and never reaches the model', async () => {
  const { routes, llm } = makeRoutes();
  for (const body of [{ text: '' }, { text: '   ' }, {}]) {
    assert.equal((await routes.optimize(postJson(body))).status, 400);
  }
  assert.equal(llm.seen.length, 0);
});

test('a draft above the hard ceiling is a 413', async () => {
  const { routes, llm } = makeRoutes();
  assert.equal((await routes.optimize(postJson({ text: 'a'.repeat(120001) }))).status, 413);
  assert.equal(llm.seen.length, 0);
});

test('a long draft is rewritten part by part and joined back', async () => {
  const { routes, llm } = makeRoutes();
  const block = 'x'.repeat(15000);
  const text = [block, block].join('\n\n');
  const response = await routes.optimize(postJson({ text }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(llm.seen.length, 2);
  assert.equal(payload.ledger.chunks, 2);
  assert.match(JSON.stringify(llm.seen[0]), /part 1 of 2/);
  assert.match(JSON.stringify(llm.seen[1]), /part 2 of 2/);
});

test('without a profile default the first advertised model is used', async () => {
  const { routes, llm } = makeRoutes({ services: { defaultModel: undefined }, providers: ['p1'], models: ['m1'] });
  const response = await routes.optimize(postJson({ text: 'x' }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, 'catalogue');
  assert.equal(payload.provider, 'p1');
  assert.equal(payload.model, 'm1');
  assert.equal(llm.seen[0].model, 'm1');
});

test('only an empty catalogue is a 503', async () => {
  const { routes } = makeRoutes({ services: { defaultModel: undefined }, providers: [], models: [] });
  const response = await routes.optimize(postJson({ text: 'x' }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /No model is available/);
});

test('the bundle config wins over the profile default', async () => {
  const { routes, llm } = makeRoutes({ config: { provider: 'cfg', model: 'cfm', temperature: 0.6 } });
  const payload = await (await routes.optimize(postJson({ text: 'x' }))).json();
  assert.equal(payload.source, 'config');
  assert.deepEqual([payload.provider, payload.model], ['cfg', 'cfm']);
  assert.equal(llm.seen[0].temperature, 0.6);
});

test('an explicit request still wins over the bundle config', async () => {
  const { routes, llm } = makeRoutes({ config: { provider: 'cfg', model: 'cfm' } });
  const payload = await (await routes.optimize(postJson({ text: 'x', provider: 'req', model: 'rem' }))).json();
  assert.equal(payload.source, 'request');
  assert.deepEqual([payload.provider, payload.model], ['req', 'rem']);
  assert.equal(llm.seen[0].provider, 'req');
});

test('a half-filled config is ignored instead of guessing', async () => {
  const { routes } = makeRoutes({ config: { provider: 'cfg', model: '' } });
  const payload = await (await routes.optimize(postJson({ text: 'x' }))).json();
  assert.equal(payload.source, 'profile');
});

test('a missing LLM service is a 503', async () => {
  const { routes } = makeRoutes({ services: { llm: undefined } });
  assert.equal((await routes.optimize(postJson({ text: 'x' }))).status, 503);
});

test('an upstream failure is a 502 carrying the reason', async () => {
  const { routes } = makeRoutes({ fail: true });
  const response = await routes.optimize(postJson({ text: 'x' }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /upstream exploded/);
});

test('an empty model answer is a 502', async () => {
  const { routes } = makeRoutes({ deltas: ['   '] });
  const response = await routes.optimize(postJson({ text: 'x' }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /no text/);
});

test('an empty first answer is retried once with more room', async () => {
  const { routes, llm } = makeRoutes({ deltasPerCall: [[], ['# 目标', '\n- 写周报']] });
  const response = await routes.optimize(postJson({ text: '帮我写个周报' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).text, '# 目标\n- 写周报');
  assert.equal(llm.seen.length, 2);
  assert.ok(llm.seen[1].maxTokens > llm.seen[0].maxTokens, String(llm.seen[1].maxTokens));
});

test('a reasoning-only answer explains the cause', async () => {
  const reasoning = [{ type: 'reasoning-delta', index: 0, text: '想一下……' }];
  const { routes, llm } = makeRoutes({ deltasPerCall: [reasoning, reasoning] });
  const response = await routes.optimize(postJson({ text: '帮我写个周报' }));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /reasoning/);
  assert.equal(llm.seen.length, 2);
});

test('GET /models returns the catalogue and the default selection', async () => {
  const { routes } = makeRoutes({ providers: ['p1', 'p2'], models: ['m1', 'm2'] });
  const response = await routes.models(new Request(`${ORIGIN}${MODELS_ROUTE}`, { method: 'GET' }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.default, { provider: 'deepseek', model: 'chat', source: 'profile' });
  assert.equal(payload.pluginVersion, '1.2.0');
  assert.equal(payload.maxInputChars, 24000);
  assert.deepEqual(payload.models.map((item) => `${item.provider}/${item.model}`), [
    'p1/m1',
    'p1/m2',
    'p2/m1',
    'p2/m2',
  ]);
});

test('GET /models survives a service that cannot list models', async () => {
  const routes = createRoutes({
    getServices: () => ({
      llm: {
        async stream() {},
        async listProviders() {
          throw new Error('no providers endpoint');
        },
      },
      defaultModel: undefined,
    }),
    pluginVersion: '1.2.0',
  });
  const response = await routes.models(new Request(`${ORIGIN}${MODELS_ROUTE}`, { method: 'GET' }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.models, []);
  assert.equal(payload.default, null);
});

test('POST /models is a 405', async () => {
  const { routes } = makeRoutes();
  assert.equal((await routes.models(new Request(`${ORIGIN}${MODELS_ROUTE}`, { method: 'POST' }))).status, 405);
});

test('the response carries the model profile and a contract check', async () => {
  const { routes } = makeRoutes({
    services: { defaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }) } },
    deltas: ['# 目标\n- x\n\n# 验收\n- 跑测试\n\n# 验证\n- npm test\n\n# 停止条件\n- 失败即报告'],
  });
  const payload = await (await routes.optimize(postJson({ text: 'x' }))).json();
  assert.equal(payload.profile.family, 'reasoning');
  assert.equal(payload.profile.reasoning, true);
  assert.equal(payload.contract.ok, true);
  assert.ok(payload.contract.score > 0);
});

test('the system prompt is tuned to the selected reasoning model', async () => {
  const { routes, llm } = makeRoutes({
    services: { defaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4.1-flash' }) } },
  });
  await routes.optimize(postJson({ text: 'x' }));
  assert.match(llm.seen[0].system, /reasoning-style/);
  assert.equal(llm.seen[0].maxTokens, 6000);
});

test('a known session id grounds the rewrite with the live workspace', async () => {
  const session = { id: 's1' };
  const { routes, llm } = makeRoutes({
    services: {
      agents: { get: (id) => (id === 's1' ? { session } : undefined) },
      workingDirectory: { get: (value) => (value === session ? 'E:\\hermes-work' : '') },
    },
  });
  const payload = await (await routes.optimize(postJson({ text: 'x', sessionId: 's1', title: '周报\n会话' }))).json();
  assert.deepEqual(payload.grounding, { cwd: 'E:\\hermes-work', title: '周报 会话' });
  const sent = llm.seen[0].messages[0].content[0].text;
  assert.match(sent, /^Read-only context supplied by the harness/);
  assert.match(sent, /workspace: E:\\hermes-work/);
  assert.match(sent, /session: 周报 会话/);
  assert.ok(sent.endsWith('x'));
});

test('an unknown session or missing service degrades to no context', async () => {
  const { routes, llm } = makeRoutes({
    services: { agents: { get: () => { throw new Error('session closed'); } }, workingDirectory: { get: () => 'E:\\x' } },
  });
  const payload = await (await routes.optimize(postJson({ text: 'x', sessionId: 'zz' }))).json();
  assert.equal(payload.grounding, null);
  assert.equal(llm.seen[0].messages[0].content[0].text, 'x');
});

test('grounding survives the SSE done frame', async () => {
  const session = { id: 's2' };
  const { routes } = makeRoutes({
    services: {
      agents: { get: () => ({ session }) },
      workingDirectory: { get: () => 'D:\\proj' },
    },
  });
  const events = parseSse(await (await routes.optimize(postJson({ text: 'x', sessionId: 's2', stream: true }))).text());
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.deepEqual(done.grounding, { cwd: 'D:\\proj', title: '' });
});
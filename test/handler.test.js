import test from 'node:test';
import assert from 'node:assert/strict';

import { MODELS_ROUTE, ROUTE, createRoutes } from '../lib/handler.js';

const ORIGIN = 'http://127.0.0.1:1234';

function makeLlm({ deltas = ['hel', 'lo'], fail = false, providers = ['p1'], models = ['m1', 'm2'] } = {}) {
  const seen = [];
  return {
    seen,
    async *stream(request) {
      seen.push(request);
      if (fail) throw new Error('upstream exploded');
      for (const text of deltas) yield { type: 'text-delta', index: 0, text };
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

function makeRoutes({ services = {}, deltas, fail, providers, models } = {}) {
  const llm = makeLlm({ deltas, fail, providers, models });
  const routeSet = createRoutes({
    getServices: () => ({ llm, defaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) }, ...services }),
    pluginVersion: '1.2.0',
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
  assert.deepEqual(events[0], { type: 'meta', provider: 'deepseek', model: 'chat' });
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

test('an over-long draft is a 413', async () => {
  const { routes, llm } = makeRoutes();
  assert.equal((await routes.optimize(postJson({ text: 'a'.repeat(24001) }))).status, 413);
  assert.equal(llm.seen.length, 0);
});

test('a missing default model is a 503 with an actionable message', async () => {
  const { routes } = makeRoutes({ services: { defaultModel: undefined } });
  const response = await routes.optimize(postJson({ text: 'x' }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /No default model/);
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

test('GET /models returns the catalogue and the default selection', async () => {
  const { routes } = makeRoutes({ providers: ['p1', 'p2'], models: ['m1', 'm2'] });
  const response = await routes.models(new Request(`${ORIGIN}${MODELS_ROUTE}`, { method: 'GET' }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.default, { provider: 'deepseek', model: 'chat' });
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

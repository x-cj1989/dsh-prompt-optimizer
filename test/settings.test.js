import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SETTINGS,
  SYSTEM_PROMPT,
  buildSystemPrompt,
  normalizeSettings,
  pickBestCandidate,
  scoreCandidate,
  spreadTemperature,
} from '../lib/rewrite.js';
import { SETTINGS_ROUTE, createRoutes } from '../lib/handler.js';
import { createSettingsStore } from '../lib/settings.js';

const ORIGIN = 'http://127.0.0.1:1234';

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-po-'));
  return path.join(directory, 'prompt-optimizer.json');
}

function makeLlm({ answers = [['plain answer']] } = {}) {
  const seen = [];
  let call = 0;
  return {
    seen,
    async *stream(request) {
      seen.push(request);
      const deltas = answers[Math.min(call, answers.length - 1)] ?? [];
      call += 1;
      if (request.signal?.aborted) return;
      for (const text of deltas) yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: 'stop' };
    },
    async listProviders() {
      return ['p1'];
    },
    async listModels() {
      return ['m1'];
    },
  };
}

function makeRoutes({ store, llm = makeLlm(), config } = {}) {
  return createRoutes({
    getServices: () => ({
      llm,
      defaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'chat' }) },
    }),
    pluginVersion: '1.5.0',
    store,
    config,
  });
}

function postSettings(body) {
  return new Request(`${ORIGIN}${SETTINGS_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('normalizeSettings fills defaults and clamps out-of-range numbers', () => {
  const defaults = normalizeSettings(undefined);
  assert.deepEqual(defaults.settings, DEFAULT_SETTINGS);
  assert.deepEqual(defaults.rejected, []);

  const clamped = normalizeSettings({ temperature: 9, maxOutputTokens: 99, candidates: 7, preset: 'coding' });
  assert.equal(clamped.settings.temperature, 1);
  assert.equal(clamped.settings.maxOutputTokens, 200);
  assert.equal(clamped.settings.candidates, 3);
  assert.equal(clamped.settings.preset, 'coding');
  assert.deepEqual(clamped.rejected, []);
});

test('normalizeSettings reports wrong types instead of guessing', () => {
  const result = normalizeSettings({ temperature: 'warm', preset: 'nope', candidates: null });
  assert.deepEqual(result.rejected.sort(), ['candidates', 'preset', 'temperature']);
  assert.deepEqual(result.settings, DEFAULT_SETTINGS);
});

test('buildSystemPrompt adds the preset context and leaves general untouched', () => {
  assert.equal(buildSystemPrompt('general'), SYSTEM_PROMPT);
  assert.equal(buildSystemPrompt('unknown'), SYSTEM_PROMPT);
  const coding = buildSystemPrompt('coding');
  assert.ok(coding.startsWith(SYSTEM_PROMPT));
  assert.match(coding, /language and version/u);
});

test('scoreCandidate prefers structured answers over meta chatter', () => {
  const structured = '## 角色\n你是分析师。\n\n## 任务\n- 目标：写报告\n- 输出：Markdown\n';
  const chatter = 'Here is your prompt: 帮我写个报告';
  assert.ok(scoreCandidate(structured) > scoreCandidate(chatter));
  assert.equal(scoreCandidate(''), 0);
  assert.ok(scoreCandidate('```\nTODO\n```') < 0);
});

test('pickBestCandidate returns the highest scoring text and breaks ties early', () => {
  const best = pickBestCandidate(['short', '## A\n- x\n- y\n- z\n', 'short too']);
  assert.equal(best.index, 1);
  assert.equal(best.scores.length, 3);
  assert.deepEqual(pickBestCandidate(['same', 'same']).index, 0);
});

test('spreadTemperature keeps the first run and stays inside the band', () => {
  assert.equal(spreadTemperature(0.2, 0, 1), 0.2);
  assert.equal(spreadTemperature(0.2, 0, 3), 0.2);
  assert.ok(spreadTemperature(0.2, 1, 3) > 0.2);
  assert.equal(spreadTemperature(0.95, 2, 3), 1);
});

test('settings store starts from defaults, persists patches and can reset', () => {
  const file = tempFile();
  const store = createSettingsStore({ file });
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);

  const saved = store.patch({ temperature: 0.6, preset: 'writing' });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.temperature, 0.6);

  const reopened = createSettingsStore({ file });
  assert.equal(reopened.get().temperature, 0.6);
  assert.equal(reopened.get().preset, 'writing');

  assert.equal(store.patch({ preset: 'nope' }).ok, false);
  assert.equal(store.get().preset, 'writing');

  const reset = store.reset();
  assert.equal(reset.ok, true);
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
});

test('settings store ignores a corrupt file instead of throwing', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json', 'utf8');
  const store = createSettingsStore({ file });
  assert.deepEqual(store.get(), DEFAULT_SETTINGS);
});

test('GET settings describes the current values, bounds and presets', async () => {
  const store = createSettingsStore({ file: tempFile() });
  store.patch({ candidates: 2 });
  const response = await makeRoutes({ store }).settings(new Request(`${ORIGIN}${SETTINGS_ROUTE}`));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.settings.candidates, 2);
  assert.equal(payload.bounds.candidates.max, 3);
  assert.ok(payload.presets.some((preset) => preset.id === 'coding'));
  assert.equal(payload.pluginVersion, '1.5.0');
});

test('POST settings merges a patch, rejects garbage and supports reset', async () => {
  const store = createSettingsStore({ file: tempFile() });
  const routes = makeRoutes({ store });

  const saved = await routes.settings(postSettings({ temperature: 0.4 }));
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.temperature, 0.4);

  const rejected = await routes.settings(postSettings({ preset: 42 }));
  assert.equal(rejected.status, 400);

  const reset = await routes.settings(postSettings({ reset: true }));
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).settings.temperature, DEFAULT_SETTINGS.temperature);

  const badMethod = await routes.settings(new Request(`${ORIGIN}${SETTINGS_ROUTE}`, { method: 'DELETE' }));
  assert.equal(badMethod.status, 405);
});

test('settings POST without a writable store answers 503', async () => {
  const response = await makeRoutes().settings(postSettings({ temperature: 0.3 }));
  assert.equal(response.status, 503);
});

test('optimize uses the stored temperature and preset', async () => {
  const store = createSettingsStore({ file: tempFile() });
  store.patch({ temperature: 0.45, preset: 'coding' });
  const llm = makeLlm();
  const routes = makeRoutes({ store, llm });
  const response = await routes.optimize(
    new Request(`${ORIGIN}/api/prompt.optimize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '写个脚本' }),
    }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.preset, 'coding');
  assert.equal(llm.seen[0].temperature, 0.45);
  assert.match(llm.seen[0].system, /language and version/u);
});

test('candidates > 1 runs several rewrites and returns the best scored one', async () => {
  const store = createSettingsStore({ file: tempFile() });
  store.patch({ candidates: 2 });
  const llm = makeLlm({ answers: [['plain words only'], ['## 目标\n- 一\n- 二\n- 三\n']] });
  const routes = makeRoutes({ store, llm });
  const response = await routes.optimize(
    new Request(`${ORIGIN}/api/prompt.optimize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '写个报告' }),
    }),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.candidates, 2);
  assert.equal(payload.scores.length, 2);
  assert.match(payload.text, /## 目标/u);
  assert.equal(llm.seen.length, 2);
  assert.ok(llm.seen[1].temperature > llm.seen[0].temperature);
});

test('candidates > 1 with only empty answers answers 502', async () => {
  const store = createSettingsStore({ file: tempFile() });
  store.patch({ candidates: 2 });
  const routes = makeRoutes({ store, llm: makeLlm({ answers: [['   '], ['']] }) });
  const response = await routes.optimize(
    new Request(`${ORIGIN}/api/prompt.optimize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '写个报告' }),
    }),
  );
  assert.equal(response.status, 502);
});

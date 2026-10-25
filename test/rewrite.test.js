import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TEMPERATURE,
  MAX_INPUT_CHARS,
  SYSTEM_PROMPT,
  buildMessages,
  clampTemperature,
  normalizeOutput,
  parseTarget,
  sanitizeDraft,
  unwrapFence,
} from '../lib/rewrite.js';

test('sanitizeDraft trims and accepts a normal draft', () => {
  assert.deepEqual(sanitizeDraft('  写个周报  '), { ok: true, text: '写个周报' });
});

test('sanitizeDraft rejects empty, non-string and blank drafts', () => {
  for (const value of ['', '   ', undefined, null, 42, {}, []]) {
    const result = sanitizeDraft(value);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
});

test('sanitizeDraft rejects drafts above the character budget', () => {
  const result = sanitizeDraft('a'.repeat(MAX_INPUT_CHARS + 1));
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.match(result.error, /24000/);
});

test('sanitizeDraft keeps a draft exactly at the budget', () => {
  assert.equal(sanitizeDraft('a'.repeat(MAX_INPUT_CHARS)).ok, true);
});

test('unwrapFence removes exactly one wrapping fence', () => {
  assert.equal(unwrapFence('```markdown\n# Title\nbody\n```'), '# Title\nbody');
  assert.equal(unwrapFence('```\nplain\n```'), 'plain');
  assert.equal(unwrapFence('```js\r\nconst a = 1\r\n```'), 'const a = 1');
});

test('unwrapFence leaves inline and unbalanced fences alone', () => {
  assert.equal(unwrapFence('use ```code``` inline'), 'use ```code``` inline');
  assert.equal(unwrapFence('```js\nunterminated'), '```js\nunterminated');
  assert.equal(unwrapFence('# Title\n```js\nconst a = 1\n```\ntail'), '# Title\n```js\nconst a = 1\n```\ntail');
});

test('normalizeOutput trims the answer and strips a wrapping fence', () => {
  assert.deepEqual(normalizeOutput('  ```\n# Prompt\n- do it\n```  '), { ok: true, text: '# Prompt\n- do it' });
});

test('normalizeOutput reports an empty model answer as 502', () => {
  for (const value of ['', '   ', '```\n\n```', undefined, null, 42]) {
    const result = normalizeOutput(value);
    assert.equal(result.ok, false);
    assert.equal(result.status, 502);
  }
});

test('clampTemperature clamps into [0, 1] and defaults on garbage', () => {
  assert.equal(clampTemperature(0.35), 0.35);
  assert.equal(clampTemperature(-2), 0);
  assert.equal(clampTemperature(9), 1);
  assert.equal(clampTemperature(undefined), DEFAULT_TEMPERATURE);
  assert.equal(clampTemperature('nonsense'), DEFAULT_TEMPERATURE);
  assert.equal(clampTemperature('0.4'), 0.4);
});

test('parseTarget accepts nothing, a full pair, or rejects a half pair', () => {
  assert.deepEqual(parseTarget({}), { ok: true, target: undefined });
  assert.deepEqual(parseTarget({ provider: '', model: '' }), { ok: true, target: undefined });
  assert.deepEqual(parseTarget({ provider: ' p ', model: ' m ' }), { ok: true, target: { provider: 'p', model: 'm' } });

  for (const payload of [{ provider: 'p' }, { model: 'm' }, { provider: 'p', model: 7 }, { provider: 7, model: 'm' }]) {
    const result = parseTarget(payload);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
  }
});

test('parseTarget rejects absurdly long names', () => {
  const result = parseTarget({ provider: 'p'.repeat(200), model: 'm' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
});

test('buildMessages stamps one user message with the plugin source kind', () => {
  const messages = buildMessages('hello');
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, 'dsh-prompt-optimizer');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(typeof message.id, 'string');
  assert.notEqual(buildMessages('hello')[0].id, message.id);
});

test('SYSTEM_PROMPT carries the load-bearing rewrite rules', () => {
  for (const needle of ['senior prompt engineer', 'Preserve the user intent', 'same language', 'No preamble']) {
    assert.ok(SYSTEM_PROMPT.includes(needle), `missing rule: ${needle}`);
  }
});

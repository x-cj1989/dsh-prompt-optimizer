import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TEMPERATURE,
  MAX_DRAFT_CHARS,
  MAX_INPUT_CHARS,
  SYSTEM_PROMPT,
  buildMessages,
  clampTemperature,
  normalizeOutput,
  parseTarget,
  sanitizeDraft,
  segmentSystemPrompt,
  splitDraft,
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

test('a draft above the per-call budget is accepted so it can be chunked', () => {
  assert.equal(sanitizeDraft('a'.repeat(MAX_INPUT_CHARS + 1)).ok, true);
});

test('sanitizeDraft rejects a draft above the hard ceiling', () => {
  const result = sanitizeDraft('a'.repeat(MAX_DRAFT_CHARS + 1));
  assert.equal(result.ok, false);
  assert.equal(result.status, 413);
  assert.match(result.error, /120000/);
});

test('sanitizeDraft keeps a draft exactly at the hard ceiling', () => {
  assert.equal(sanitizeDraft('a'.repeat(MAX_DRAFT_CHARS)).ok, true);
});

test('splitDraft keeps a short draft whole', () => {
  assert.deepEqual(splitDraft('写个周报'), ['写个周报']);
  assert.deepEqual(splitDraft(''), []);
});

test('splitDraft cuts on paragraph boundaries and loses nothing', () => {
  const block = 'x'.repeat(900);
  const text = [block, block, block].join('\n\n');
  const parts = splitDraft(text, 1000);
  assert.ok(parts.length > 1, String(parts.length));
  for (const part of parts) assert.ok(part.length <= 1000, String(part.length));
  assert.equal(parts.join(''), text);
});

test('splitDraft hard-wraps one huge paragraph without splitting a surrogate pair', () => {
  const text = '😀'.repeat(300);
  const parts = splitDraft(text, 100);
  for (const part of parts) {
    assert.ok(part.length <= 100, String(part.length));
    assert.ok(!/[\ud800-\udbff]$/u.test(part), 'split surrogate pair');
  }
  assert.equal(parts.join(''), text);
});

test('segmentSystemPrompt only marks real parts', () => {
  assert.equal(segmentSystemPrompt('SYS', 0, 1), 'SYS');
  assert.equal(segmentSystemPrompt('SYS', 0, 0), 'SYS');
  const marked = segmentSystemPrompt('SYS', 1, 3);
  assert.ok(marked.startsWith('SYS'));
  assert.match(marked, /part 2 of 3/);
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
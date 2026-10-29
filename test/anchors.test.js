import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ANCHORS,
  SYSTEM_PROMPT,
  buildLedger,
  buildRepairMessages,
  extractAnchors,
  verifyAnchors,
} from '../lib/rewrite.js';

const values = (anchors) => anchors.map((anchor) => anchor.value);

test('extractAnchors picks up numbers, dates, paths, quotes and negations', () => {
  const anchors = extractAnchors('把 E:\\work\\a.py 在 2024年3月15日 前改好，输出 3 份，不要 emoji，引用「原文」这段话');
  const found = values(anchors);
  const label = found.join(' | ');
  assert.ok(found.includes('E:\\work\\a.py'), label);
  assert.ok(found.includes('2024年3月15日'), label);
  assert.ok(found.includes('原文'), label);
  assert.ok(found.includes('不要'), label);
  assert.ok(found.includes('3'), label);
});

test('extractAnchors dedupes repeated tokens and stops at the cap', () => {
  assert.equal(values(extractAnchors('写 3 段，再写 3 段')).filter((value) => value === '3').length, 1);
  const many = Array.from({ length: MAX_ANCHORS + 10 }, (_, index) => '第' + (index + 1) + '条').join('，');
  assert.equal(extractAnchors(many).length, MAX_ANCHORS);
});

test('verifyAnchors tolerates spacing and reports real drops', () => {
  const anchors = extractAnchors('在 2024年3月 交付 3 份报告，不要 emoji');
  const kept = verifyAnchors(anchors, '# 任务\n2024 年 3 月交付 3 份报告，不要 emoji');
  assert.equal(kept.total, kept.kept);
  assert.deepEqual(kept.missing, []);

  const dropped = verifyAnchors(anchors, '# 任务\n写一份报告');
  assert.ok(dropped.missing.includes('2024年3月'));
  assert.ok(dropped.missing.includes('不要'));
  assert.equal(dropped.kept + dropped.missing.length, dropped.total);
});

test('verifyAnchors counts a negated constraint kept when the rewrite rewords it', () => {
  const anchors = extractAnchors('不要使用 emoji');
  assert.deepEqual(verifyAnchors(anchors, '写作时避免使用 emoji').missing, []);
});

test('buildLedger summarises a drop in one object', () => {
  const dropped = buildLedger('明天交 2 页', '写一页说明');
  assert.equal(dropped.anchors, dropped.kept + dropped.missing.length);
  assert.equal(dropped.repaired, false);
  assert.ok(dropped.missing.length > 0);
  assert.deepEqual(buildLedger('明天交 2 页', '明天交 2 页').missing, []);
});

test('buildRepairMessages names the missing items and quotes the draft', () => {
  const messages = buildRepairMessages({ draft: '交付 3 份', previous: '写报告', missing: ['3'] });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  const text = messages[0].content[0].text;
  assert.match(text, /交付 3 份/);
  assert.match(text, /写报告/);
  assert.match(text, /- 3/);
  assert.equal(messages[0].source.kind, 'dsh-prompt-optimizer');
});

test('SYSTEM_PROMPT now asks for assumptions, decidable acceptance and stop conditions', () => {
  for (const needle of ['explicit assumption', 'decidable', 'stop conditions', 'never a placeholder']) {
    assert.ok(SYSTEM_PROMPT.includes(needle), 'missing: ' + needle);
  }
});

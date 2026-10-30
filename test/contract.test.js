import test from 'node:test';
import assert from 'node:assert/strict';

import { CONTRACT_WEIGHTS, checkContract } from '../lib/contract.js';

const GOOD = [
  '# 目标',
  '把六棱柱展开图做成一段视频。',
  '',
  '# 验收',
  '输出 mp4：1080p30，时长 14–16 秒。',
  '',
  '# 验证',
  '导出后检查时长与分辨率。',
  '',
  '# 停止条件',
  '素材缺失时报告，不要编造。',
].join('\n');

test('a complete prompt passes with a clean score', () => {
  const result = checkContract(GOOD);
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
  assert.equal(result.score, 100);
});

test('a leftover placeholder is an error', () => {
  const result = checkContract(GOOD + '\n预算：[待补充]');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'placeholder'));
  assert.equal(result.score, 100 - CONTRACT_WEIGHTS.placeholder);
});

test('missing acceptance and verification are warnings, not failures', () => {
  const result = checkContract('把这件事做了。');
  assert.equal(result.ok, true);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes('acceptance'));
  assert.ok(codes.includes('verification'));
  assert.ok(result.score < 100);
});

test('meta commentary in front of the prompt is reported', () => {
  const result = checkContract('Here is the optimized prompt:\n\n' + GOOD);
  assert.ok(result.issues.some((issue) => issue.code === 'meta'));
  assert.equal(result.ok, true);
});

test('a credential is an error', () => {
  const result = checkContract(GOOD + '\nkey: sk-abcdefghijklmnop1234');
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === 'secret'));
});

test('an over-long prompt is reported against the budget', () => {
  const result = checkContract('x'.repeat(60), { maxChars: 40 });
  assert.ok(result.issues.some((issue) => issue.code === 'tooLong'));
});

test('an empty rewrite scores zero', () => {
  const result = checkContract('   ');
  assert.equal(result.ok, false);
  assert.equal(result.score, 0);
  assert.equal(result.issues[0].code, 'empty');
});

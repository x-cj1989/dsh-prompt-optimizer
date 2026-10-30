import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_BUDGET,
  REASONING_MODEL_BUDGET,
  modelGuidance,
  modelProfile,
  profileSummary,
} from '../lib/model-profile.js';
import { SYSTEM_PROMPT, buildMessages, buildSystemPrompt } from '../lib/rewrite.js';

test('a thinking model is profiled as reasoning', () => {
  const profile = modelProfile('sn-deepseek-v4-1-flash-1017', 'raccoon');
  assert.equal(profile.family, 'reasoning');
  assert.equal(profile.reasoning, true);
  assert.equal(profile.wantsPlanRule, false);
  assert.equal(profile.wantsExample, false);
  assert.equal(profile.tokenBudget, REASONING_MODEL_BUDGET);
});

test('an instruct model keeps the plan-first rules', () => {
  const profile = modelProfile('claude-sonnet-4');
  assert.equal(profile.family, 'general');
  assert.equal(profile.wantsPlanRule, true);
  assert.equal(profile.tokenBudget, DEFAULT_MODEL_BUDGET);
});

test('an unknown model falls back to the instruct profile', () => {
  assert.equal(modelProfile('').family, 'general');
  assert.equal(modelProfile(undefined).family, 'general');
  assert.equal(modelProfile(null, null).family, 'general');
});

test('guidance tells a reasoning model not to plan and not to restate', () => {
  const text = modelGuidance(modelProfile('o3-mini'));
  assert.match(text, /reasoning-style/);
  assert.match(text, /Do not tell it to think step by step/);
  assert.match(text, /must not restate the reasoning process/);
});

test('guidance for an instruct model keeps the plan and asks for an example', () => {
  const text = modelGuidance(modelProfile('gpt-4.1'));
  assert.match(text, /instruct-style/);
  assert.match(text, /plan-first/);
  assert.match(text, /example of the output shape/);
});

test('buildSystemPrompt appends model guidance only when a model is known', () => {
  assert.equal(buildSystemPrompt('general'), SYSTEM_PROMPT);
  assert.equal(buildSystemPrompt('general', {}), SYSTEM_PROMPT);
  const tuned = buildSystemPrompt('general', { model: 'deepseek-v4.1-flash' });
  assert.ok(tuned.startsWith(SYSTEM_PROMPT));
  assert.match(tuned, /reasoning-style/);
  const coding = buildSystemPrompt('coding', { model: 'claude-sonnet-4' });
  assert.match(coding, /Context: The draft is about code/);
  assert.match(coding, /instruct-style/);
});

test('buildMessages fences optional harness context as data', () => {
  const plain = buildMessages('draft');
  assert.equal(plain[0].content[0].text, 'draft');
  const withContext = buildMessages('draft', '  model: X\nworkspace: E:\\work  ');
  const text = withContext[0].content[0].text;
  assert.match(text, /^Read-only context supplied by the harness/);
  assert.match(text, /"""\nmodel: X/);
  assert.ok(text.endsWith('draft'));
});

test('profileSummary keeps only log-safe fields', () => {
  assert.deepEqual(profileSummary(modelProfile('o1')), {
    family: 'reasoning',
    reasoning: true,
    tokenBudget: REASONING_MODEL_BUDGET,
  });
  assert.equal(profileSummary(null), null);
});

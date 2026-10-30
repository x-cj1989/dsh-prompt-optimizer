import { readFileSync, writeFileSync } from 'node:fs';
import { buildSystemPrompt } from 'file:///E:/hermes-work/repos/dsh-prompt-optimizer/lib/rewrite.js';

const ROOT = 'E:/hermes-work/repos/dsh-prompt-optimizer';
const { tasks } = JSON.parse(readFileSync(ROOT + '/bench/answer_level/tasks.json', 'utf8'));
const MODEL = 'md/ZhipuAI/GLM-5.3-Flash';
const PROVIDER = 'md';
const baseline = 'You are a helpful assistant. Do exactly what the task asks, nothing more.';

const sideA = tasks.map((t) => ({ id: t.id, preset: t.preset, system: baseline, task: t.draft }));
const sideB = tasks.map((t) => ({
  id: t.id,
  preset: t.preset,
  system: buildSystemPrompt(t.preset, { model: MODEL, provider: PROVIDER }),
  task: t.draft,
}));
writeFileSync(ROOT + '/bench/answer_level/side_a.json', JSON.stringify(sideA, null, 2));
writeFileSync(ROOT + '/bench/answer_level/side_b.json', JSON.stringify(sideB, null, 2));
console.log('side_a', sideA.length, 'side_b', sideB.length, 'prompt chars(coding)', sideB[0].system.length);

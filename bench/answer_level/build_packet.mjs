import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'E:/hermes-work/repos/dsh-prompt-optimizer/bench/answer_level';
const rd = (f) => JSON.parse(readFileSync(ROOT + '/' + f, 'utf8'));
const { tasks } = rd('tasks.json');
const A = Object.fromEntries(rd('answers_a.json').map((x) => [x.id, x]));
const B = Object.fromEntries(rd('answers_b.json').map((x) => [x.id, x]));

// deterministic per-task A/B swap so the judge cannot infer side from position
let seed = 20261030;
const swap = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) > 0.5;

const key = {};
const packetRows = [];
for (const t of tasks) {
  const baseline = String(A[t.id]?.answer ?? A[t.id] ?? '');
  const plugin = String(B[t.id]?.answer ?? B[t.id] ?? '');
  const pluginIsX = swap();
  key[t.id] = { X: pluginIsX ? 'b' : 'a', Y: pluginIsX ? 'a' : 'b' };
  packetRows.push({
    id: t.id,
    requirements: t.constraints,
    X: { text: pluginIsX ? plugin : baseline },
    Y: { text: pluginIsX ? baseline : plugin },
  });
}
writeFileSync(ROOT + '/judge_key.json', JSON.stringify(key, null, 2));
writeFileSync(ROOT + '/judge_packet.json', JSON.stringify(packetRows, null, 2));
console.log('packet rows', packetRows.length, 'X=b count', Object.values(key).filter((v) => v.X === 'b').length);

import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = 'E:/hermes-work/repos/dsh-prompt-optimizer/bench/answer_level';
const rd = (f) => JSON.parse(readFileSync(ROOT + '/' + f, 'utf8'));
const tasks = rd('tasks.json').tasks;
const ansA = rd('answers_a.json');
const ansB = rd('answers_b.json');
const key = rd('judge_key.json');
const judges = rd('judge_scores.json').judges;
const DIMS = ['correctness', 'constraint_compliance', 'actionability', 'no_fabrication'];
const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x.answer ?? x]));
const A = byId(ansA);
const B = byId(ansB);

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n;
  const d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const h = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
  return [(c - h) / d, (c + h) / d];
}

const report = { tasks: tasks.length, sides: { baseline: 'a', plugin: 'b' }, judges: [] };
let cross = null;

for (const judge of judges) {
  const rows = judge.scores.map((s) => {
    const xSide = key[s.id].X;
    const plugin = xSide === 'b' ? s.X : s.Y;
    const base = xSide === 'b' ? s.Y : s.X;
    const dims = Object.fromEntries(DIMS.map((d) => [d, { plugin: plugin[d], base: base[d] }]));
    const ps = DIMS.reduce((a, d) => a + plugin[d], 0);
    const bs = DIMS.reduce((a, d) => a + base[d], 0);
    const win = ps > bs ? 'plugin' : ps < bs ? 'baseline' : 'tie';
    const chosen = s.winner === 'X' ? xSide : s.winner === 'Y' ? (xSide === 'a' ? 'b' : 'a') : null;
    return { id: s.id, dims, win, chosen };
  });
  const winCount = rows.filter((r) => r.win === 'plugin').length;
  const lossCount = rows.filter((r) => r.win === 'baseline').length;
  const tieCount = rows.filter((r) => r.win === 'tie').length;
  const ci = wilson(winCount, rows.length);
  report.judges.push({
    name: judge.name,
    wins: winCount, losses: lossCount, ties: tieCount,
    winRate: +(winCount / rows.length).toFixed(3),
    wilson95: [+ci[0].toFixed(3), +ci[1].toFixed(3)],
    meanDelta: +(DIMS.reduce((s, d) => s + (rows.reduce((a, r) => a + r.dims[d].plugin, 0) / rows.length - rows.reduce((a, r) => a + r.dims[d].base, 0) / rows.length), 0) / DIMS.length).toFixed(3),
    dims: Object.fromEntries(DIMS.map((d) => {
      const mp = rows.reduce((a, r) => a + r.dims[d].plugin, 0) / rows.length;
      const mb = rows.reduce((a, r) => a + r.dims[d].base, 0) / rows.length;
      return [d, { plugin: +mp.toFixed(2), baseline: +mb.toFixed(2), delta: +(mp - mb).toFixed(2) }];
    })),
    perTask: rows.map((r) => ({ id: r.id, win: r.win, deltas: Object.fromEntries(DIMS.map((d) => [d, +(r.dims[d].plugin - r.dims[d].base).toFixed(2)])) })),
  });
  cross = cross ?? rows;
}

// Cohen's kappa between the two judges on "plugin is better"
if (judges.length === 2) {
  const [j1, j2] = judges;
  const m1 = Object.fromEntries(j1.scores.map((s) => [s.id, s.winner]));
  const m2 = Object.fromEntries(j2.scores.map((s) => [s.id, s.winner]));
  const agree = (x, y) => (x === 'X' && y === 'X') || (x === 'Y' && y === 'Y') ? 1 : 0;
  const n = Object.keys(m1).length;
  const obs = Object.keys(m1).reduce((a, id) => a + agree(m1[id], m2[id]), 0) / n;
  const p1 = Object.values(m1).filter((v) => v === 'X').length / n;
  const p2 = Object.values(m2).filter((v) => v === 'X').length / n;
  const exp = p1 * p2 + (1 - p1) * (1 - p2);
  report.kappa = { observed: +obs.toFixed(3), expected: +exp.toFixed(3), value: +((obs - exp) / (1 - exp)).toFixed(3), note: 'blind A/B winner agreement (X/Y position, not side)' };
}

writeFileSync(ROOT + '/summary.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ wins: report.judges.map((j) => [j.name, j.wins, j.losses, j.ties, j.winRate, j.wilson95, j.meanDelta]), kappa: report.kappa }, null, 1));

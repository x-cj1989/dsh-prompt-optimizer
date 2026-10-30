#!/usr/bin/env node
// Draft benchmark for the prompt optimizer.
//   node bench/run.mjs --check        Level 1: offline contract check of every draft
//   node bench/run.mjs --limit 3      Level 2: rewrite + blind judge (needs PO_BENCH_BASE_URL)
// Level 2 env: PO_BENCH_BASE_URL, PO_BENCH_COOKIE or PO_BENCH_API_KEY,
//              PO_BENCH_MODEL (judge model, default chat), PO_BENCH_JUDGE_URL (optional).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { checkContract } from '../lib/contract.js';
import { ROUTE } from '../lib/handler.js';

const NL = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DRAFTS = path.join(HERE, 'drafts.jsonl');
const JUDGE_TIMEOUT_MS = 120000;
const REWRITE_TIMEOUT_MS = 180000;
const DIMENSIONS = ['satisfies', 'fidelity', 'executable', 'format'];
const RUBRIC = [
  'You are grading two candidate prompts written for the same user draft.',
  'Answer with JSON only: {"a":{"satisfies":0-5,"fidelity":0-5,"executable":0-5,"format":0-5},"b":{...},"reason":"one sentence"}',
  'satisfies: would executing it actually deliver what the draft asked for.',
  'fidelity: keeps the draft facts and constraints, invents nothing.',
  'executable: names the artifacts, commands or checks that prove completion.',
  'format: structure a model can follow without ambiguity.',
].join(NL);

const USAGE = [
  'Usage: node bench/run.mjs [--check] [--limit N] [--drafts FILE] [--json]',
  '',
  '  --check   Level 1 only: offline contract check of every draft.',
  '  --limit   Run only the first N drafts.',
  '  Level 2 also needs PO_BENCH_BASE_URL and PO_BENCH_COOKIE or PO_BENCH_API_KEY.',
].join(NL);

function parseArgs(argv) {
  const options = { check: false, limit: null, drafts: DEFAULT_DRAFTS, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--limit') { options.limit = Number(argv[i + 1]); i += 1; }
    else if (arg === '--drafts') { options.drafts = path.resolve(argv[i + 1]); i += 1; }
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
  }
  if (options.limit !== null && (!Number.isFinite(options.limit) || options.limit < 1)) {
    console.error('--limit needs a positive number');
    process.exit(2);
  }
  return options;
}

async function loadDrafts(file) {
  const raw = await readFile(file, 'utf8');
  const drafts = [];
  for (const [index, line] of raw.split(NL).entries()) {
    const text = line.trim();
    if (text === '' || text.startsWith('//')) continue;
    let item;
    try {
      item = JSON.parse(text);
    } catch {
      throw new Error('drafts line ' + (index + 1) + ' is not JSON');
    }
    if (typeof item?.id !== 'string' || typeof item?.text !== 'string' || item.text.trim() === '') {
      throw new Error('drafts line ' + (index + 1) + ' needs id and text');
    }
    drafts.push({ id: item.id, preset: typeof item.preset === 'string' ? item.preset : 'general', text: item.text });
  }
  if (drafts.length === 0) throw new Error('no drafts found');
  return drafts;
}

function authHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (process.env.PO_BENCH_COOKIE) headers.cookie = process.env.PO_BENCH_COOKIE;
  else if (process.env.PO_BENCH_API_KEY) headers.authorization = 'Bearer ' + process.env.PO_BENCH_API_KEY;
  else throw new Error('Level 2 needs PO_BENCH_COOKIE or PO_BENCH_API_KEY');
  return headers;
}

async function readJson(response, what) {
  const body = await response.text();
  if (!response.ok) throw new Error(what + ' failed: HTTP ' + response.status + ' ' + body.slice(0, 200));
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(what + ' returned non-JSON: ' + body.slice(0, 200));
  }
}

async function postJson(url, payload, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return await readJson(response, options.what);
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(5, number));
}

function sanitizeJudge(parsed) {
  if (parsed === null || typeof parsed !== 'object') return null;
  const side = {};
  for (const key of ['a', 'b']) {
    if (parsed[key] === null || typeof parsed[key] !== 'object') return null;
    const scores = {};
    for (const dimension of DIMENSIONS) {
      const score = clampScore(parsed[key][dimension]);
      if (score === null) return null;
      scores[dimension] = score;
    }
    side[key] = scores;
  }
  return { a: side.a, b: side.b, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function rewriteDraft(draft, base, headers) {
  const payload = await postJson(base + ROUTE, { text: draft.text, preset: draft.preset }, {
    timeoutMs: REWRITE_TIMEOUT_MS,
    headers,
    what: 'rewrite ' + draft.id,
  });
  return typeof payload?.text === 'string' ? payload.text : '';
}

async function judge(base, headers, draft, left, right) {
  const url = process.env.PO_BENCH_JUDGE_URL || base + '/chat/completions';
  const model = process.env.PO_BENCH_MODEL || 'chat';
  const body = {
    model,
    temperature: 0,
    messages: [
      { role: 'system', content: RUBRIC },
      {
        role: 'user',
        content: ['User draft:', draft.text, '--- candidate prompts below ---', 'Prompt A:', left, '', 'Prompt B:', right]
          .join(NL),
      },
    ],
  };
  const payload = await postJson(url, body, { timeoutMs: JUDGE_TIMEOUT_MS, headers, what: 'judge ' + draft.id });
  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw new Error('judge ' + draft.id + ' returned no content');
  return sanitizeJudge(extractJson(raw));
}

function levelOne(drafts, options) {
  const rows = drafts.map((draft) => ({ id: draft.id, ...checkContract(draft.text) }));
  const errors = rows.reduce((sum, row) => sum + row.issues.filter((issue) => issue.severity === 'error').length, 0);
  const codes = {};
  for (const row of rows) for (const issue of row.issues) codes[issue.code] = (codes[issue.code] || 0) + 1;
  const report = {
    mode: 'check',
    drafts: rows.length,
    meanScore: Number(mean(rows.map((row) => row.score)).toFixed(1)),
    clean: rows.filter((row) => row.ok).length,
    errors,
    codes,
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log('Level 1 - static contract check of ' + report.drafts + ' drafts');
  console.log('  mean score ' + report.meanScore + ' / 100, clean ' + report.clean + ' / ' + report.drafts + ', errors ' + report.errors);
  const gaps = Object.entries(codes).map(([code, count]) => code + ' x' + count).join(', ') || 'none';
  console.log('  gaps: ' + gaps);
  for (const row of rows) {
    const found = row.issues.map((issue) => issue.code).join(',') || '-';
    console.log('  ' + row.id.padEnd(12) + ' ' + String(row.score).padStart(3) + '  ' + found);
  }
  return report;
}

async function levelTwo(drafts, options) {
  const base = (process.env.PO_BENCH_BASE_URL || '').replace(/\/+$/, '');
  if (base === '') throw new Error('Level 2 needs PO_BENCH_BASE_URL');
  const headers = authHeaders();
  const results = [];
  for (const [index, draft] of drafts.entries()) {
    process.stderr.write('[' + (index + 1) + '/' + drafts.length + '] ' + draft.id + ' ... ');
    const optimized = await rewriteDraft(draft, base, headers);
    const flipped = index % 2 === 1;
    const left = flipped ? optimized : draft.text;
    const right = flipped ? draft.text : optimized;
    const verdict = await judge(base, headers, draft, left, right);
    if (verdict === null) {
      process.stderr.write('judge output unusable' + NL);
      results.push({ id: draft.id, originalScore: null, optimizedScore: null, delta: null, score: checkContract(optimized).score });
      continue;
    }
    const originalSide = flipped ? verdict.b : verdict.a;
    const optimizedSide = flipped ? verdict.a : verdict.b;
    const originalScore = mean(DIMENSIONS.map((dimension) => originalSide[dimension]));
    const optimizedScore = mean(DIMENSIONS.map((dimension) => optimizedSide[dimension]));
    process.stderr.write(originalScore.toFixed(1) + ' -> ' + optimizedScore.toFixed(1) + NL);
    results.push({
      id: draft.id,
      originalScore,
      optimizedScore,
      delta: optimizedScore - originalScore,
      reason: verdict.reason,
      score: checkContract(optimized).score,
    });
  }
  const judged = results.filter((row) => row.delta !== null);
  const wins = judged.filter((row) => row.delta > 0).length;
  const ties = judged.filter((row) => row.delta === 0).length;
  const report = {
    mode: 'judge',
    drafts: results.length,
    judged: judged.length,
    wins,
    ties,
    losses: judged.length - wins - ties,
    winRate: judged.length === 0 ? 0 : Number((wins / judged.length).toFixed(3)),
    meanOriginal: Number(mean(judged.map((row) => row.originalScore)).toFixed(2)),
    meanOptimized: Number(mean(judged.map((row) => row.optimizedScore)).toFixed(2)),
    meanContract: Number(mean(results.map((row) => row.score)).toFixed(1)),
  };
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  console.log('Level 2 - blind judge over ' + report.judged + ' drafts');
  console.log('  wins ' + report.wins + ', ties ' + report.ties + ', losses ' + report.losses + '  win rate ' + Math.round(report.winRate * 100) + '%');
  console.log('  mean score original ' + report.meanOriginal + ' -> optimized ' + report.meanOptimized + ' (0-5), contract ' + report.meanContract + '/100');
  for (const row of results) {
    const before = row.originalScore === null ? '-' : row.originalScore.toFixed(2);
    const after = row.optimizedScore === null ? '-' : row.optimizedScore.toFixed(2);
    console.log('  ' + row.id.padEnd(12) + ' ' + before.padStart(5) + ' -> ' + after.padStart(5) + '  contract ' + String(row.score).padStart(3));
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const drafts = await loadDrafts(options.drafts);
  const selected = options.limit === null ? drafts : drafts.slice(0, options.limit);
  const needsJudge = !options.check && Boolean(process.env.PO_BENCH_BASE_URL);
  if (!needsJudge) {
    if (!options.check) console.error('PO_BENCH_BASE_URL is unset: running the offline check only.' + NL);
    levelOne(selected, options);
    return;
  }
  const report = await levelTwo(selected, options);
  if (report.judged === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('bench failed: ' + error.message);
  process.exitCode = 1;
});

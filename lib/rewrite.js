/**
 * Prompt Optimizer — pure rewrite rules.
 *
 * Nothing in this file touches Cordis, HTTP or the network: every export is a
 * deterministic function so it can be unit-tested with `node --test`.
 */

import { randomUUID } from 'node:crypto';

import { modelGuidance, modelProfile } from './model-profile.js';

export const MAX_INPUT_CHARS = 24000;
/** Hard ceiling: above this the draft is refused instead of chunked. */
export const MAX_DRAFT_CHARS = 120000;
export const MAX_OUTPUT_TOKENS = 6000;
export const DEFAULT_TEMPERATURE = 0.2;
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;
export const TIMEOUT_MS = 120000;

/** `source.kind` stamped on the request message so traces stay attributable. */
export const SOURCE_KIND = 'dsh-prompt-optimizer';

export const SYSTEM_PROMPT = [
  'You are a senior prompt engineer. Rewrite the user message into ONE prompt that another AI agent can execute end to end without asking follow-up questions.',
  '',
  'Rules:',
  '1. Preserve the user intent, language, and every concrete detail (names, numbers, dates, paths, file names, constraints, examples). Never drop a requirement and never invent facts, files, tools, or requirements the user did not imply. A constraint the user stated stays in the user\'s own words, quoted, not paraphrased - and never quote words the user did not write: your own assumption stays an assumption, never an attributed requirement.',
  '2. Make the implicit explicit. Where the agent would otherwise have to guess, write an explicit assumption as a checkable clause ("assume the audience is developers; stop and ask if it is not"), never a placeholder such as [insert X].',
  '3. Acceptance must be decidable: name the artifact and the conditions someone can check. "High quality", "professional" or "engaging" are not acceptance criteria - say what a reader or a test can measure instead.',
  '4. Advice is not a prompt: drop empty directives ("think step by step", "be helpful") unless they change behaviour. Prefer short labelled sections; keep every sentence load-bearing.',
  '5. Order the prompt the way a careful agent works: goal; known and unknown; constraints; deliverable and acceptance; method (plan first when the task is open-ended); verification (the self-checks the answer must pass); boundaries and stop conditions (missing data, out of scope, irreversible actions). Sections are a checklist, not boilerplate: keep one only if it carries information, and collapse a draft that is already fully specified into a tighter version of itself instead of restating it under seven headings.',
  '6. Say what to do when something is missing or ambiguous: ask one focused question, or state the assumption inline and continue. Silence is not an option.',
  '7. When the work is executable, make verification mechanical: name the command, test or file that proves completion, and say what to report when it fails.',
  '8. Reply in the same language as the user message.',
  '',
  'Return only the rewritten prompt as Markdown. No preamble, no explanation, no code fences around the whole answer.',
].join('\n');

/**
 * @param {unknown} value
 * @returns {{ ok: true, text: string } | { ok: false, status: number, error: string }}
 */
export function sanitizeDraft(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return { ok: false, status: 400, error: 'The draft is empty.' };
  if (text.length > MAX_DRAFT_CHARS) {
    return {
      ok: false,
      status: 413,
      error: 'The draft is longer than ' + MAX_DRAFT_CHARS + ' characters. Split it into parts and optimize each part.',
    };
  }
  return { ok: true, text };
}

/**
 * A long draft is cut into parts before it reaches the model. The parts are
 * joined back in order, so nothing is dropped, and each part stays inside the
 * per-call budget. Cuts prefer a blank line, then a line break, then a hard
 * wrap that never splits a surrogate pair.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function splitDraft(text, limit = MAX_INPUT_CHARS) {
  const value = typeof text === 'string' ? text : '';
  const budget = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_INPUT_CHARS;
  if (value.length <= budget) return value === '' ? [] : [value];

  const segments = [];
  let current = '';
  const flush = () => {
    if (current !== '') segments.push(current);
    current = '';
  };

  for (const block of value.split(/(?<=\n[ \t]*\n)/u)) {
    if (block.length <= budget - current.length) {
      current += block;
      continue;
    }
    flush();
    if (block.length <= budget) {
      current = block;
      continue;
    }
    for (const line of block.split(/(?<=\n)/u)) {
      if (line.length > budget) {
        flush();
        for (const piece of hardWrap(line, budget)) segments.push(piece);
        continue;
      }
      if (current.length + line.length > budget) flush();
      current += line;
    }
  }
  flush();
  return segments.filter((segment) => segment !== '');
}

/** Cut one over-long line without splitting a surrogate pair. */
function hardWrap(line, budget) {
  const pieces = [];
  let index = 0;
  while (index < line.length) {
    let end = Math.min(line.length, index + budget);
    const code = line.charCodeAt(end - 1);
    if (end < line.length && code >= 0xd800 && code <= 0xdbff) end += 1;
    pieces.push(line.slice(index, end));
    index = end;
  }
  return pieces;
}

/**
 * Parts of one long draft are rewritten independently, so the model has to
 * know that it is looking at a part and must not add framing of its own.
 *
 * @param {string} system
 * @param {number} index
 * @param {number} total
 * @returns {string}
 */
export function segmentSystemPrompt(system, index, total) {
  const base = typeof system === 'string' ? system : '';
  if (!Number.isFinite(total) || total <= 1) return base;
  return base + '\n\nThis is part ' + (index + 1) + ' of ' + total
    + ' of one longer draft. Rewrite only this part: keep its own sections and details in place,'
    + ' do not add an introduction or a conclusion, and do not merge content across parts.';
}

/** Remove one code fence that wraps the entire model answer. */
export function unwrapFence(text) {
  const value = typeof text === 'string' ? text : '';
  const match = /^\s*```[A-Za-z0-9_-]*[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\s*```\s*$/u.exec(value);
  return match === null ? value : match[1];
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, text: string } | { ok: false, status: number, error: string }}
 */
export function normalizeOutput(raw) {
  const text = unwrapFence(typeof raw === 'string' ? raw : '').trim();
  if (text === '') return { ok: false, status: 502, error: 'The model returned no text for this draft.' };
  return { ok: true, text };
}

/** Clamp a client-supplied temperature into the accepted band. */
export function clampTemperature(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TEMPERATURE;
  const clamped = Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, parsed));
  return Math.round(clamped * 100) / 100;
}

/**
 * Validate the optional `{ provider, model }` override.
 * @returns {{ ok: true, target: { provider: string, model: string } | undefined }
 *   | { ok: false, status: number, error: string }}
 */
export function parseTarget(payload) {
  if (payload === undefined || payload === null || typeof payload !== 'object') return { ok: true, target: undefined };
  const rawProvider = payload.provider;
  const rawModel = payload.model;
  if (rawProvider === undefined && rawModel === undefined) return { ok: true, target: undefined };
  if (typeof rawProvider !== 'string' || typeof rawModel !== 'string') {
    return { ok: false, status: 400, error: 'provider and model must both be strings when given.' };
  }
  const provider = rawProvider.trim();
  const model = rawModel.trim();
  if (provider === '' && model === '') return { ok: true, target: undefined };
  if (provider === '' || model === '') {
    return { ok: false, status: 400, error: 'provider and model must both be given, or neither.' };
  }
  if (provider.length > 120 || model.length > 200) {
    return { ok: false, status: 400, error: 'provider or model name is too long.' };
  }
  return { ok: true, target: { provider, model } };
}

/** Rewrite presets. `addendum` is appended to SYSTEM_PROMPT, so it can only add focus. */
export const PRESETS = [
  { id: 'general', label: 'General', addendum: '' },
  {
    id: 'writing',
    label: 'Writing',
    addendum:
      'The draft is about writing prose (reports, articles, posts, scripts). Optimise for audience, tone, structure and an explicit length target.',
  },
  {
    id: 'coding',
    label: 'Coding',
    addendum:
      'The draft is about code. Optimise for a precise specification: language and version, runtime, inputs and outputs, error handling, tests, files to change, and what must not change.',
  },
  {
    id: 'analysis',
    label: 'Analysis',
    addendum:
      'The draft asks for analysis or research. Optimise for the question, the decision it supports, the evidence required, and the shape of the deliverable.',
  },
  {
    id: 'agent',
    label: 'Agent task',
    addendum:
      'The draft is a task for an autonomous agent. Optimise for a goal, allowed tools, stop conditions, verification steps and the report format.',
  },
];

export const PRESET_IDS = PRESETS.map((preset) => preset.id);

export const MIN_CANDIDATES = 1;
export const MAX_CANDIDATES = 3;
export const MIN_OUTPUT_TOKENS = 200;
export const MAX_OUTPUT_TOKENS_LIMIT = 12000;

/** Built-in defaults; a settings file only ever overrides single fields. */
export const DEFAULT_SETTINGS = Object.freeze({
  temperature: DEFAULT_TEMPERATURE,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  preset: 'general',
  candidates: 1,
});

/**
 * The system prompt for one preset, adapted to the model that will run it.
 *
 * With no model given the prompt is exactly SYSTEM_PROMPT (+ preset context),
 * which keeps the plugin working on an install that never resolved a model.
 *
 * @param {string} [presetId]
 * @param {{ model?: string, provider?: string }} [options]
 */
export function buildSystemPrompt(presetId, options = {}) {
  const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[0];
  const base = preset.addendum === '' ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\nContext: ${preset.addendum}`;
  const model = typeof options?.model === 'string' ? options.model.trim() : '';
  if (model === '') return base;
  const guidance = modelGuidance(modelProfile(model, options?.provider));
  return guidance === '' ? base : `${base}\n\n${guidance}`;
}

/**
 * Coerce arbitrary JSON into a complete, in-range settings object.
 * Unknown keys are dropped; out-of-range numbers are clamped; wrong types are
 * reported so the settings route can answer 400 instead of silently ignoring.
 *
 * @returns {{ settings: typeof DEFAULT_SETTINGS, rejected: string[] }}
 */
export function normalizeSettings(value) {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rejected = [];
  const settings = { ...DEFAULT_SETTINGS };

  /** `null` / booleans are not numbers, even though Number() coerces them. */
  function numeric(key) {
    const raw = input[key];
    if (raw === undefined) return undefined;
    if (raw === null || typeof raw === 'boolean') {
      rejected.push(key);
      return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      rejected.push(key);
      return undefined;
    }
    return parsed;
  }

  const temperature = numeric('temperature');
  if (temperature !== undefined) settings.temperature = clampTemperature(temperature);

  const maxOutputTokens = numeric('maxOutputTokens');
  if (maxOutputTokens !== undefined) {
    settings.maxOutputTokens = Math.min(MAX_OUTPUT_TOKENS_LIMIT, Math.max(MIN_OUTPUT_TOKENS, Math.round(maxOutputTokens)));
  }

  if (input.preset !== undefined) {
    if (typeof input.preset === 'string' && PRESET_IDS.includes(input.preset)) settings.preset = input.preset;
    else rejected.push('preset');
  }

  const candidates = numeric('candidates');
  if (candidates !== undefined) {
    settings.candidates = Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, Math.round(candidates)));
  }

  return { settings, rejected };
}

/** Slightly different temperatures per candidate so parallel runs differ. */
export function spreadTemperature(base, index, total) {
  if (total <= 1) return clampTemperature(base);
  const step = 0.12;
  return clampTemperature(Math.min(MAX_TEMPERATURE, base + step * index));
}

/**
 * Deterministic quality proxy for picking the best of several candidates:
 * rewards labelled structure and a body of reasonable length, punishes
 * leaking meta commentary or placeholders.
 */
export function scoreCandidate(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value === '') return 0;
  let score = 0;
  score += Math.min((value.match(/^#{1,6}\s+\S/gmu) ?? []).length, 6) * 3;
  score += Math.min((value.match(/^\s*(?:[-*+]|\d+[.)])\s+\S/gmu) ?? []).length, 12);
  score += Math.min((value.match(/^\s*[^:\n]{1,24}:\s*\S/gmu) ?? []).length, 8);
  if (value.length >= 120) score += 4;
  if (value.length >= 400) score += 2;
  if (/[。.!?？]\s*$/u.test(value)) score += 1;
  if (/(?:```|\[insert|\[填|TODO|占位)/iu.test(value)) score -= 6;
  if (/(?:here is|below is|as an ai|这是我为你)/iu.test(value)) score -= 4;
  return score;
}

/** Pick the highest-scoring candidate; ties go to the earliest one. */
export function pickBestCandidate(texts) {
  const list = Array.isArray(texts) ? texts : [];
  const scores = list.map((text) => scoreCandidate(text));
  let best = 0;
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index] > scores[best]) best = index;
  }
  return { index: best, text: list[best] ?? '', scores };
}

/**
 * Build the request messages for one rewrite.
 *
 * `context` is optional read-only material the harness already knows (the
 * selected model, workspace facts, attachment names). It is fenced and labelled
 * so the model treats it as data: the rewrite may use it, never extend it.
 */
export function buildMessages(text, context) {
  const value = typeof text === 'string' ? text : '';
  const extra = typeof context === 'string' && context.trim() !== ''
    ? `Read-only context supplied by the harness (use it, never invent beyond it):\n"""\n${context.trim()}\n"""\n\n`
    : '';
  return [
    {
      id: randomUUID(),
      role: 'user',
      source: { kind: SOURCE_KIND },
      content: [{ type: 'text', text: extra + value }],
    },
  ];
}

/** Upper bound on tracked anchors, so a long draft stays cheap to check. */
export const MAX_ANCHORS = 24;

/**
 * Hard anchors: the parts of a draft that a rewrite must not silently drop.
 * Mechanical on purpose — numbers, dates, paths, links, quoted text and
 * negations are exactly the details a rewrite loses and a reader can check.
 * Specific rules run first and claim their span, so a date does not also
 * report its bare year and a path does not also report its file name.
 */
const ANCHOR_RULES = [
  { kind: 'url', pattern: /https?:\/\/[^\s\uFF0C\u3002\uFF1B\u3001\uFF09)\u3011\u300B>]+/gu },
  { kind: 'quote', pattern: /\u300C[^\u300D\n]{1,80}\u300D|\u201C[^\u201D\n]{1,80}\u201D|"[^"\n]{1,80}"/gu, inner: true },
  { kind: 'path', pattern: /[A-Za-z]:\\[^\s\uFF0C\u3002\uFF1B\u3001\uFF09)\u3011\u300B]+|\/[\w.@-]+\/[\w./@-]+|\b[\w-]+\.(?:py|js|jsx|ts|tsx|json|md|txt|csv|xlsx|docx?|pdf|png|jpe?g|svg|mp4|ya?ml|toml|ini|sh|ps1|html?|css)\b/gu },
  { kind: 'date', pattern: /\d{4}\s*\u5E74(?:\s*\d{1,2}\s*\u6708)?(?:\s*\d{1,2}\s*[\u65E5\u53F7])?|\d{1,2}\s*\u6708\s*\d{1,2}\s*[\u65E5\u53F7]|\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?|(\u4ECA\u5929|\u660E\u5929|\u540E\u5929|\u672C\u5468|\u8FD9\u5468|\u4E0B\u5468|\u4E0A\u5468|\u6708\u5E95|\u6708\u521D|\u5E74\u5E95)/gu },
  { kind: 'number', pattern: /(?<![\w.])[-+]?\d+(?:[.,]\d+)?\s*(?:%|\u2030|\u4E07|\u4EBF|ms|s|\u5206\u949F|\u5C0F\u65F6|\u5929|\u5468|\u4E2A\u6708|\u5E74|\u5143)?(?![\w.])/gu },
  { kind: 'negation', pattern: /(\u4E0D\u8981\u518D|\u4E0D\u8981|\u4E0D\u5F97|\u4E0D\u80FD|\u7981\u6B62|\u4E25\u7981|\u5207\u52FF|never|must not|do not|don't|without)/giu },
];

/** Any negation framing counts as "the constraint survived". */
const NEGATION_ANY = /(\u4E0D\u8981|\u4E0D\u5F97|\u4E0D\u80FD|\u7981\u6B62|\u4E25\u7981|\u5207\u52FF|\u907F\u514D|\u522B|never|must not|do not|don't|avoid|without)/iu;

function squash(value) {
  return String(value).replace(/[\s\u3000]+/gu, '').toLowerCase();
}

/**
 * Every hard anchor in a draft, most specific first, without overlapping spans.
 * @returns {{ kind: string, value: string }[]}
 */
export function extractAnchors(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.trim() === '') return [];
  const claimed = [];
  const seen = new Set();
  const anchors = [];
  for (const rule of ANCHOR_RULES) {
    for (const match of value.matchAll(rule.pattern)) {
      const raw = match[0];
      const start = match.index ?? 0;
      const end = start + raw.length;
      if (claimed.some(([from, to]) => start < to && end > from)) continue;
      const token = (rule.inner === true ? raw.slice(1, -1) : raw).trim();
      const key = squash(token);
      if (key === '' || seen.has(key)) continue;
      claimed.push([start, end]);
      seen.add(key);
      anchors.push({ kind: rule.kind, value: token });
      if (anchors.length >= MAX_ANCHORS) return anchors;
    }
  }
  return anchors;
}

/**
 * Which anchors survived a rewrite.
 * @param {{ kind?: string, value?: string }[] | string[]} anchors
 * @param {unknown} output
 * @returns {{ total: number, kept: number, missing: string[] }}
 */
export function verifyAnchors(anchors, output) {
  const list = Array.isArray(anchors) ? anchors : [];
  const haystack = squash(typeof output === 'string' ? output : '');
  const missing = [];
  let kept = 0;
  for (const anchor of list) {
    const entry = typeof anchor === 'string' ? { kind: '', value: anchor } : anchor ?? {};
    const token = typeof entry.value === 'string' ? entry.value.trim() : '';
    if (token === '') continue;
    const survived = entry.kind === 'negation'
      ? haystack.includes(squash(token)) || NEGATION_ANY.test(haystack)
      : haystack.includes(squash(token));
    if (survived) kept += 1;
    else missing.push(token);
  }
  return { total: kept + missing.length, kept, missing };
}

/** The ledger shape the routes and the card agree on. */
export function toLedger(verdict, repaired, added) {
  const list = Array.isArray(added) ? added : [];
  const entries = [];
  for (const entry of list) {
    const value = typeof entry?.value === 'string' ? entry.value : '';
    if (value === '') continue;
    entries.push({
      kind: typeof entry.kind === 'string' ? entry.kind : '',
      value,
      risk: entry.risk === 'high' ? 'high' : 'low',
    });
  }
  return {
    anchors: verdict.total,
    kept: verdict.kept,
    missing: verdict.missing,
    repaired: repaired === true,
    added: entries,
  };
}

/** One number for "is this rewrite better", so the repair pass can be refused. */
export function ledgerScore(ledger) {
  const added = Array.isArray(ledger?.added) ? ledger.added : [];
  const high = added.filter((entry) => entry?.risk === 'high').length;
  const low = added.length - high;
  return (Number(ledger?.kept) || 0) * 2 - high * 3 - low;
}

/** Markdown list and heading numbering is structure, not a claimed fact. */
const STRUCTURE_NUMBER = /^[ \t]{0,3}(?:#{1,6}[ \t]+\d{1,2}[.)\u3001]?[ \t]+|\d{1,2}[.)\u3001][ \t]+)/gmu;

/**
 * The mirror of verifyAnchors: facts the rewrite states that the draft never did.
 * Paths, links, dates and quotes are high risk, because an invented one looks like a real
 * specific and a reader will trust it. A quote is a claim about the user's own words: a
 * rewrite may quote what the user said, never a requirement the user did not state.
 * Numbers and negations are low risk: a rewrite legitimately adds numbering, framing
 * and negative constraints.
 * @returns {{ high: { kind: string, value: string, risk: string }[], low: { kind: string, value: string, risk: string }[] }}
 */
export function verifyAdded(draft, output) {
  const source = squash(typeof draft === 'string' ? draft : '');
  const target = typeof output === 'string' ? output : '';
  const high = [];
  const low = [];
  for (const anchor of extractAnchors(target.replace(STRUCTURE_NUMBER, ' '))) {
    const key = squash(anchor.value);
    if (key === '' || source.includes(key)) continue;
    const risky =
      anchor.kind === 'path' || anchor.kind === 'url' || anchor.kind === 'date' || anchor.kind === 'quote';
    (risky ? high : low).push({ kind: anchor.kind, value: anchor.value, risk: risky ? 'high' : 'low' });
  }
  return { high, low };
}

/** Anchors plus verdict in one call, for callers that hold only draft + output. */
export function buildLedger(draft, output) {
  const anchors = extractAnchors(draft);
  const verdict = verifyAnchors(anchors, output);
  return toLedger(verdict, false, verifyAdded(draft, output).high.concat(verifyAdded(draft, output).low));
}

/**
 * The single repair request: the draft, what the model already wrote, and the
 * exact items it dropped. Built by hand so the text is inspectable in tests.
 */
export function buildRepairMessages({ draft, previous, missing, added }) {
  const missingList = (Array.isArray(missing) ? missing : []).map((item) => '- ' + item).join('\n');
  const addedList = (Array.isArray(added) ? added : []).map((item) => '- ' + item).join('\n');
  const lines = [];
  lines.push(missingList === ''
    ? 'Your rewrite states material that the original draft does not contain.'
    : 'Your rewrite dropped material from the original draft. Restore it.');
  if (addedList !== '') {
    lines.push('', 'Invented material that is not in the original draft:', addedList, '',
      'Remove every invented item, or replace it with an explicit assumption.');
  }
  lines.push(
    '',
    'Original draft:',
    '\"\"\"',
    typeof draft === 'string' ? draft : '',
    '\"\"\"',
    '',
    'Your rewrite:',
    '\"\"\"',
    typeof previous === 'string' ? previous : '',
    '\"\"\"',
  );
  if (missingList !== '') lines.push('', 'Missing from your rewrite:', missingList);
  lines.push(
    '',
    'Return the corrected prompt only. Put every missing item back verbatim, add nothing the draft does not support, keep everything that was already right, and change nothing else.',
  );
  const text = lines.join('\n');
  return [
    {
      id: randomUUID(),
      role: 'user',
      source: { kind: SOURCE_KIND },
      content: [{ type: 'text', text }],
    },
  ];
}
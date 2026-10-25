/**
 * Prompt Optimizer — pure rewrite rules.
 *
 * Nothing in this file touches Cordis, HTTP or the network: every export is a
 * deterministic function so it can be unit-tested with `node --test`.
 */

import { randomUUID } from 'node:crypto';

export const MAX_INPUT_CHARS = 24000;
export const MAX_OUTPUT_TOKENS = 1600;
export const DEFAULT_TEMPERATURE = 0.2;
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 1;
export const TIMEOUT_MS = 120000;

/** `source.kind` stamped on the request message so traces stay attributable. */
export const SOURCE_KIND = 'dsh-prompt-optimizer';

export const SYSTEM_PROMPT = [
  'You are a senior prompt engineer. Rewrite the user message into a single, high-quality prompt for an AI agent.',
  '',
  'Rules:',
  '1. Preserve the user intent, language, and every concrete detail (names, numbers, dates, paths, file names, constraints, examples). Never drop a requirement and never invent facts, files, tools, or requirements the user did not imply.',
  '2. Make the implicit explicit by adding only structure that actually helps: role/goal, context, the concrete task, inputs or references, output format, constraints and boundaries, and how success is judged.',
  '3. Keep it usable as-is: no meta commentary, no "here is your prompt", no instructions addressed to the user, and no placeholders such as [insert X] unless the user has to fill one in.',
  '4. Prefer short labelled sections or a compact list over long prose. Keep every sentence load-bearing.',
  '5. If the draft is already fully specified, tighten the wording and keep all of its requirements instead of restating it with new sections.',
  '6. Reply in the same language as the user message.',
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
  if (text.length > MAX_INPUT_CHARS) {
    return { ok: false, status: 413, error: `The draft is longer than ${MAX_INPUT_CHARS} characters.` };
  }
  return { ok: true, text };
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
export const MAX_OUTPUT_TOKENS_LIMIT = 4000;

/** Built-in defaults; a settings file only ever overrides single fields. */
export const DEFAULT_SETTINGS = Object.freeze({
  temperature: DEFAULT_TEMPERATURE,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  preset: 'general',
  candidates: 1,
});

/** The system prompt for one preset. */
export function buildSystemPrompt(presetId) {
  const preset = PRESETS.find((item) => item.id === presetId) ?? PRESETS[0];
  return preset.addendum === '' ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\nContext: ${preset.addendum}`;
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

/** Build the request messages for one rewrite. */
export function buildMessages(text) {
  return [
    {
      id: randomUUID(),
      role: 'user',
      source: { kind: SOURCE_KIND },
      content: [{ type: 'text', text }],
    },
  ];
}

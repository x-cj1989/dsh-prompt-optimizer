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

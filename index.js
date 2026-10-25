/**
 * Prompt Optimizer — Host half.
 *
 * Registers one exact, authenticated `POST /api/prompt.optimize` route on the
 * Web connection bridge. The composer button calls it same-origin, so the
 * page's signed browser cookie authenticates the request and no token has to
 * reach the plugin.
 *
 * The rewrite runs on the profile's default model selection with one fixed
 * prompt-engineer system instruction. Nothing is persisted.
 */

import { randomUUID } from 'node:crypto';

const ROUTE_PATH = '/api/prompt.optimize';
const MAX_INPUT_CHARS = 24000;
const MAX_OUTPUT_TOKENS = 1600;
const TEMPERATURE = 0.2;
const TIMEOUT_MS = 120000;

const SYSTEM_PROMPT = [
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

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Remove one code fence that wraps the entire model answer. */
function unwrapFence(text) {
  const match = /^\s*```[A-Za-z0-9_-]*[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\s*```\s*$/u.exec(text);
  return match === null ? text : match[1];
}

/**
 * Rewrite one draft with the default model.
 * @returns `{ ok: true, text }` or `{ ok: false, status, error }`.
 */
async function rewrite(ctx, text) {
  const llm = ctx.get('llm');
  if (llm === undefined) return { ok: false, status: 503, error: 'The LLM service is unavailable.' };

  const defaultModel = ctx.get('agentDefaultModel');
  const selection = typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : undefined;
  if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    return { ok: false, status: 503, error: 'No default model is selected in this profile.' };
  }

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    let output = '';
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: SYSTEM_PROMPT,
      maxTokens: MAX_OUTPUT_TOKENS,
      // A rewrite is a convergence task: the same draft should come back the
      // same way on a second click.
      temperature: TEMPERATURE,
      messages: [{ id: randomUUID(), role: 'user', source: { kind: 'dsh-prompt-optimizer' }, content: [{ type: 'text', text }] }],
      signal,
    })) {
      if (chunk.type === 'text-delta') output += chunk.text;
      if (signal.aborted) break;
    }

    const optimized = unwrapFence(output).trim();
    if (optimized.length === 0) {
      return { ok: false, status: 502, error: 'The model returned no text for this draft.' };
    }
    return { ok: true, text: optimized, provider: selection.provider, model: selection.model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 502, error: `Prompt rewrite failed: ${message}` };
  }
}

async function handleOptimize(ctx, request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Request body must be JSON.' }, 400);
  }

  const text = (typeof payload?.text === 'string' ? payload.text : '').trim();
  if (text.length === 0) return jsonResponse({ error: 'The draft is empty.' }, 400);
  if (text.length > MAX_INPUT_CHARS) {
    return jsonResponse({ error: `The draft is longer than ${MAX_INPUT_CHARS} characters.` }, 413);
  }

  const result = await rewrite(ctx, text);
  return result.ok ? jsonResponse({ text: result.text, provider: result.provider, model: result.model }) : jsonResponse({ error: result.error }, result.status);
}

export function apply(ctx) {
  const connection = ctx.get('connection');
  if (connection !== undefined && typeof connection?.fetch?.register === 'function') {
    const dispose = connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleOptimize(ctx, request),
    });
    ctx.effect(() => () => {
      void dispose();
    }, 'prompt-optimizer: optimize route');
  } else {
    console.warn('[prompt-optimizer] connection.fetch is unavailable; the optimize route was not registered.');
  }
}

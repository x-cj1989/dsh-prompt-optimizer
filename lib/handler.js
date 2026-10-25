/**
 * Prompt Optimizer — HTTP transport.
 *
 * Wraps the pure rules in `./rewrite.js` into two same-origin routes:
 *
 *   POST /api/prompt.optimize          rewrite a draft (JSON or SSE)
 *   GET  /api/prompt.optimize/models   model list + current default (best effort)
 *
 * The caller injects `getServices()` so the whole module can be exercised with
 * fake LLM/default-model services in tests — no Cordis context required.
 */

import {
  DEFAULT_TEMPERATURE,
  MAX_INPUT_CHARS,
  MAX_OUTPUT_TOKENS,
  SYSTEM_PROMPT,
  TIMEOUT_MS,
  buildMessages,
  clampTemperature,
  normalizeOutput,
  parseTarget,
  sanitizeDraft,
} from './rewrite.js';

export const ROUTE = '/api/prompt.optimize';
export const MODELS_ROUTE = '/api/prompt.optimize/models';
export const MAX_MODELS = 200;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function errorResponse(status, error) {
  return jsonResponse({ error }, status);
}

function messageOf(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Path only, so the Host log never records a query string. */
function requestPath(request) {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '(unparsable url)';
  }
}

/** Merge the caller's abort signal with the hard timeout when the runtime supports it. */
function requestSignal(request) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (typeof AbortSignal.any !== 'function') return timeout;
  try {
    return AbortSignal.any([request.signal, timeout]);
  } catch {
    return timeout;
  }
}

/**
 * Which provider/model to use: explicit override, else the profile default.
 * @returns {{ provider: string, model: string } | undefined}
 */
function resolveSelection(services, target) {
  if (target !== undefined) return target;
  const defaultModel = services?.defaultModel;
  const selection = typeof defaultModel?.currentSelection === 'function' ? defaultModel.currentSelection() : undefined;
  if (selection === undefined || selection === null) return undefined;
  if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return undefined;
  if (selection.provider === '' || selection.model === '') return undefined;
  return { provider: selection.provider, model: selection.model };
}

/** One rewrite as an async iterable of text deltas. */
async function* streamRewrite({ llm, selection, text, temperature, signal }) {
  const chunks = llm.stream({
    provider: selection.provider,
    model: selection.model,
    system: SYSTEM_PROMPT,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature,
    messages: buildMessages(text),
    signal,
  });
  for await (const chunk of chunks) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') yield chunk.text;
    if (signal.aborted) return;
  }
}

/** Server-sent events: `meta` → `delta`* → `done` | `error`. */
function sseResponse({ run, selection }) {
  const encoder = new TextEncoder();
  const frame = (data) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
  const body = new ReadableStream({
    async start(controller) {
      let closed = false;
      const push = (data) => {
        if (closed) return;
        try {
          controller.enqueue(frame(data));
        } catch {
          closed = true;
        }
      };
      push({ type: 'meta', provider: selection.provider, model: selection.model });
      try {
        let raw = '';
        for await (const delta of run()) {
          raw += delta;
          push({ type: 'delta', text: delta });
        }
        const output = normalizeOutput(raw);
        if (output.ok) {
          push({ type: 'done', text: output.text, provider: selection.provider, model: selection.model });
        } else {
          push({ type: 'error', message: output.error, status: output.status });
        }
      } catch (cause) {
        push({ type: 'error', message: messageOf(cause) });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/** Normalise `string[]` / `{ id }[]` / `{ model }[]` from the LLM service. */
function idList(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : typeof item?.model === 'string' ? item.model : '';
    const trimmed = id.trim();
    if (trimmed !== '' && !ids.includes(trimmed)) ids.push(trimmed);
  }
  return ids;
}

/**
 * @param {object} options
 * @param {() => ({ llm?: unknown, defaultModel?: unknown })} options.getServices
 * @param {string} options.pluginVersion
 * @param {(message: string, cause?: unknown) => void} [options.log]
 */
export function createRoutes({ getServices, pluginVersion, log = () => {} }) {
  async function optimize(request) {
    log(`request ${request.method} ${requestPath(request)}`);
    if (request.method !== 'POST') return errorResponse(405, 'Use POST for this route.');

    let payload;
    try {
      payload = await request.json();
    } catch {
      return errorResponse(400, 'Request body must be JSON.');
    }

    const draft = sanitizeDraft(payload?.text);
    if (!draft.ok) return errorResponse(draft.status, draft.error);

    const target = parseTarget(payload);
    if (!target.ok) return errorResponse(target.status, target.error);

    const services = getServices() ?? {};
    const selection = resolveSelection(services, target.target);
    if (selection === undefined) return errorResponse(503, 'No default model is selected in this profile.');
    if (services.llm === undefined || services.llm === null) return errorResponse(503, 'The LLM service is unavailable.');
    if (typeof services.llm.stream !== 'function') return errorResponse(503, 'The LLM service cannot stream a completion.');

    const temperature = clampTemperature(payload?.temperature ?? DEFAULT_TEMPERATURE);
    const signal = requestSignal(request);
    const run = () => streamRewrite({ llm: services.llm, selection, text: draft.text, temperature, signal });

    if (payload?.stream === true) return sseResponse({ run, selection });

    try {
      let raw = '';
      for await (const delta of run()) raw += delta;
      const output = normalizeOutput(raw);
      if (!output.ok) return errorResponse(output.status, output.error);
      return jsonResponse({ text: output.text, provider: selection.provider, model: selection.model, pluginVersion });
    } catch (cause) {
      log('prompt rewrite failed', cause);
      return errorResponse(502, `Prompt rewrite failed: ${messageOf(cause)}`);
    }
  }

  async function models(request) {
    log(`request ${request.method} ${requestPath(request)}`);
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'Use GET for this route.');
    const services = getServices() ?? {};
    const catalogue = [];
    const llm = services.llm;
    if (llm !== undefined && llm !== null) {
      try {
        const providers = typeof llm.listProviders === 'function' ? await llm.listProviders() : [];
        for (const provider of idList(providers)) {
          if (catalogue.length >= MAX_MODELS) break;
          const models = typeof llm.listModels === 'function' ? await llm.listModels(provider) : [];
          for (const model of idList(models)) {
            if (catalogue.length >= MAX_MODELS) break;
            catalogue.push({ provider, model, label: `${provider} / ${model}` });
          }
        }
      } catch (cause) {
        log('model catalogue is unavailable', cause);
      }
    }
    return jsonResponse({
      models: catalogue,
      default: resolveSelection(services, undefined) ?? null,
      pluginVersion,
      maxInputChars: MAX_INPUT_CHARS,
    });
  }

  return { optimize, models };
}

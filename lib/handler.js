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
  DEFAULT_SETTINGS,
  DEFAULT_TEMPERATURE,
  MAX_CANDIDATES,
  MAX_DRAFT_CHARS,
  MAX_INPUT_CHARS,
  segmentSystemPrompt,
  splitDraft,
  MAX_OUTPUT_TOKENS_LIMIT,
  MIN_CANDIDATES,
  MIN_OUTPUT_TOKENS,
  PRESETS,
  TIMEOUT_MS,
  buildMessages,
  buildRepairMessages,
  buildSystemPrompt,
  clampTemperature,
  extractAnchors,
  normalizeOutput,
  parseTarget,
  pickBestCandidate,
  sanitizeDraft,
  ledgerScore,
  spreadTemperature,
  toLedger,
  verifyAdded,
  verifyAnchors,
} from './rewrite.js';

export const ROUTE = '/api/prompt.optimize';
export const MODELS_ROUTE = '/api/prompt.optimize/models';
export const SETTINGS_ROUTE = '/api/prompt.optimize/settings';
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

/** @returns {{ provider: string, model: string } | undefined} */
function normalizeSelection(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (provider === '' || model === '') return undefined;
  return { provider, model };
}

/** The profile's default selection, if that service is present and healthy. */
function readProfileSelection(services) {
  const defaultModel = services?.defaultModel;
  if (typeof defaultModel?.currentSelection !== 'function') return undefined;
  try {
    return normalizeSelection(defaultModel.currentSelection());
  } catch {
    return undefined;
  }
}

/**
 * Everything the configured LLM service offers, in provider/model order.
 * A broken provider listing must degrade to "unknown", never to a failed route.
 */
async function readCatalogue(llm) {
  const catalogue = [];
  if (llm === undefined || llm === null) return catalogue;
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
  } catch {
    /* listing is a convenience, not a requirement */
  }
  return catalogue;
}

/**
 * Which provider/model to use, in priority order:
 *   1. the request — the composer's own model selection, or the panel picker;
 *   2. the bundle config (`provider` / `model` in the patch row);
 *   3. the profile default selection;
 *   4. the first model the LLM service advertises.
 *
 * Step 4 is what makes a fresh install on someone else's machine work without
 * touching any setting: it never depends on this profile's local defaults.
 *
 * @returns {Promise<{ provider: string, model: string, source: string } | undefined>}
 */
async function resolveSelection({ services, target, config, llm, knownCatalogue }) {
  const fromRequest = normalizeSelection(target);
  if (fromRequest !== undefined) return { ...fromRequest, source: 'request' };

  const configured = normalizeSelection(config);
  if (configured !== undefined) return { ...configured, source: 'config' };

  const profile = readProfileSelection(services);
  if (profile !== undefined) return { ...profile, source: 'profile' };

  const catalogue = knownCatalogue ?? (await readCatalogue(llm));
  const first = catalogue[0];
  if (first !== undefined) return { provider: first.provider, model: first.model, source: 'catalogue' };

  return undefined;
}

/** One rewrite as an async iterable of text deltas. */
async function* streamRewrite({ llm, selection, text, temperature, maxTokens, system, signal, messages }) {
  const chunks = llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    maxTokens,
    temperature,
    messages: messages ?? buildMessages(text),
    signal,
  });
  for await (const chunk of chunks) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') yield chunk.text;
    if (signal.aborted) return;
  }
}

/** Run one rewrite to completion; an unusable answer comes back as ''. */
async function collectRewrite(options) {
  let raw = '';
  for await (const delta of streamRewrite(options)) raw += delta;
  const output = normalizeOutput(raw);
  return output.ok ? output.text : '';
}

/** Server-sent events: `meta` → `delta`* → `done` | `error`. */
function sseResponse({ run, selection, pluginVersion, preset, holder }) {
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
      push({
        type: 'meta',
        provider: selection.provider,
        model: selection.model,
        source: selection.source,
        pluginVersion,
        preset,
      });
      try {
        for await (const chunk of run()) {
          if (chunk !== null && typeof chunk === 'object' && chunk.reset === true) {
            push({ type: 'reset' });
            continue;
          }
          const delta = typeof chunk === 'string' ? chunk : '';
          if (delta === '') continue;
          push({ type: 'delta', text: delta });
        }
        const output = normalizeOutput(holder !== null && holder !== undefined ? holder.text : '');
        if (output.ok) {
          push({
            type: 'done',
            text: output.text,
            ledger: holder !== null && holder !== undefined ? holder.ledger ?? null : null,
            provider: selection.provider,
            model: selection.model,
            source: selection.source,
            preset,
          });
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
 * @param {object} [options.config]
 * @param {{ get: () => object, patch: (partial: object) => object, reset: () => object, file?: string }} [options.store]
 */
export function createRoutes({ getServices, pluginVersion, log = () => {}, config = {}, store }) {
  /** Bundle-level defaults; every field is optional and falls back to a constant. */
  const bundleConfig = config === null || typeof config !== 'object' ? {} : config;

  /** Persisted user settings, or the built-in defaults when no store exists. */
  function currentSettings() {
    if (store !== undefined && store !== null && typeof store.get === 'function') {
      try {
        const value = store.get();
        if (value !== null && typeof value === 'object') return value;
      } catch (cause) {
        log('could not read settings, using defaults', cause);
      }
    }
    return { ...DEFAULT_SETTINGS };
  }

  /** What the settings UI is allowed to offer. */
  function bounds() {
    return {
      temperature: { min: 0, max: 1, step: 0.05, default: DEFAULT_TEMPERATURE },
      maxOutputTokens: {
        min: MIN_OUTPUT_TOKENS,
        max: MAX_OUTPUT_TOKENS_LIMIT,
        step: 50,
        default: DEFAULT_SETTINGS.maxOutputTokens,
      },
      candidates: { min: MIN_CANDIDATES, max: MAX_CANDIDATES, step: 1, default: DEFAULT_SETTINGS.candidates },
    };
  }

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

    // Hard anchors are checked after the rewrite, so a dropped number, date,
    // path or negation is caught instead of silently shipped.
    const anchors = extractAnchors(draft.text);

    /** High-risk invented facts (paths, links, dates); low-risk ones only get reported. */
    function addedOfAgainst(source, value) {
      const found = verifyAdded(source, value);
      return found.high.concat(found.low);
    }
    const addedOf = (value) => addedOfAgainst(draft.text, value);

    // One assessment covers both directions: what was dropped and what was invented.
    const assess = (value) => toLedger(verifyAnchors(anchors, value), false, addedOf(value));

    // A long draft is rewritten part by part instead of being refused: the parts are
    // joined back in order, and the final ledger is still computed over the whole draft.
    const segments = splitDraft(draft.text, MAX_INPUT_CHARS);
    const chunked = segments.length > 1;
    const assessSegment = (index) => {
      const source = segments[index];
      const segmentAnchors = extractAnchors(source);
      return (value) => toLedger(verifyAnchors(segmentAnchors, value), false, addedOfAgainst(source, value));
    };

    const target = parseTarget(payload);
    if (!target.ok) return errorResponse(target.status, target.error);

    const services = getServices() ?? {};
    const llm = services.llm;
    const selection = await resolveSelection({ services, target: target.target, config: bundleConfig, llm });
    if (selection === undefined) {
      return errorResponse(503, 'No model is available: pick one in the composer, or set provider/model in the bundle config.');
    }
    if (llm === undefined || llm === null) return errorResponse(503, 'The LLM service is unavailable.');
    if (typeof llm.stream !== 'function') return errorResponse(503, 'The LLM service cannot stream a completion.');
    log(`model ${selection.provider} / ${selection.model} (${selection.source})`);

    const stored = currentSettings();
    const preset = typeof payload?.preset === 'string' && payload.preset !== '' ? payload.preset : stored.preset;
    const system = buildSystemPrompt(preset);
    const temperature = clampTemperature(payload?.temperature ?? bundleConfig.temperature ?? stored.temperature);
    const maxTokens = stored.maxOutputTokens;
    const asked = Number(payload?.candidates ?? stored.candidates);
    const candidates = Number.isFinite(asked)
      ? Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, Math.round(asked)))
      : 1;
    const signal = requestSignal(request);
    log(`preset ${preset}, candidates ${candidates}, temperature ${temperature}`);

    if (candidates > 1 && !chunked) {
      try {
        const texts = await Promise.all(
          Array.from({ length: candidates }, (_, index) =>
            collectRewrite({
              llm,
              selection,
              text: draft.text,
              system,
              maxTokens,
              temperature: spreadTemperature(temperature, index, candidates),
              signal,
            }),
          ),
        );
        const usable = texts.filter((text) => text.trim() !== '');
        if (usable.length === 0) return errorResponse(502, 'The model returned no text for this draft.');
        const best = pickBestCandidate(usable);
        let text = best.text;
        let ledger = assess(text);
        const invented = ledger.added.filter((entry) => entry.risk === 'high').map((entry) => entry.value);
        if (ledger.missing.length > 0 || invented.length > 0) {
          const repairedRaw = await collectRewrite({
            llm,
            selection,
            text: draft.text,
            system,
            maxTokens,
            temperature,
            signal,
            messages: buildRepairMessages({ draft: draft.text, previous: text, missing: ledger.missing, added: invented }),
          });
          const repaired = normalizeOutput(repairedRaw);
          if (repaired.ok) {
            const next = assess(repaired.text);
            if (ledgerScore(next) > ledgerScore(ledger)) {
              text = repaired.text;
              ledger = { ...next, repaired: true };
            }
          }
        }
        return jsonResponse({
          text,
          ledger,
          provider: selection.provider,
          model: selection.model,
          source: selection.source,
          pluginVersion,
          preset,
          candidates: usable.length,
          scores: best.scores,
        });
      } catch (cause) {
        log('prompt rewrite failed', cause);
        return errorResponse(502, `Prompt rewrite failed: ${messageOf(cause)}`);
      }
    }

    // The plain path and the SSE path share one generator: the first pass
    // streams as usual, and only a dropped anchor triggers the repair pass.
    const holder = { text: '', ledger: null };
    async function* rewriteOnce() {
      let raw = '';
      for await (const delta of streamRewrite({ llm, selection, text: draft.text, system, maxTokens, temperature, signal })) {
        raw += delta;
        yield delta;
      }
      const first = normalizeOutput(raw);
      if (!first.ok) throw Object.assign(new Error(first.error), { status: first.status });
      let text = first.text;
      let ledger = assess(text);
      const invented = ledger.added.filter((entry) => entry.risk === 'high').map((entry) => entry.value);
      if (ledger.missing.length > 0 || invented.length > 0) {
        const repairedRaw = await collectRewrite({
          llm,
          selection,
          text: draft.text,
          system,
          maxTokens,
          temperature,
          signal,
          messages: buildRepairMessages({ draft: draft.text, previous: text, missing: ledger.missing, added: invented }),
        });
        const repaired = normalizeOutput(repairedRaw);
        if (repaired.ok) {
          const next = assess(repaired.text);
          if (ledgerScore(next) > ledgerScore(ledger)) {
            text = repaired.text;
            ledger = { ...next, repaired: true };
            yield { reset: true };
            yield text;
          }
        }
      }
      holder.text = text;
      holder.ledger = ledger;
    }

    // Parts are buffered and emitted one at a time, so a repair inside a part never
    // has to reset text the client already shows.
    async function* rewriteChunked() {
      const parts = [];
      for (let index = 0; index < segments.length; index += 1) {
        const segmentAssess = assessSegment(index);
        const segmentSystem = segmentSystemPrompt(system, index, segments.length);
        const first = normalizeOutput(await collectRewrite({
          llm, selection, text: segments[index], system: segmentSystem, maxTokens, temperature, signal,
        }));
        if (!first.ok) throw Object.assign(new Error(first.error), { status: first.status });
        let text = first.text;
        let ledger = segmentAssess(text);
        const invented = ledger.added.filter((entry) => entry.risk === 'high').map((entry) => entry.value);
        if (ledger.missing.length > 0 || invented.length > 0) {
          const repaired = normalizeOutput(await collectRewrite({
            llm,
            selection,
            text: segments[index],
            system: segmentSystem,
            maxTokens,
            temperature,
            signal,
            messages: buildRepairMessages({ draft: segments[index], previous: text, missing: ledger.missing, added: invented }),
          }));
          if (repaired.ok) {
            const next = segmentAssess(repaired.text);
            if (ledgerScore(next) > ledgerScore(ledger)) {
              text = repaired.text;
              ledger = { ...next, repaired: true };
            }
          }
        }
        parts.push(text);
        if (index > 0) yield '\n\n';
        yield text;
      }
      const joined = parts.join('\n\n');
      holder.text = joined;
      holder.ledger = { ...assess(joined), chunks: segments.length };
    }

    async function* runRewrite() {
      if (chunked) {
        yield* rewriteChunked();
        return;
      }
      yield* rewriteOnce();
    }

    if (payload?.stream === true) return sseResponse({ run: () => runRewrite(), selection, pluginVersion, preset, holder });

    try {
      for await (const chunk of runRewrite()) void chunk;
      return jsonResponse({
        text: holder.text,
        ledger: holder.ledger,
        provider: selection.provider,
        model: selection.model,
        source: selection.source,
        pluginVersion,
        preset,
      });
    } catch (cause) {
      log('prompt rewrite failed', cause);
      return errorResponse(502, `Prompt rewrite failed: ${messageOf(cause)}`);
    }
  }

  async function models(request) {
    log(`request ${request.method} ${requestPath(request)}`);
    if (request.method !== 'GET' && request.method !== 'HEAD') return errorResponse(405, 'Use GET for this route.');
    const services = getServices() ?? {};
    const llm = services.llm;
    const catalogue = await readCatalogue(llm);
    const selection = await resolveSelection({ services, target: undefined, config: bundleConfig, llm, knownCatalogue: catalogue });
    return jsonResponse({
      models: catalogue,
      default: selection === undefined ? null : { provider: selection.provider, model: selection.model, source: selection.source },
      pluginVersion,
      maxInputChars: MAX_INPUT_CHARS,
      maxDraftChars: MAX_DRAFT_CHARS,
    });
  }

  /** GET → current settings + bounds + presets; POST → merge a patch (or reset). */
  async function settings(request) {
    log(`request ${request.method} ${requestPath(request)}`);
    if (request.method === 'GET' || request.method === 'HEAD') {
      return jsonResponse({
        settings: currentSettings(),
        bounds: bounds(),
        presets: PRESETS.map((preset) => ({ id: preset.id, label: preset.label })),
        defaults: { ...DEFAULT_SETTINGS },
        pluginVersion,
      });
    }
    if (request.method !== 'POST') return errorResponse(405, 'Use GET or POST for this route.');

    let payload;
    try {
      payload = await request.json();
    } catch {
      return errorResponse(400, 'Request body must be JSON.');
    }
    if (store === undefined || store === null || typeof store.patch !== 'function') {
      return errorResponse(503, 'Settings are not writable in this build.');
    }
    if (payload?.reset === true) {
      const reset = store.reset();
      if (!reset?.ok) return errorResponse(503, reset?.error ?? 'Could not reset the settings.');
      return jsonResponse({ settings: reset.settings, pluginVersion });
    }
    const result = store.patch(payload);
    if (!result?.ok) return errorResponse(400, result?.error ?? 'Could not save the settings.');
    return jsonResponse({ settings: result.settings, pluginVersion });
  }

  return { optimize, models, settings };
}
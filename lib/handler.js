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
import { checkContract } from './contract.js';
import { modelProfile, profileSummary } from './model-profile.js';

export const ROUTE = '/api/prompt.optimize';
export const MODELS_ROUTE = '/api/prompt.optimize/models';
export const SETTINGS_ROUTE = '/api/prompt.optimize/settings';
export const MAX_MODELS = 200;

/** A retry may exceed the settings cap: a thinking model can spend the whole budget reasoning. */
const RETRY_TOKEN_CAP = 24000;

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

/**
 * Merge the caller's abort signal with the hard timeout. Every piece is
 * optional: a runtime without `AbortSignal.timeout` or `.any` must still get a
 * usable signal instead of a TypeError the route cannot answer with.
 */
function requestSignal(request) {
  const signals = [];
  const caller = request?.signal ?? null;
  if (caller !== null) signals.push(caller);
  try {
    if (typeof AbortSignal.timeout === 'function') signals.push(AbortSignal.timeout(TIMEOUT_MS));
  } catch {
    /* no hard timeout on this runtime — the caller's signal still applies */
  }
  if (signals.length === 0) return new AbortController().signal;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === 'function') {
    try {
      return AbortSignal.any(signals);
    } catch {
      /* fall through to manual chaining */
    }
  }
  const controller = new AbortController();
  const abort = () => {
    try {
      controller.abort();
    } catch {
      /* already aborted */
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      break;
    }
    try {
      signal.addEventListener('abort', abort, { once: true });
    } catch {
      /* a signal without addEventListener — nothing left to chain */
    }
  }
  return controller.signal;
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

/**
 * Best-effort workspace grounding: the cwd of the live session the draft came
 * from, resolved through host services when they exist. Every lookup is
 * optional — a missing service, a closed session or an unknown id all degrade
 * to null and the rewrite proceeds with no context, exactly as before.
 */
function resolveGrounding(services, sessionId, title, log) {
  const cleanTitle = typeof title === 'string' ? title.replace(/[\r\n\u2028\u2029]/gu, ' ').trim().slice(0, 160) : '';
  let cwd = '';
  try {
    const agents = services?.agents;
    const workingDirectory = services?.workingDirectory;
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (id !== '' && typeof agents?.get === 'function' && typeof workingDirectory?.get === 'function') {
      const found = agents.get(id);
      const session = found?.session ?? found;
      if (session !== null && session !== undefined) {
        const value = workingDirectory.get(session);
        if (typeof value === 'string' && value !== '') cwd = value.trim().slice(0, 300);
      }
    }
  } catch (cause) {
    log('grounding lookup failed', cause);
  }
  if (cwd === '' && cleanTitle === '') return null;
  return { cwd, title: cleanTitle };
}

/** The fenced read-only block buildMessages prepends; '' when nothing was found. */
function groundingText(grounding) {
  if (grounding === null) return '';
  const lines = [];
  if (grounding.cwd !== '') lines.push('workspace: ' + grounding.cwd);
  if (grounding.title !== '') lines.push('session: ' + grounding.title);
  return lines.join('\n');
}

/** One rewrite as an async iterable of text deltas. */
async function* streamRewrite({ llm, selection, text, temperature, maxTokens, system, signal, messages, diagnostics, context }) {
  const chunks = llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    maxTokens,
    temperature,
    messages: messages ?? buildMessages(text, context),
    signal,
  });
  for await (const chunk of chunks) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') yield chunk.text;
    else if (diagnostics !== null && diagnostics !== undefined && typeof chunk?.type === 'string' && chunk.type.startsWith('reasoning')) diagnostics.reasoning += 1;
    if (signal.aborted) return;
  }
}

/** One completion plus the bit of evidence needed to explain an empty answer. */
async function collectOnce(options) {
  const diagnostics = { reasoning: 0 };
  let raw = '';
  for await (const delta of streamRewrite({ ...options, diagnostics })) raw += delta;
  const output = normalizeOutput(raw);
  return output.ok ? { ok: true, text: output.text } : { ok: false, reasoning: diagnostics.reasoning };
}

/** A retry gets more room than the settings cap allows; a thinking model can spend it all on reasoning. */
function retryTokens(maxTokens) {
  const base = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : MIN_OUTPUT_TOKENS;
  return Math.min(RETRY_TOKEN_CAP, Math.max(base, Math.round(base * 2)));
}

/** 502 with no body; when the model only reasoned, the message says so. */
function emptyAnswerError(reasoning) {
  const hint = reasoning > 0
    ? ' The model spent its output on reasoning and never wrote an answer: raise the output limit or use a model that does not think first.'
    : '';
  return Object.assign(new Error('The model returned no text for this draft.' + hint), { status: 502 });
}

/** Run one rewrite to completion, retrying once with more room; an unusable answer comes back as ''. */
async function collectRewrite(options) {
  const first = await collectOnce(options);
  if (first.ok) return first.text;
  const second = await collectOnce({ ...options, maxTokens: retryTokens(options.maxTokens) });
  return second.ok ? second.text : '';
}

/** Server-sent events: `meta` → `delta`* → `done` | `error`. */
function sseResponse({ run, selection, pluginVersion, preset, holder, profile, grounding }) {
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
            contract: checkContract(holder !== null && holder !== undefined ? holder.text : ''),
            profile: profileSummary(profile),
            grounding: grounding ?? null,
            provider: selection.provider,
            model: selection.model,
            source: selection.source,
            preset,
          });
        } else {
          push({ type: 'error', message: output.error, status: output.status });
        }
      } catch (cause) {
        // Keep the status the JSON path reports: `emptyAnswerError` marks a
        // 502, and the client turns a known status into a typed failure.
        push({
          type: 'error',
          message: messageOf(cause),
          status: typeof cause?.status === 'number' ? cause.status : undefined,
        });
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

    const grounding = resolveGrounding(services, payload?.sessionId, payload?.title, log);
    const context = groundingText(grounding);
    log(grounding === null ? 'grounding none' : 'grounding ' + JSON.stringify(grounding));

    const stored = currentSettings();
    const preset = typeof payload?.preset === 'string' && payload.preset !== '' ? payload.preset : stored.preset;
    const profile = modelProfile(selection.model, selection.provider);
    const system = buildSystemPrompt(preset, { model: selection.model, provider: selection.provider });
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
              context,
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
          contract: checkContract(text),
          profile: profileSummary(profile),
          grounding,
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
      let diagnostics = { reasoning: 0 };
      for await (const delta of streamRewrite({ llm, selection, text: draft.text, system, maxTokens, temperature, signal, diagnostics, context })) {
        raw += delta;
        yield delta;
      }
      let first = normalizeOutput(raw);
      if (!first.ok) {
        // Nothing was streamed, so one silent retry with more room costs the user no flicker.
        raw = '';
        diagnostics = { reasoning: 0 };
        for await (const delta of streamRewrite({ llm, selection, text: draft.text, system, maxTokens: retryTokens(maxTokens), temperature, signal, diagnostics, context })) {
          raw += delta;
          yield delta;
        }
        first = normalizeOutput(raw);
      }
      if (!first.ok) throw emptyAnswerError(diagnostics.reasoning);
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
          llm, selection, text: segments[index], system: segmentSystem, maxTokens, temperature, signal, context,
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

    if (payload?.stream === true) return sseResponse({ run: () => runRewrite(), selection, pluginVersion, preset, holder, profile, grounding });

    try {
      for await (const chunk of runRewrite()) void chunk;
      return jsonResponse({
        text: holder.text,
        ledger: holder.ledger,
        contract: checkContract(holder.text),
        profile: profileSummary(profile),
        grounding,
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
      profile: selection === undefined ? null : profileSummary(modelProfile(selection.model, selection.provider)),
      maxOutputTokensLimit: MAX_OUTPUT_TOKENS_LIMIT,
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
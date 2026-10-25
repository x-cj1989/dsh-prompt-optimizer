/**
 * Prompt Optimizer — Client half.
 *
 * Two registrations, one shared store:
 *
 *  - `conversation.input.right`  a compact ✨ control in the composer tool row
 *  - `conversation.composer.dock` a before/after preview card (renders nothing
 *    while idle, so the composer layout is untouched in normal use)
 *
 * Click → stream a rewrite from the Host route → preview → 采纳 / 放弃 / 重新优化.
 * Adopting writes ONE undoable edit (`captureInsertion` + `insertText`, falling
 * back to `setDraft`), so the composer's own Ctrl+Z works too.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-optimizer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'prompt-optimizer';
    const BUTTON_SLOT = 'conversation.input.right';
    const PREVIEW_SLOT = 'conversation.composer.dock';
    /** Relative on purpose: an absolute `/api/...` drops any mount sub-path. */
    const ROUTE = 'api/prompt.optimize';
    const MODELS_ROUTE = 'api/prompt.optimize/models';
    const STREAMING = true;
    const MAX_INPUT_CHARS = 24000;

    const STASH_PREFIX = 'dsh-prompt-optimizer:revert:';
    const STASH_LIMIT = 10;
    const HISTORY_KEY = 'dsh-prompt-optimizer:history';
    const HISTORY_LIMIT = 20;
    const TARGET_KEY = 'dsh-prompt-optimizer:target';
    const TEMPERATURE_KEY = 'dsh-prompt-optimizer:temperature';
    const DEFAULT_TEMPERATURE = 0.2;
    const REQUIRED_DSH = '0.2.0';

    const ZH = {
      'slot.label': '优化提示词',
      'action.idle': '优化提示词',
      'action.short': '优化',
      'action.busy': '优化中',
      'action.view': '查看优化',
      'action.retry': '重试',
      'tip.idle': '把当前输入改写为结构化的专业提示词，并先给你看对比',
      'tip.empty': '先在输入框写下你的需求，再点这里改写为专业提示词',
      'tip.busy': '正在改写… 点按钮可取消',
      'tip.view': '展开或收起优化对比',
      'tip.failed': '优化失败：{message}（点击重试）',
      'error.failed': '优化失败：{message}',
      'error.empty': '模型返回了空结果',
      'error.network': '请求失败：{message}',
      'error.authHint': '（页面会话已失效，请用带 token 的地址刷新页面）',
      'panel.title': '优化结果',
      'panel.source': '原文',
      'panel.result': '优化后',
      'panel.streaming': '生成中…',
      'panel.stats': '{from} → {to} 字',
      'panel.lines': '{added} 行新增 / {removed} 行删除',
      'panel.adopt': '采纳并写入',
      'panel.discard': '放弃',
      'panel.retry': '重新优化',
      'panel.close': '关闭',
      'panel.copy': '复制',
      'panel.copied': '已复制',
      'panel.adopted': '已写入输入框（Ctrl+Z 可撤销）',
      'panel.adoptedCopy': '当前环境无法写回输入框，已复制到剪贴板',
      'panel.undo': '撤销这次采纳',
      'panel.model': '模型',
      'panel.temperature': '温度',
      'panel.temperature.stable': '稳定 0.2',
      'panel.temperature.flex': '灵活 0.7',
      'panel.history': '历史',
      'panel.historyEmpty': '还没有优化历史',
      'panel.clear': '清空',
      'panel.load': '载入',
      'panel.compat': '本插件按 DSH ≥ {required} 开发，当前 {current}，部分控件可能不可用',
      'panel.waiting': '思考中…',
    };

    const EN = {
      'slot.label': 'Optimize prompt',
      'action.idle': 'Optimize prompt',
      'action.short': 'Optimize',
      'action.busy': 'Optimizing',
      'action.view': 'Show result',
      'action.retry': 'Retry',
      'tip.idle': 'Rewrite the current draft into a structured prompt, shown as a diff first',
      'tip.empty': 'Write what you need first, then click here to rewrite it as a prompt',
      'tip.busy': 'Rewriting… click the button to cancel',
      'tip.view': 'Expand or collapse the before/after comparison',
      'tip.failed': 'Optimization failed: {message} (click to retry)',
      'error.failed': 'Optimization failed: {message}',
      'error.empty': 'The model returned an empty result',
      'error.network': 'Request failed: {message}',
      'error.authHint': ' (the page session expired — reload the URL printed by dsh web)',
      'panel.title': 'Optimized prompt',
      'panel.source': 'Original',
      'panel.result': 'Optimized',
      'panel.streaming': 'streaming…',
      'panel.stats': '{from} → {to} chars',
      'panel.lines': '{added} added / {removed} removed lines',
      'panel.adopt': 'Adopt',
      'panel.discard': 'Discard',
      'panel.retry': 'Optimize again',
      'panel.close': 'Close',
      'panel.copy': 'Copy',
      'panel.copied': 'Copied',
      'panel.adopted': 'Written to the composer (Ctrl+Z to undo)',
      'panel.adoptedCopy': 'Could not write to the composer here — copied to the clipboard',
      'panel.undo': 'Undo this adoption',
      'panel.model': 'Model',
      'panel.temperature': 'Temperature',
      'panel.temperature.stable': 'steady 0.2',
      'panel.temperature.flex': 'loose 0.7',
      'panel.history': 'History',
      'panel.historyEmpty': 'No history yet',
      'panel.clear': 'Clear',
      'panel.load': 'Load',
      'panel.compat': 'Built for DSH >= {required}, running {current}; some controls may be unavailable',
      'panel.waiting': 'Thinking…',
    };

    const CSS = [
      '.dsh-po{display:inline-flex;align-items:center;min-width:0;gap:6px}',
      '.dsh-po-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.7;transition:opacity .12s ease,background .12s ease}',
      '.dsh-po-btn:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
      '.dsh-po-btn:disabled{cursor:default;opacity:.32}',
      '.dsh-po-btn.is-active{opacity:1;border-color:color-mix(in srgb,currentColor 32%,transparent)}',
      '.dsh-po-btn.is-busy .dsh-po-glyph{animation:dsh-po-spin 1.15s linear infinite}',
      '@keyframes dsh-po-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '.dsh-po-glyph{display:inline-block;flex:0 0 auto;font-family:"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",system-ui,sans-serif;font-size:13px;line-height:1;font-style:normal}',
      '.dsh-po-label{white-space:nowrap}',
      '.dsh-po-error{max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1;color:#e06767}',
      '.dsh-po-card{flex:1 1 100%;box-sizing:border-box;width:100%;max-width:100%;margin:6px 0 0;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:12px;background:color-mix(in srgb,currentColor 4%,transparent);font-size:12px;line-height:1.5;overflow:hidden}',
      '.dsh-po-head{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}',
      '.dsh-po-title{display:inline-flex;align-items:center;gap:5px;font-weight:600;white-space:nowrap}',
      '.dsh-po-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.62;font-size:11px}',
      '.dsh-po-spacer{flex:1 1 auto}',
      '.dsh-po-ghost{height:24px;padding:0 8px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:1;cursor:pointer;opacity:.75}',
      '.dsh-po-ghost:hover{opacity:1;background:color-mix(in srgb,currentColor 10%,transparent)}',
      '.dsh-po-body{max-height:min(42vh,320px);overflow:auto;padding:0 10px}',
      '.dsh-po-cols{display:grid;grid-template-columns:1fr 1fr;gap:0 10px;align-items:start}',
      '.dsh-po-colhead{position:sticky;top:0;z-index:1;padding:6px 0 4px;font-size:11px;font-weight:600;opacity:.66;background:color-mix(in srgb,currentColor 4%,transparent)}',
      '.dsh-po-line{white-space:pre-wrap;overflow-wrap:anywhere;padding:1px 4px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.45;opacity:.86}',
      '.dsh-po-line.is-changed{background:color-mix(in srgb,#e06767 16%,transparent)}',
      '.dsh-po-line.is-strong{background:color-mix(in srgb,#3fb47f 18%,transparent)}',
      '.dsh-po-line.is-empty{background:color-mix(in srgb,currentColor 5%,transparent)}',
      '.dsh-po-line.is-plain{white-space:pre-wrap;font-family:inherit;font-size:12px;opacity:.92}',
      '.dsh-po-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}',
      '.dsh-po-primary{height:26px;padding:0 12px;border:1px solid transparent;border-radius:999px;background:color-mix(in srgb,currentColor 88%,transparent);color:color-mix(in srgb,currentColor 8%,#fff);font:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer}',
      '.dsh-po-primary:disabled{opacity:.4;cursor:default}',
      '.dsh-po-select{height:24px;max-width:210px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:11px}',
      '.dsh-po-note{font-size:11px;opacity:.7}',
      '.dsh-po-note.is-warn{color:#c98a2a}',
      '.dsh-po-note.is-error{color:#e06767}',
      '.dsh-po-history{padding:4px 10px 9px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent)}',
      '.dsh-po-history-row{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:11px}',
      '.dsh-po-history-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.78}',
      '@media (max-width:640px){.dsh-po-cols{grid-template-columns:1fr}}',
    ].join('');

    // ---------------------------------------------------------------- forms

    function format(template, params) {
      let out = template;
      for (const [key, value] of Object.entries(params ?? {})) out = out.split(`{${key}}`).join(String(value));
      return out;
    }

    function splitLines(text) {
      return String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
    }

    /** Code-point aware length, so CJK and emoji count as one character. */
    function countChars(text) {
      return Array.from(String(text ?? '')).length;
    }

    function pairOps(ops) {
      const rows = [];
      let added = 0;
      let removed = 0;
      let pendingDel = [];
      let pendingIns = [];
      const flush = () => {
        const width = Math.max(pendingDel.length, pendingIns.length);
        for (let i = 0; i < width; i += 1) {
          rows.push({ left: pendingDel[i] === undefined ? null : pendingDel[i], right: pendingIns[i] === undefined ? null : pendingIns[i], changed: true });
        }
        pendingDel = [];
        pendingIns = [];
      };
      for (const op of ops) {
        if (op.type === 'same') {
          flush();
          rows.push({ left: op.text, right: op.text, changed: false });
        } else if (op.type === 'del') {
          pendingDel.push(op.text);
          removed += 1;
        } else {
          pendingIns.push(op.text);
          added += 1;
        }
      }
      flush();
      return { rows, added, removed };
    }

    function indexRows(left, right) {
      const rows = [];
      let added = 0;
      let removed = 0;
      const width = Math.max(left.length, right.length);
      for (let i = 0; i < width; i += 1) {
        const a = left[i] === undefined ? null : left[i];
        const b = right[i] === undefined ? null : right[i];
        const changed = a !== b;
        if (changed) {
          if (a !== null) removed += 1;
          if (b !== null) added += 1;
        }
        rows.push({ left: a, right: b, changed });
      }
      return { rows, added, removed };
    }

    /** Line-level LCS diff, capped so a huge draft cannot stall the renderer. */
    function lineDiff(leftText, rightText) {
      const left = splitLines(leftText);
      const right = splitLines(rightText);
      const cap = 400;
      if (left.length > cap || right.length > cap) return indexRows(left, right);
      const n = left.length;
      const m = right.length;
      const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
      }
      const ops = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (left[i] === right[j]) {
          ops.push({ type: 'same', text: left[i] });
          i += 1;
          j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
          ops.push({ type: 'del', text: left[i] });
          i += 1;
        } else {
          ops.push({ type: 'ins', text: right[j] });
          j += 1;
        }
      }
      while (i < n) {
        ops.push({ type: 'del', text: left[i] });
        i += 1;
      }
      while (j < m) {
        ops.push({ type: 'ins', text: right[j] });
        j += 1;
      }
      return pairOps(ops);
    }

    /** Incremental `text/event-stream` parser: feed decoded chunks, receive events. */
    function createSseParser(handle) {
      let buffer = '';
      return function feed(chunk) {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          for (const line of frame.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '' || payload === '[DONE]') continue;
            let event;
            try {
              event = JSON.parse(payload);
            } catch {
              continue;
            }
            handle(event);
          }
          index = buffer.indexOf('\n\n');
        }
      };
    }

    // ------------------------------------------------------------- storage

    function readJson(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    function writeJson(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* private mode / quota — never break prompting for this */
      }
    }

    function readHistory() {
      const value = readJson(HISTORY_KEY, []);
      if (!Array.isArray(value)) return [];
      return value.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.result === 'string' && typeof entry.source === 'string').slice(0, HISTORY_LIMIT);
    }

    function pushHistory(entry) {
      const next = [entry, ...readHistory()].slice(0, HISTORY_LIMIT);
      writeJson(HISTORY_KEY, next);
      return next;
    }

    function readTarget() {
      const value = readJson(TARGET_KEY, null);
      if (value === null || typeof value !== 'object') return null;
      if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
      return { provider: value.provider, model: value.model };
    }

    function readTemperature() {
      const value = readJson(TEMPERATURE_KEY, null);
      return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_TEMPERATURE;
    }

    // ------------------------------------------------------------- version

    function readBootVersion() {
      try {
        const boot = window.__DSH_BOOT__;
        if (boot === null || typeof boot !== 'object') return '';
        for (const key of ['version', 'appVersion', 'dshVersion', 'buildVersion']) {
          if (typeof boot[key] === 'string' && boot[key] !== '') return boot[key];
        }
        if (boot.version !== null && typeof boot.version === 'object' && typeof boot.version.value === 'string') return boot.version.value;
        return '';
      } catch {
        return '';
      }
    }

    function versionParts(version) {
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
      return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
    }

    /** Unknown versions are treated as compatible: a false warning is worse. */
    function isCompatible(current, required) {
      const a = versionParts(current);
      const b = versionParts(required);
      if (a === null || b === null) return true;
      for (let i = 0; i < 3; i += 1) {
        if (a[i] > b[i]) return true;
        if (a[i] < b[i]) return false;
      }
      return true;
    }

    // ----------------------------------------------------------------- api

    class RequestError extends Error {
      constructor(message, status) {
        super(message);
        this.name = 'RequestError';
        this.status = status;
      }
    }

    async function readErrorDetail(response) {
      try {
        const payload = await response.json();
        if (typeof payload?.error === 'string' && payload.error !== '') return payload.error;
      } catch {
        /* not JSON */
      }
      return `HTTP ${response.status}`;
    }

    async function optimizeRequest({ text, target, temperature, signal, onMeta, onDelta }) {
      const body = { text, temperature };
      if (target !== null && target !== undefined && target.provider !== '' && target.model !== '') {
        body.provider = target.provider;
        body.model = target.model;
      }
      if (STREAMING) body.stream = true;

      const response = await fetch(new URL(ROUTE, document.baseURI).toString(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new RequestError(await readErrorDetail(response), response.status);

      const contentType = typeof response.headers?.get === 'function' ? response.headers.get('content-type') ?? '' : '';
      if (STREAMING && contentType.includes('text/event-stream') && typeof response.body?.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let partial = '';
        let final = null;
        let failure = '';
        const feed = createSseParser((event) => {
          if (event === null || typeof event !== 'object') return;
          if (event.type === 'meta') {
            onMeta?.({ provider: typeof event.provider === 'string' ? event.provider : '', model: typeof event.model === 'string' ? event.model : '' });
          } else if (event.type === 'delta' && typeof event.text === 'string') {
            partial += event.text;
            onDelta?.(event.text);
          } else if (event.type === 'done') {
            final = { text: typeof event.text === 'string' ? event.text : '', provider: event.provider, model: event.model };
          } else if (event.type === 'error') {
            failure = typeof event.message === 'string' && event.message !== '' ? event.message : 'stream failed';
          }
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
        if (failure !== '') throw new Error(failure);
        const merged = final === null ? { text: partial, provider: target?.provider ?? '', model: target?.model ?? '' } : final;
        return merged;
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return {
        text: typeof payload?.text === 'string' ? payload.text : '',
        provider: typeof payload?.provider === 'string' ? payload.provider : '',
        model: typeof payload?.model === 'string' ? payload.model : '',
      };
    }

    async function loadModels(signal) {
      const response = await fetch(new URL(MODELS_ROUTE, document.baseURI).toString(), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal,
      });
      if (!response.ok) throw new RequestError(await readErrorDetail(response), response.status);
      const payload = await response.json();
      const models = Array.isArray(payload?.models)
        ? payload.models.filter((item) => item !== null && typeof item === 'object' && typeof item.provider === 'string' && typeof item.model === 'string')
        : [];
      return { models, default: payload?.default ?? null, pluginVersion: typeof payload?.pluginVersion === 'string' ? payload.pluginVersion : '' };
    }

    // --------------------------------------------------------------- store

    function createStore() {
      const state = {
        status: 'idle',
        visible: false,
        source: '',
        result: '',
        partial: '',
        error: '',
        provider: '',
        model: '',
        models: [],
        modelsLoaded: false,
        modelsError: false,
        target: readTarget(),
        temperature: readTemperature(),
        history: readHistory(),
        historyOpen: false,
        adopted: false,
        copied: false,
        version: readBootVersion(),
      };
      const listeners = new Set();
      let controller = null;

      const api = {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        patch(next) {
          Object.assign(state, next);
          for (const listener of listeners) {
            try {
              listener();
            } catch (cause) {
              console.error('[prompt-optimizer] listener failed', cause);
            }
          }
        },

        async refreshModels(force) {
          if (state.modelsLoaded && force !== true) return;
          const local = new AbortController();
          try {
            const loaded = await loadModels(local.signal);
            api.patch({
              models: loaded.models,
              modelsLoaded: true,
              modelsError: false,
              provider: state.provider === '' && loaded.default !== null ? loaded.default.provider : state.provider,
              model: state.model === '' && loaded.default !== null ? loaded.default.model : state.model,
            });
          } catch (cause) {
            console.warn('[prompt-optimizer] model list is unavailable', cause);
            api.patch({ modelsLoaded: true, modelsError: true });
          }
        },

        setTarget(target) {
          writeJson(TARGET_KEY, target);
          api.patch({ target });
        },

        setTemperature(temperature) {
          writeJson(TEMPERATURE_KEY, temperature);
          api.patch({ temperature });
        },

        cancel() {
          if (controller !== null) controller.abort();
        },

        async start(text, sessionId) {
          if (state.status === 'running') return;
          const draft = String(text ?? '').trim();
          if (draft === '') return;
          if (countChars(draft) > MAX_INPUT_CHARS) {
            api.patch({ status: 'error', visible: true, error: format(api.locale('error.failed'), { message: `> ${MAX_INPUT_CHARS}` }), source: draft });
            return;
          }
          controller = new AbortController();
          api.patch({
            status: 'running',
            visible: true,
            source: draft,
            result: '',
            partial: '',
            error: '',
            adopted: false,
            copied: false,
            provider: state.target === null ? state.provider : state.target.provider,
            model: state.target === null ? state.model : state.target.model,
          });
          void api.refreshModels(false);
          try {
            const outcome = await optimizeRequest({
              text: draft,
              target: state.target,
              temperature: state.temperature,
              signal: controller.signal,
              onMeta: (meta) => api.patch({ provider: meta.provider || state.provider, model: meta.model || state.model }),
              onDelta: (delta) => api.patch({ partial: state.partial + delta }),
            });
            const text_ = typeof outcome?.text === 'string' ? outcome.text : '';
            if (text_.trim() === '') throw new Error(api.locale('error.empty'));
            api.patch({
              status: 'ready',
              result: text_,
              partial: text_,
              provider: typeof outcome.provider === 'string' && outcome.provider !== '' ? outcome.provider : state.provider,
              model: typeof outcome.model === 'string' && outcome.model !== '' ? outcome.model : state.model,
              history: pushHistory({ ts: Date.now(), source: draft, result: text_, provider: outcome.provider ?? '', model: outcome.model ?? '', sessionId: sessionId === undefined ? '' : String(sessionId) }),
            });
          } catch (cause) {
            if (cause !== null && typeof cause === 'object' && cause.name === 'AbortError') {
              api.patch({ status: 'idle', visible: false, partial: '' });
              return;
            }
            const message = cause instanceof Error ? cause.message : String(cause);
            const status = typeof cause?.status === 'number' ? cause.status : 0;
            console.error('[prompt-optimizer]', cause);
            api.patch({
              status: 'error',
              visible: true,
              error: status === 401 ? `${message}${api.locale('error.authHint')}` : message,
            });
          } finally {
            controller = null;
          }
        },

        retry(sessionId) {
          return api.start(state.source, sessionId);
        },

        adopt({ inputActions, sessionId }) {
          if (state.result.trim() === '') return;
          const wrote = applyDraft(inputActions, state.result);
          if (wrote) {
            stashPush(sessionId, { original: state.source, optimized: state.result });
          } else {
            copyText(state.result);
            api.patch({ copied: true });
          }
          api.patch({ status: 'adopted', adopted: wrote });
        },

        undo({ inputActions, sessionId }) {
          if (typeof inputActions?.setDraft === 'function') inputActions.setDraft(state.source);
          stashPop(sessionId);
          api.patch({ status: 'ready', adopted: false });
        },

        discard() {
          if (controller !== null) controller.abort();
          api.patch({ status: 'idle', visible: false, partial: '', error: '', adopted: false, copied: false });
        },

        toggleHistory() {
          api.patch({ historyOpen: !state.historyOpen, history: readHistory() });
        },

        loadEntry(index) {
          const entry = state.history[index];
          if (entry === undefined) return;
          api.patch({ status: 'ready', visible: true, source: entry.source, result: entry.result, partial: entry.result, provider: entry.provider ?? '', model: entry.model ?? '', error: '', adopted: false, historyOpen: false });
        },

        clearHistory() {
          writeJson(HISTORY_KEY, []);
          api.patch({ history: [], historyOpen: false });
        },

        copyResult() {
          if (state.result.trim() === '') return;
          copyText(state.result);
          api.patch({ copied: true });
        },

        toggleVisible() {
          api.patch({ visible: !state.visible });
        },

        locale: (key, fallback) => fallback ?? key,
      };

      return api;
    }

    // ------------------------------------------------------------ composer

    function stashKey(sessionId) {
      return `${STASH_PREFIX}${sessionId === undefined || sessionId === null || sessionId === '' ? 'default' : String(sessionId)}`;
    }

    function stashRead(sessionId) {
      try {
        const raw = window.sessionStorage.getItem(stashKey(sessionId));
        const parsed = raw === null ? null : JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry) => entry !== null && typeof entry?.original === 'string' && typeof entry?.optimized === 'string');
      } catch {
        return [];
      }
    }

    function stashWrite(sessionId, entries) {
      try {
        window.sessionStorage.setItem(stashKey(sessionId), JSON.stringify(entries.slice(-STASH_LIMIT)));
      } catch {
        /* storage disabled — reverting still works through the composer's own undo */
      }
    }

    function stashPush(sessionId, entry) {
      stashWrite(sessionId, [...stashRead(sessionId), entry]);
    }

    function stashPop(sessionId) {
      const entries = stashRead(sessionId);
      if (entries.length === 0) return;
      stashWrite(sessionId, entries.slice(0, -1));
    }

    function copyText(text) {
      try {
        if (navigator?.clipboard?.writeText !== undefined) {
          void navigator.clipboard.writeText(text).catch(() => {});
          return true;
        }
      } catch {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'true');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Write the rewrite back as one undoable edit. `captureInsertion()` gives the
     * editor's own detect-coordinate caret and revision; a collapsed caret means
     * its `end` is the document length, so `[0, end)` is the whole draft.
     */
    function applyDraft(inputActions, optimized) {
      try {
        if (typeof inputActions?.captureInsertion === 'function' && typeof inputActions?.insertText === 'function') {
          const captured = inputActions.captureInsertion();
          if (captured !== null && typeof captured === 'object' && typeof captured.draftRev === 'number' && captured.start === captured.end) {
            const span = { start: 0, end: captured.end, draftRev: captured.draftRev };
            if (inputActions.insertText(optimized, span) === true) return true;
          }
        }
      } catch (cause) {
        console.warn('[prompt-optimizer] insertText is unavailable, falling back to setDraft', cause);
      }
      if (typeof inputActions?.setDraft === 'function') {
        inputActions.setDraft(optimized);
        return true;
      }
      return false;
    }

    // ---------------------------------------------------------- components

    // The mark the button has always used. It is plain text on purpose: an
    // inline SVG could come out blank when the host styles the slot, while a
    // text glyph inherits the row font and colour and stays legible.
    function Glyph() {
      return h('span', { className: 'dsh-po-glyph', 'aria-hidden': true }, '\u2728');
    }

    function useStore(store) {
      const [, setVersion] = React.useState(0);
      React.useEffect(() => store.subscribe(() => setVersion((value) => value + 1)), [store]);
      return store.get();
    }

    function useLocaleRefresh(localeService, translate) {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      React.useEffect(() => {
        if (typeof localeService?.subscribe !== 'function') return undefined;
        return localeService.subscribe(() => bump());
      }, [localeService]);
      return translate;
    }

    function makeControl(t, store, localeService) {
      return function OptimizeControl(props) {
        useLocaleRefresh(localeService, t);
        const state = useStore(store);
        const draft = props.useInput((inputState) => (inputState === undefined || inputState === null ? '' : inputState.draft ?? ''));
        const text = String(draft ?? '').trim();
        const canWrite = typeof props.inputActions?.setDraft === 'function' || typeof props.inputActions?.insertText === 'function';
        const busy = state.status === 'running';
        const hasResult = state.status === 'ready' || state.status === 'adopted';
        const failed = state.status === 'error';

        const onClick = React.useCallback(() => {
          if (busy) {
            store.cancel();
            return;
          }
          if (hasResult) {
            store.toggleVisible();
            return;
          }
          void store.start(text, props.sessionId);
        }, [busy, hasResult, text, props.sessionId]);

        const label = busy ? t('action.busy', '优化中') : hasResult ? t('action.view', '查看优化') : failed ? t('action.retry', '重试') : t('action.short', '优化');
        const title = busy
          ? t('tip.busy', '正在改写… 点按钮可取消')
          : hasResult
            ? t('tip.view', '展开或收起优化对比')
            : failed
              ? format(t('tip.failed', '优化失败：{message}（点击重试）'), { message: state.error })
              : text === ''
                ? t('tip.empty', '先在输入框写下你的需求')
                : t('tip.idle', '把当前输入改写为结构化的专业提示词，并先给你看对比');

        return h(
          'div',
          { className: 'dsh-po' },
          failed && state.error !== ''
            ? h('span', { key: 'error', className: 'dsh-po-error', title: state.error }, state.error)
            : null,
          h(
            'button',
            {
              key: 'button',
              type: 'button',
              className: `dsh-po-btn${busy ? ' is-busy' : ''}${hasResult ? ' is-active' : ''}`,
              title,
              'aria-label': t('action.idle', '优化提示词'),
              'aria-busy': busy,
              disabled: busy ? false : !canWrite || text === '',
              onClick,
            },
            h(Glyph, { key: 'icon' }),
            h('span', { key: 'label', className: 'dsh-po-label' }, label),
          ),
        );
      };
    }

    function renderLines(rows) {
      const limited = rows.slice(0, 240);
      const children = [];
      for (let index = 0; index < limited.length; index += 1) {
        const row = limited[index];
        children.push(
          h('div', { key: `l${index}`, className: `dsh-po-line${row.changed ? ' is-changed' : ''}${row.left === null ? ' is-empty' : ''}` }, row.left === null ? '\u00a0' : row.left),
        );
        children.push(
          h('div', { key: `r${index}`, className: `dsh-po-line${row.changed ? ' is-strong' : ''}${row.right === null ? ' is-empty' : ''}` }, row.right === null ? '\u00a0' : row.right),
        );
      }
      return children;
    }

    function makePreview(t, store, localeService) {
      return function OptimizePreview(props) {
        useLocaleRefresh(localeService, t);
        const state = useStore(store);
        if (state.visible !== true || state.status === 'idle') return null;

        const running = state.status === 'running';
        const failed = state.status === 'error';
        const ready = state.status === 'ready' || state.status === 'adopted';
        const shown = running ? state.partial : state.result;
        const diff = ready ? lineDiff(state.source, state.result) : null;
        const compatible = isCompatible(state.version, REQUIRED_DSH);

        const onModelChange = (event) => {
          const value = event?.target?.value ?? '';
          const [provider, model] = value.split('\u0000');
          if (provider === undefined || model === undefined || provider === '' || model === '') {
            store.setTarget(null);
            return;
          }
          store.setTarget({ provider, model });
        };

        const targetValue = state.target === null ? '' : `${state.target.provider}\u0000${state.target.model}`;

        const header = h(
          'div',
          { key: 'head', className: 'dsh-po-head' },
          h('span', { key: 'title', className: 'dsh-po-title' }, h(Glyph, { key: 'icon' }), t('panel.title', '优化结果')),
          h('span', { key: 'meta', className: 'dsh-po-meta' }, running ? t('panel.streaming', '生成中…') : `${state.provider === '' ? '' : state.provider}${state.model === '' ? '' : ` / ${state.model}`}`),
          h('span', { key: 'spacer', className: 'dsh-po-spacer' }),
          h('button', { key: 'history', type: 'button', className: 'dsh-po-ghost', onClick: () => store.toggleHistory(), title: t('panel.history', '历史') }, `${t('panel.history', '历史')} ${state.history.length}`),
          h('button', { key: 'close', type: 'button', className: 'dsh-po-ghost', onClick: () => store.discard(), title: t('panel.close', '关闭'), 'aria-label': t('panel.close', '关闭') }, '✕'),
        );

        const columns = h(
          'div',
          { key: 'cols' },
          h('div', { key: 'heads', className: 'dsh-po-cols' },
            h('div', { key: 'a', className: 'dsh-po-colhead' }, t('panel.source', '原文')),
            h('div', { key: 'b', className: 'dsh-po-colhead' }, t('panel.result', '优化后')),
          ),
          diff === null
            ? h('div', { key: 'plain', className: 'dsh-po-cols' },
                h('div', { key: 'sa', className: 'dsh-po-line is-plain' }, state.source),
                h('div', { key: 'sb', className: 'dsh-po-line is-plain' }, shown === '' ? t('panel.waiting', '思考中…') : `${shown}${running ? '▍' : ''}`),
              )
            : h('div', { key: 'diff', className: 'dsh-po-cols' }, ...renderLines(diff.rows)),
        );

        const stats = ready
          ? h('span', { key: 'stats', className: 'dsh-po-note' }, `${format(t('panel.stats', '{from} → {to} 字'), { from: countChars(state.source), to: countChars(state.result) })} · ${format(t('panel.lines', '{added} 行新增 / {removed} 行删除'), { added: diff.added, removed: diff.removed })}`)
          : running
            ? h('span', { key: 'stats', className: 'dsh-po-note' }, t('panel.streaming', '生成中…'))
            : null;

        const footer = h(
          'div',
          { key: 'foot', className: 'dsh-po-foot' },
          running || failed
            ? h('button', { key: 'primary', type: 'button', className: 'dsh-po-ghost', onClick: () => store.discard() }, t('panel.discard', '放弃'))
            : h('button', { key: 'primary', type: 'button', className: 'dsh-po-primary', disabled: state.adopted === true, onClick: () => store.adopt({ inputActions: props.inputActions, sessionId: props.sessionId }) }, state.adopted === true ? t('panel.adopted', '已写入输入框（Ctrl+Z 可撤销）') : t('panel.adopt', '采纳并写入')),
          ready && state.adopted === true
            ? h('button', { key: 'undo', type: 'button', className: 'dsh-po-ghost', onClick: () => store.undo({ inputActions: props.inputActions, sessionId: props.sessionId }) }, t('panel.undo', '撤销这次采纳'))
            : null,
          running
            ? h('button', { key: 'cancel', type: 'button', className: 'dsh-po-ghost', onClick: () => store.cancel() }, `${t('action.busy', '优化中')}…`)
            : failed
              ? h('button', { key: 'retry', type: 'button', className: 'dsh-po-primary', onClick: () => store.retry(props.sessionId) }, t('panel.retry', '重新优化'))
              : h('button', { key: 'retry', type: 'button', className: 'dsh-po-ghost', onClick: () => store.retry(props.sessionId) }, t('panel.retry', '重新优化')),
          ready
            ? h('button', { key: 'copy', type: 'button', className: 'dsh-po-ghost', onClick: () => store.copyResult() }, state.copied ? t('panel.copied', '已复制') : t('panel.copy', '复制'))
            : null,
          h('span', { key: 'spacer', className: 'dsh-po-spacer' }),
          stats,
        );

        const modelRow = h(
          'div',
          { key: 'model-row', className: 'dsh-po-foot' },
          h('label', { key: 'ml', className: 'dsh-po-note' }, t('panel.model', '模型')),
          state.models.length > 1
            ? h('select', { key: 'ms', className: 'dsh-po-select', value: targetValue, onChange: onModelChange, disabled: running },
                h('option', { key: 'auto', value: '' }, `${t('panel.model', '模型')}: ${state.provider}${state.model === '' ? '' : ` / ${state.model}`}`),
                ...state.models.map((item) => h('option', { key: `${item.provider}\u0000${item.model}`, value: `${item.provider}\u0000${item.model}` }, item.label ?? `${item.provider} / ${item.model}`)),
              )
            : h('span', { key: 'mn', className: 'dsh-po-note' }, `${state.provider}${state.model === '' ? '' : ` / ${state.model}`}`),
          h('label', { key: 'tl', className: 'dsh-po-note' }, t('panel.temperature', '温度')),
          h('select', { key: 'ts', className: 'dsh-po-select', value: String(state.temperature), onChange: (event) => store.setTemperature(Number(event?.target?.value)), disabled: running },
            h('option', { key: 'stable', value: '0.2' }, t('panel.temperature.stable', '稳定 0.2')),
            h('option', { key: 'flex', value: '0.7' }, t('panel.temperature.flex', '灵活 0.7')),
          ),
        );

        const notes = [];
        if (state.copied) notes.push(h('div', { key: 'copied', className: 'dsh-po-note' }, t('panel.adoptedCopy', '当前环境无法写回输入框，已复制到剪贴板')));
        if (!compatible) notes.push(h('div', { key: 'compat', className: 'dsh-po-note is-warn' }, format(t('panel.compat', '本插件按 DSH ≥ {required} 开发，当前 {current}'), { required: REQUIRED_DSH, current: state.version })));
        if (failed && state.error !== '') notes.push(h('div', { key: 'failed', className: 'dsh-po-note is-error' }, format(t('error.failed', '优化失败：{message}'), { message: state.error })));

        const history = state.historyOpen
          ? h(
              'div',
              { key: 'history', className: 'dsh-po-history' },
              state.history.length === 0
                ? h('div', { key: 'empty', className: 'dsh-po-note' }, t('panel.historyEmpty', '还没有优化历史'))
                : state.history.slice(0, 8).map((entry, index) =>
                    h('div', { key: `h${index}`, className: 'dsh-po-history-row' },
                      h('span', { key: 'text', className: 'dsh-po-history-text', title: entry.source }, entry.source.replace(/\s+/g, ' ').slice(0, 80)),
                      h('button', { key: 'load', type: 'button', className: 'dsh-po-ghost', onClick: () => store.loadEntry(index) }, t('panel.load', '载入')),
                    ),
                  ),
              h('div', { key: 'actions', className: 'dsh-po-history-row' },
                h('span', { key: 'spacer', className: 'dsh-po-spacer' }),
                h('button', { key: 'clear', type: 'button', className: 'dsh-po-ghost', onClick: () => store.clearHistory() }, t('panel.clear', '清空')),
              ),
            )
          : null;

        return h(
          'div',
          { className: 'dsh-po-card' },
          h('style', { key: 'style' }, CSS),
          header,
          h('div', { key: 'body', className: 'dsh-po-body' }, columns),
          ...notes,
          footer,
          ready ? modelRow : null,
          history,
        );
      };
    }

    /** Guarded entries: standard composer props are absent outside a live composer. */
    function guarded(Component) {
      return function PromptOptimizerSlot(props) {
        if (props === null || props === undefined) return null;
        if (typeof props.useInput !== 'function') return null;
        return Component(props);
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const localeService = ctx.get('locale');
        const translate = typeof localeService?.bind === 'function' ? localeService.bind(NS) : null;
        const t = (key, fallback) => {
          if (typeof translate === 'function') {
            try {
              const value = translate(key);
              if (typeof value === 'string' && value !== '' && value !== key) return value;
            } catch {
              /* a failed lookup falls through to the built-in text */
            }
          }
          return fallback;
        };

        const store = createStore();
        store.locale = (key, fallback) => t(key, fallback);

        const Control = guarded(makeControl(t, store, localeService));
        const Preview = guarded(makePreview(t, store, localeService));

        if (typeof localeService?.register === 'function') {
          ctx.effect(() => {
            const disposers = [];
            for (const [id, dict] of [['en', EN], ['zh', ZH]]) {
              try {
                disposers.push(localeService.register(NS, id, dict));
              } catch (cause) {
                console.warn('[prompt-optimizer] locale dictionary was not registered:', id, cause);
              }
            }
            return () => {
              for (const dispose of disposers) {
                try {
                  dispose();
                } catch {
                  /* disposal is best effort */
                }
              }
            };
          }, 'prompt-optimizer: locale dictionaries');
        }

        ctx.slots.inject(BUTTON_SLOT, () =>
          ctx.slots.register({ name: BUTTON_SLOT, id: 'prompt-optimizer', order: 20, label: () => t('slot.label', '优化提示词') }, Control),
        );
        ctx.slots.inject(PREVIEW_SLOT, () =>
          ctx.slots.register({ name: PREVIEW_SLOT, id: 'prompt-optimizer-preview', order: 5, label: () => t('slot.label', '优化提示词') }, Preview),
        );

        if (typeof globalThis === 'object' && globalThis.__DSH_TEST__ === true) {
          globalThis.__dshPromptOptimizer = { lineDiff, countChars, splitLines, createSseParser, applyDraft, isCompatible, format, store };
        }
      },
    };
  },
});

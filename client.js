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
    const SETTINGS_ROUTE = 'api/prompt.optimize/settings';
    const STREAMING = true;
    const MAX_INPUT_CHARS = 24000;
/** The Host chunks drafts above MAX_INPUT_CHARS, so the client only guards this ceiling. */
const MAX_DRAFT_CHARS = 120000;

    const STASH_PREFIX = 'dsh-prompt-optimizer:revert:';
    const STASH_LIMIT = 10;
    const HISTORY_KEY = 'dsh-prompt-optimizer:history';
    const HISTORY_LIMIT = 20;
    const TARGET_KEY = 'dsh-prompt-optimizer:target';
    const TEMPERATURE_KEY = 'dsh-prompt-optimizer:temperature';
    const AUTO_WRITE_KEY = 'dsh-prompt-optimizer:auto-write';
    const DEFAULT_TEMPERATURE = 0.2;
    const REQUIRED_DSH = '0.2.0';

    const ZH = {
      'slot.label': '优化提示词',
      'action.idle': '优化提示词',
      'action.short': '优化',
      'action.busy': '优化中',
      'action.view': '查看优化',
      'action.hide': '收起',
      'action.retry': '重试',
      'tip.idle': '把当前输入改写为结构化的专业提示词，并先给你看对比',
      'tip.idleDirect': '把当前输入改写为结构化的专业提示词，并直接写回输入框',
      'tip.empty': '先在输入框写下你的需求，再点这里改写为专业提示词',
      'tip.busy': '正在改写… 点按钮可取消',
      'tip.view': '展开或收起优化对比',
      'tip.failed': '优化失败：{message}（点击重试）',
      'error.failed': '优化失败：{message}',
      'error.tooLong': '草稿超过 {limit} 字符，请分几次优化',
      'error.empty': '模型返回了空结果',
      'error.network': '请求失败：{message}',
      'error.authHint': '（页面会话已失效，请用带 token 的地址刷新页面）',
      'panel.title': '优化结果',
      'panel.source': '原文',
      'panel.result': '优化后',
      'panel.streaming': '生成中…',
      'panel.stats': '{from} → {to} 字',
      'panel.lines': '{added} 行新增 / {removed} 行删除',
      'panel.anchors': '锚点 {kept}/{total} 保留',
      'panel.anchorsMissing': '缺 {n} 处',
      'panel.chunks': '分 {n} 段',
      'panel.repairedOnly': '已删掉编造内容',
      'panel.added': '补全 {n} 条未见于原文',
      'panel.addedTip': '新增：{list}',
      'panel.repaired': '已自动补回',
      'panel.adopt': '采纳并写入',
      'panel.discard': '放弃',
      'panel.retry': '重新优化',
      'panel.close': '关闭',
      'panel.copy': '复制',
      'panel.copied': '已复制',
      'panel.adopted': '已写入输入框（Ctrl+Z 可撤销）',
      'panel.adoptedAuto': '已直接写入输入框，可直接发送（Ctrl+Z 撤销）',
      'panel.autoWriteOn': '直接写入：开',
      'panel.autoWriteOff': '直接写入：关',
      'panel.autoWriteTip': '开着：优化完成就自动写回输入框；关掉：先给你看对比再决定（Shift+点击按钮可临时直接写入）',
      'panel.adoptedCopy': '当前环境无法写回输入框，已复制到剪贴板',
      'panel.undo': '撤销这次采纳',
      'panel.model': '模型',
    'panel.model.auto': '跟随对话模型',
    'panel.model.follow': '跟随对话（{model}）',
      'panel.temperature': '温度',
      'panel.temperature.stable': '稳定 0.2',
      'panel.temperature.flex': '灵活 0.7',
      'panel.history': '历史',
      'panel.historyEmpty': '还没有优化历史',
      'panel.clear': '清空',
      'panel.load': '载入',
      'panel.compat': '本插件按 DSH ≥ {required} 开发，当前 {current}，部分控件可能不可用',
      'panel.waiting': '思考中…',
      'panel.settings': '设置',
      'panel.preset': '预设',
      'panel.candidates': '候选数',
      'panel.maxTokens': '最大长度',
      'panel.save': '保存',
      'panel.saving': '保存中…',
      'panel.saved': '已保存',
      'panel.resetDefaults': '恢复默认',
      'panel.settingsHint': '设置存在本机，换浏览器也在；模型仍跟随对话框里选择的模型。',
      'panel.settingsLoading': '读取设置中…',
      'panel.settingsFailed': '设置读取失败',
      'panel.settingsReload': '重试',
      'preset.general': '通用',
      'preset.writing': '写作',
      'preset.coding': '编程',
      'preset.analysis': '分析',
      'preset.agent': '智能体任务',
    };

    const EN = {
      'slot.label': 'Optimize prompt',
      'action.idle': 'Optimize prompt',
      'action.short': 'Optimize',
      'action.busy': 'Optimizing',
      'action.view': 'Show result',
      'action.hide': 'Hide',
      'action.retry': 'Retry',
      'tip.idle': 'Rewrite the current draft into a structured prompt, shown as a diff first',
      'tip.idleDirect': 'Rewrite the current draft into a structured prompt and write it back into the composer',
      'tip.empty': 'Write what you need first, then click here to rewrite it as a prompt',
      'tip.busy': 'Rewriting… click the button to cancel',
      'tip.view': 'Expand or collapse the before/after comparison',
      'tip.failed': 'Optimization failed: {message} (click to retry)',
      'error.failed': 'Optimization failed: {message}',
      'error.tooLong': 'The draft is longer than {limit} characters — split it and optimize each part',
      'error.empty': 'The model returned an empty result',
      'error.network': 'Request failed: {message}',
      'error.authHint': ' (the page session expired — reload the URL printed by dsh web)',
      'panel.title': 'Optimized prompt',
      'panel.source': 'Original',
      'panel.result': 'Optimized',
      'panel.streaming': 'streaming…',
      'panel.stats': '{from} → {to} chars',
      'panel.lines': '{added} added / {removed} removed lines',
      'panel.anchors': '{kept}/{total} anchors kept',
      'panel.anchorsMissing': '{n} dropped',
      'panel.chunks': '{n} parts',
      'panel.repairedOnly': 'invented material removed',
      'panel.added': '{n} not in the draft',
      'panel.addedTip': 'added: {list}',
      'panel.repaired': 'auto-repaired once',
      'panel.adopt': 'Adopt',
      'panel.discard': 'Discard',
      'panel.retry': 'Optimize again',
      'panel.close': 'Close',
      'panel.copy': 'Copy',
      'panel.copied': 'Copied',
      'panel.adopted': 'Written to the composer (Ctrl+Z to undo)',
      'panel.adoptedAuto': 'Written straight into the composer — send it, or press Ctrl+Z to undo',
      'panel.autoWriteOn': 'Direct write: on',
      'panel.autoWriteOff': 'Direct write: off',
      'panel.autoWriteTip': 'On: the rewrite lands in the composer as soon as it is ready. Off: review the diff first (Shift+click the button to write directly once)',
      'panel.adoptedCopy': 'Could not write to the composer here — copied to the clipboard',
      'panel.undo': 'Undo this adoption',
      'panel.model': 'Model',
    'panel.model.auto': 'Follow the chat model',
    'panel.model.follow': 'Follow the chat ({model})',
      'panel.temperature': 'Temperature',
      'panel.temperature.stable': 'steady 0.2',
      'panel.temperature.flex': 'loose 0.7',
      'panel.history': 'History',
      'panel.historyEmpty': 'No history yet',
      'panel.clear': 'Clear',
      'panel.load': 'Load',
      'panel.compat': 'Built for DSH >= {required}, running {current}; some controls may be unavailable',
      'panel.waiting': 'Thinking…',
      'panel.settings': 'Settings',
      'panel.preset': 'Preset',
      'panel.candidates': 'Candidates',
      'panel.maxTokens': 'Max length',
      'panel.save': 'Save',
      'panel.saving': 'Saving…',
      'panel.saved': 'Saved',
      'panel.resetDefaults': 'Reset',
      'panel.settingsHint': 'Settings live on this machine and survive a browser change; the model still follows the chat model picker.',
      'panel.settingsLoading': 'Loading settings…',
      'panel.settingsFailed': 'Could not load the settings',
      'panel.settingsReload': 'Retry',
      'preset.general': 'General',
      'preset.writing': 'Writing',
      'preset.coding': 'Coding',
      'preset.analysis': 'Analysis',
      'preset.agent': 'Agent task',
    };

    const CSS = [
      '.dsh-po{display:inline-flex;align-items:center;min-width:0;gap:6px}',
      '.dsh-po-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.7;transition:opacity .12s ease,background .12s ease}',
      '.dsh-po-btn:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
      '.dsh-po-btn:disabled{cursor:default;opacity:.32}',
      '.dsh-po-btn.is-active{opacity:1;border-color:color-mix(in srgb,currentColor 32%,transparent)}',
      '.dsh-po-btn.is-busy .dsh-po-glyph{animation:dsh-po-spin 1.15s linear infinite}',
      '.dsh-po-gear{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.5;transition:opacity .12s ease,background .12s ease}',
      '.dsh-po-gear:hover{opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
      '.dsh-po-gear.is-on{opacity:1;border-color:color-mix(in srgb,currentColor 32%,transparent)}',
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
      '.dsh-po-ghost.is-on{opacity:1;border-color:color-mix(in srgb,#2f9e44 55%,transparent);color:#2f9e44}',
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
      '.dsh-po-settings{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);background:color-mix(in srgb,currentColor 3%,transparent)}',
      '.dsh-po-settings-hint{flex:1 1 100%;font-size:11px;opacity:.6}',
      '.dsh-po-settings .dsh-po-select{max-width:150px}',
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
    /** The Host chunks a long draft and reports how many parts it rewrote. */
function ledgerWithChunks(ledger, raw) {
  if (ledger === null || ledger === undefined) return null;
  const chunks = Math.round(Number(raw === null || raw === undefined ? NaN : raw.chunks));
  return Number.isFinite(chunks) && chunks > 1 ? { ...ledger, chunks } : ledger;
}

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

    /**
     * Direct write-back is the default: the point of the feature is that the
     * rewrite lands in the composer without a second click. Review-first mode is
     * one persisted toggle away, and Shift+click forces it for a single run.
     */
    function readAutoWrite() {
      const value = readJson(AUTO_WRITE_KEY, null);
      return typeof value === 'boolean' ? value : true;
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

    /**
     * Resolve the Host route against the page. `document.baseURI` is what the
     * shipped connection runtime uses, but a shell served under a path prefix
     * would resolve it elsewhere and the router would answer 404, so a 404
     * retries once against the bare origin before giving up.
     */
    function baseCandidates() {
      const bases = [];
      try {
        if (typeof document !== 'undefined' && typeof document.baseURI === 'string') bases.push(document.baseURI);
      } catch {
        /* no document */
      }
      try {
        if (typeof location !== 'undefined' && typeof location.origin === 'string' && location.origin !== 'null') {
          bases.push(`${location.origin}/`);
        }
      } catch {
        /* no location */
      }
      const unique = [];
      for (const base of bases) if (base !== '' && !unique.includes(base)) unique.push(base);
      return unique;
    }

    let workingBase = null;

    /** @returns {Promise<{ response: Response, url: string }>} */
    async function apiFetch(path, init) {
      const bases = workingBase === null ? baseCandidates() : [workingBase];
      let attempt = null;
      for (const base of bases) {
        const url = new URL(path, base).toString();
        const response = await fetch(url, init);
        if (response.status !== 404) {
          workingBase = base;
          return { response, url };
        }
        attempt = { response, url };
      }
      return attempt ?? { response: new Response(null, { status: 404 }), url: path };
    }

    /** Keep only a well-formed ledger; anything else means "no claim". */
    function normalizeLedger(value) {
      if (value === null || typeof value !== 'object') return null;
      const total = Number(value.anchors);
      const kept = Number(value.kept);
      if (!Number.isFinite(total) || !Number.isFinite(kept) || total <= 0) return null;
      const missing = Array.isArray(value.missing) ? value.missing.filter((item) => typeof item === 'string' && item !== '') : [];
      const added = Array.isArray(value.added)
        ? value.added
          .filter((item) => item !== null && typeof item === 'object' && typeof item.value === 'string' && item.value !== '')
          .map((item) => ({ kind: typeof item.kind === 'string' ? item.kind : '', value: item.value, risk: item.risk === 'high' ? 'high' : 'low' }))
        : [];
      return { anchors: total, kept: Math.max(0, Math.min(total, kept)), missing, repaired: value.repaired === true, added };
    }

    async function optimizeRequest({ text, target, temperature, signal, onMeta, onDelta, onReset }) {
      const body = { text, temperature };
      if (target !== null && target !== undefined && target.provider !== '' && target.model !== '') {
        body.provider = target.provider;
        body.model = target.model;
      }
      if (STREAMING) body.stream = true;

      const { response, url } = await apiFetch(ROUTE, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) throw new RequestError(`${await readErrorDetail(response)} · POST ${url}`, response.status);

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
          } else if (event.type === 'reset') {
            // The host dropped its first answer for a repair pass: clear the
            // partial text so the rewritten prompt does not appear twice.
            partial = '';
            onReset?.();
          } else if (event.type === 'delta' && typeof event.text === 'string') {
            partial += event.text;
            onDelta?.(event.text);
          } else if (event.type === 'done') {
            final = { text: typeof event.text === 'string' ? event.text : '', provider: event.provider, model: event.model, ledger: event.ledger ?? null };
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
        const merged = final === null ? { text: partial, provider: target?.provider ?? '', model: target?.model ?? '', ledger: null } : final;
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
        ledger: payload?.ledger ?? null,
      };
    }

    async function loadModels(signal) {
      const { response, url } = await apiFetch(MODELS_ROUTE, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        signal,
      });
      if (!response.ok) throw new RequestError(`${await readErrorDetail(response)} · GET ${url}`, response.status);
      const payload = await response.json();
      const models = Array.isArray(payload?.models)
        ? payload.models.filter((item) => item !== null && typeof item === 'object' && typeof item.provider === 'string' && typeof item.model === 'string')
        : [];
      return { models, default: payload?.default ?? null, pluginVersion: typeof payload?.pluginVersion === 'string' ? payload.pluginVersion : '' };
    }

    // --------------------------------------------------------------- store

    /** @returns {{ provider: string, model: string } | null} */
    function normalizeSelection(value) {
      if (value === null || typeof value !== 'object') return null;
      const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
      const model = typeof value.model === 'string' ? value.model.trim() : '';
      if (provider === '' || model === '') return null;
      return { provider, model };
    }

    /**
     * The model the composer currently shows, read from the `modelSelection`
     * projection (`next` is a pending switch, `lastUsed` the settled choice).
     * Null when the host does not expose it — the host half then decides.
     */
    function readComposerModel(useProjection) {
      if (typeof useProjection !== 'function') return null;
      const snapshot = useProjection('modelSelection');
      const picked = snapshot === null || typeof snapshot !== 'object' ? undefined : snapshot.next ?? snapshot.lastUsed;
      return normalizeSelection(picked);
    }

    function composerKey(composer) {
      return composer === null ? '' : `${composer.provider}\u0000${composer.model}`;
    }

    function createStore() {
      const state = {
        status: 'idle',
        visible: false,
        source: '',
        result: '',
        partial: '',
        error: '',
        /** Anchor ledger from the host: { anchors, kept, missing, repaired }. */
        ledger: null,
        provider: '',
        model: '',
        models: [],
        modelsLoaded: false,
        modelsError: false,
        target: readTarget(),
        /** What the composer's own model picker shows; null = unknown. */
        composer: null,
        temperature: readTemperature(),
        history: readHistory(),
        historyOpen: false,
        adopted: false,
        copied: false,
        autoWrite: readAutoWrite(),
        /** Set for one run by Shift+click: write directly even in review mode. */
        direct: false,
        /** True when the last adoption happened without a click. */
        autoAdopted: false,
        /** `{inputActions, sessionId}` published by the composer control. */
        writer: null,
        version: readBootVersion(),
        /** Host-stored settings; null until the settings panel is opened. */
        settings: null,
        settingsDefaults: null,
        settingsBounds: null,
        settingsPresets: [],
        settingsOpen: false,
        settingsBusy: false,
        settingsError: '',
        settingsSavedAt: 0,
      };
      const listeners = new Set();
      let controller = null;

      /**
       * Prefer the actions passed by the caller (the composer control holds the
       * live ones); otherwise fall back to whatever the control published.
       */
      function resolveWriter(passed) {
        const candidate = passed !== null && typeof passed === 'object' ? passed : null;
        const usable = (value) =>
          value !== null &&
          typeof value === 'object' &&
          (typeof value.inputActions?.setDraft === 'function' || typeof value.inputActions?.insertText === 'function');
        const chosen = usable(candidate) ? candidate : usable(state.writer) ? state.writer : {};
        return { inputActions: chosen.inputActions ?? null, sessionId: chosen.sessionId };
      }

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

        /** Remember which model the composer shows; the control publishes it. */
        setComposer(next) {
          const composer = normalizeSelection(next);
          if (composerKey(composer) === composerKey(state.composer)) return;
          api.patch({ composer });
        },

        setTarget(target) {
          writeJson(TARGET_KEY, target);
          api.patch({ target });
        },

        setTemperature(temperature) {
          writeJson(TEMPERATURE_KEY, temperature);
          api.patch({ temperature });
        },

        /**
         * The composer control is the only component guaranteed to hold
         * `inputActions`; the dock card may be mounted without them. Publishing
         * the writer here is what makes "write straight into the composer" work
         * from the card's buttons too.
         */
        setWriter(writer) {
          state.writer = writer ?? null;
        },

        clearWriter() {
          state.writer = null;
        },

        setAutoWrite(autoWrite) {
          const next = autoWrite === true;
          writeJson(AUTO_WRITE_KEY, next);
          api.patch({ autoWrite: next, direct: false });
          if (next === true && state.status === 'ready') api.adopt();
        },

        toggleAutoWrite() {
          api.setAutoWrite(state.autoWrite !== true);
        },

        cancel() {
          if (controller !== null) controller.abort();
        },

        async start(text, sessionId, options) {
          if (state.status === 'running') return;
          const draft = String(text ?? '').trim();
          const direct = options !== null && typeof options === 'object' && options.direct === true;
          if (draft === '') return;
          if (countChars(draft) > MAX_DRAFT_CHARS) {
            api.patch({ status: 'error', visible: true, error: format(api.locale('error.tooLong'), { limit: MAX_DRAFT_CHARS }), source: draft, direct: false });
            return;
          }
          const autoRun = state.autoWrite === true || direct;
          // A null target means "follow the composer": ship the model the chat is
          // currently using, so the rewrite never drifts to another model.
          const composer = options !== null && typeof options === 'object' ? normalizeSelection(options.composer) : null;
          const followed = composer ?? normalizeSelection(state.composer);
          const effective = state.target !== null ? state.target : followed;
          controller = new AbortController();
          api.patch({
            status: 'running',
            // Direct write-back decides by itself, so the review panel stays
            // closed unless the user opens it from the button.
            visible: autoRun !== true,
            source: draft,
            result: '',
            partial: '',
            error: '',
            ledger: null,
            adopted: false,
            copied: false,
            direct,
            provider: effective === null ? state.provider : effective.provider,
            model: effective === null ? state.model : effective.model,
          });
          void api.refreshModels(false);
          try {
            const outcome = await optimizeRequest({
              text: draft,
              target: effective,
              // Once the settings panel has loaded, temperature/preset/candidates
              // are owned by the Host settings file; sending one here would win.
              temperature: state.settings === null ? state.temperature : undefined,
              signal: controller.signal,
              onMeta: (meta) => api.patch({ provider: meta.provider || state.provider, model: meta.model || state.model }),
              onDelta: (delta) => api.patch({ partial: state.partial + delta }),
              onReset: () => api.patch({ partial: '' }),
            });
            const text_ = typeof outcome?.text === 'string' ? outcome.text : '';
            if (text_.trim() === '') throw new Error(api.locale('error.empty'));
            api.patch({
              status: 'ready',
              result: text_,
              partial: text_,
              provider: typeof outcome.provider === 'string' && outcome.provider !== '' ? outcome.provider : state.provider,
              model: typeof outcome.model === 'string' && outcome.model !== '' ? outcome.model : state.model,
              ledger: ledgerWithChunks(normalizeLedger(outcome.ledger), outcome.ledger),
              history: pushHistory({ ts: Date.now(), source: draft, result: text_, provider: outcome.provider ?? '', model: outcome.model ?? '', sessionId: sessionId === undefined ? '' : String(sessionId) }),
            });
            if (state.autoWrite === true || state.direct === true) {
              api.adopt();
              api.patch({ autoAdopted: true, visible: false });
            }
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

        adopt(passed) {
          if (state.result.trim() === '') return false;
          const writer = resolveWriter(passed);
          const wrote = applyDraft(writer.inputActions, state.result);
          if (wrote) {
            stashPush(writer.sessionId, { original: state.source, optimized: state.result });
          } else {
            copyText(state.result);
          }
          api.patch({ status: 'adopted', adopted: wrote, copied: wrote !== true, direct: false, autoAdopted: false });
          return wrote;
        },

        undo(passed) {
          const writer = resolveWriter(passed);
          if (typeof writer.inputActions?.setDraft === 'function') writer.inputActions.setDraft(state.source);
          stashPop(writer.sessionId);
          api.patch({ status: 'ready', adopted: false, copied: false, direct: false, autoAdopted: false });
        },

        discard() {
          if (controller !== null) controller.abort();
          api.patch({ status: 'idle', visible: false, partial: '', error: '', ledger: null, adopted: false, copied: false, direct: false, autoAdopted: false, settingsOpen: false });
        },

        toggleHistory() {
          api.patch({ historyOpen: !state.historyOpen, history: readHistory() });
        },

        loadEntry(index) {
          const entry = state.history[index];
          if (entry === undefined) return;
          api.patch({ status: 'ready', visible: true, source: entry.source, result: entry.result, partial: entry.result, ledger: null, provider: entry.provider ?? '', model: entry.model ?? '', error: '', adopted: false, copied: false, autoAdopted: false, historyOpen: false });
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

        // ---------------------------------------------------------- settings

        /** Read the persisted settings once, then keep them in memory. */
        async loadSettings(force) {
          if (state.settings !== null && force !== true) return;
          api.patch({ settingsBusy: true, settingsError: '' });
          try {
            const { response, url } = await apiFetch(SETTINGS_ROUTE, { method: 'GET', credentials: 'same-origin' });
            if (!response.ok) throw new RequestError(`${await readErrorDetail(response)} · GET ${url}`, response.status);
            const payload = await response.json();
            api.patch({
              settings: payload?.settings ?? null,
              settingsDefaults: payload?.defaults ?? null,
              settingsBounds: payload?.bounds ?? null,
              settingsPresets: Array.isArray(payload?.presets) ? payload.presets : [],
              settingsBusy: false,
              settingsError: '',
            });
          } catch (cause) {
            console.error('[prompt-optimizer] settings unavailable', cause);
            api.patch({ settingsBusy: false, settingsError: cause instanceof Error ? cause.message : String(cause) });
          }
        },

        toggleSettings() {
          const open = state.settingsOpen !== true;
          api.patch({ settingsOpen: open });
          if (open === true) void api.loadSettings(false);
        },

        /** Edit the local copy; nothing is persisted until saveSettings(). */
        setSetting(key, value) {
          if (state.settings === null) return;
          api.patch({ settings: { ...state.settings, [key]: value }, settingsSavedAt: 0 });
        },

        async saveSettings() {
          if (state.settings === null || state.settingsBusy === true) return;
          api.patch({ settingsBusy: true, settingsError: '' });
          try {
            const { response, url } = await apiFetch(SETTINGS_ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(state.settings),
            });
            if (!response.ok) throw new RequestError(`${await readErrorDetail(response)} · POST ${url}`, response.status);
            const payload = await response.json();
            api.patch({ settings: payload?.settings ?? state.settings, settingsBusy: false, settingsSavedAt: Date.now() });
          } catch (cause) {
            console.error('[prompt-optimizer] could not save settings', cause);
            api.patch({ settingsBusy: false, settingsError: cause instanceof Error ? cause.message : String(cause) });
          }
        },

        async resetSettings() {
          if (state.settingsBusy === true) return;
          api.patch({ settingsBusy: true, settingsError: '' });
          try {
            const { response, url } = await apiFetch(SETTINGS_ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reset: true }),
            });
            if (!response.ok) throw new RequestError(`${await readErrorDetail(response)} · POST ${url}`, response.status);
            const payload = await response.json();
            api.patch({ settings: payload?.settings ?? null, settingsBusy: false, settingsSavedAt: Date.now() });
          } catch (cause) {
            console.error('[prompt-optimizer] could not reset settings', cause);
            api.patch({ settingsBusy: false, settingsError: cause instanceof Error ? cause.message : String(cause) });
          }
        },

        /** Presets come from the Host so the list can grow without a UI patch. */
        presetLabel(id, fallback) {
          const found = state.settingsPresets.find((item) => item?.id === id);
          return found === undefined ? fallback : found.label;
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
        // The composer's own model picker wins by default: the rewrite should use
        // the model the conversation is currently talking to. The panel dropdown
        // can still pin a different one for this profile.
        const composer = readComposerModel(props.useProjection);
        React.useEffect(() => {
          store.setComposer(composer);
        }, [composerKey(composer)]);
        const canWrite = typeof props.inputActions?.setDraft === 'function' || typeof props.inputActions?.insertText === 'function';
        const busy = state.status === 'running';
        const hasResult = state.status === 'ready' || state.status === 'adopted';
        const failed = state.status === 'error';
        // The result only belongs to the draft it produced: once the composer
        // holds that exact text the button is a show/hide control, and any other
        // draft starts a new run.
        const reviewing = hasResult && text !== '' && text === String(state.result ?? '').trim();

        // Publish the composer's own actions so the dock card can write back too,
        // even when it is mounted with a different prop set.
        React.useEffect(() => {
          store.setWriter({ inputActions: props.inputActions, sessionId: props.sessionId });
          return () => store.clearWriter();
        }, [props.inputActions, props.sessionId]);

        const onClick = React.useCallback((event) => {
          if (busy) {
            store.cancel();
            return;
          }
          if (reviewing) {
            store.toggleVisible();
            return;
          }
          const forceDirect = event !== null && typeof event === 'object' && (event.shiftKey === true || event.altKey === true);
          void store.start(text, props.sessionId, { direct: forceDirect, composer });
        }, [busy, reviewing, text, props.sessionId, composerKey(composer)]);

        const label = busy
          ? t('action.busy', '优化中')
          : reviewing
            ? state.visible === true
              ? t('action.hide', '收起')
              : t('action.view', '查看优化')
            : failed
              ? t('action.retry', '重试')
              : t('action.short', '优化');
        const title = busy
          ? t('tip.busy', '正在改写… 点按钮可取消')
          : reviewing
            ? t('tip.view', '展开或收起优化对比')
            : failed
              ? format(t('tip.failed', '优化失败：{message}（点击重试）'), { message: state.error })
              : text === ''
                ? t('tip.empty', '先在输入框写下你的需求')
                : state.autoWrite === true
                  ? t('tip.idleDirect', '把当前输入改写为结构化的专业提示词，并直接写回输入框')
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
          // The settings page lives in the result card, but the card is hidden
          // until there is something to show. This gear keeps the settings
          // reachable before the very first rewrite.
          h(
            'button',
            {
              key: 'gear',
              type: 'button',
              className: `dsh-po-gear${state.settingsOpen === true ? ' is-on' : ''}`,
              title: t('panel.settings', '设置'),
              'aria-label': t('panel.settings', '设置'),
              'aria-expanded': state.settingsOpen === true,
              onClick: () => store.toggleSettings(),
            },
            h('span', { key: 'glyph', className: 'dsh-po-glyph', 'aria-hidden': true }, '\u2699'),
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
        // The settings panel must be reachable before the first optimization, so
        // it alone is enough to keep the card mounted.
        if (state.settingsOpen !== true && (state.visible !== true || state.status === 'idle')) return null;
        const idle = state.status === 'idle';

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
          h('span', { key: 'title', className: 'dsh-po-title' }, h(Glyph, { key: 'icon' }), idle ? t('panel.settings', '设置') : t('panel.title', '优化结果')),
          h('span', { key: 'meta', className: 'dsh-po-meta' }, running ? t('panel.streaming', '生成中…') : `${state.provider === '' ? '' : state.provider}${state.model === '' ? '' : ` / ${state.model}`}`),
          h('span', { key: 'spacer', className: 'dsh-po-spacer' }),
          h('button', { key: 'settings', type: 'button', className: `dsh-po-ghost${state.settingsOpen === true ? ' is-on' : ''}`, onClick: () => store.toggleSettings(), title: t('panel.settings', '设置'), 'aria-label': t('panel.settings', '设置'), 'aria-pressed': state.settingsOpen === true }, '⚙'),
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
            : h('button', { key: 'primary', type: 'button', className: 'dsh-po-primary', disabled: state.adopted === true, onClick: () => store.adopt({ inputActions: props.inputActions, sessionId: props.sessionId }) }, state.adopted === true ? (state.autoAdopted === true ? t('panel.adoptedAuto', '已直接写入输入框，可直接发送（Ctrl+Z 撤销）') : t('panel.adopted', '已写入输入框（Ctrl+Z 可撤销）')) : t('panel.adopt', '采纳并写入')),
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
          h('button', {
            key: 'autowrite',
            type: 'button',
            className: `dsh-po-ghost${state.autoWrite === true ? ' is-on' : ''}`,
            'aria-pressed': state.autoWrite === true,
            title: t('panel.autoWriteTip', '开着：优化完成就自动写回输入框；关掉：先给你看对比再决定（Shift+点击按钮可临时直接写入）'),
            onClick: () => store.toggleAutoWrite(),
          }, state.autoWrite === true ? t('panel.autoWriteOn', '直接写入：开') : t('panel.autoWriteOff', '直接写入：关')),
          h('span', { key: 'spacer', className: 'dsh-po-spacer' }),
          stats,
        );

        const modelRow = h(
          'div',
          { key: 'model-row', className: 'dsh-po-foot' },
          h('label', { key: 'ml', className: 'dsh-po-note' }, t('panel.model', '模型')),
          state.models.length > 1
            ? h('select', { key: 'ms', className: 'dsh-po-select', value: targetValue, onChange: onModelChange, disabled: running },
                h('option', { key: 'auto', value: '' }, state.composer === null
                  ? t('panel.model.auto', '跟随对话模型')
                  : format(t('panel.model.follow', '跟随对话（{model}）'), { model: `${state.composer.provider} / ${state.composer.model}` })),
                ...state.models.map((item) => h('option', { key: `${item.provider}\u0000${item.model}`, value: `${item.provider}\u0000${item.model}` }, item.label ?? `${item.provider} / ${item.model}`)),
              )
            : h('span', { key: 'mn', className: 'dsh-po-note' }, `${state.provider}${state.model === '' ? '' : ` / ${state.model}`}`),
          h('label', { key: 'tl', className: 'dsh-po-note' }, t('panel.temperature', '温度')),
          h('select', { key: 'ts', className: 'dsh-po-select', value: String(state.temperature), onChange: (event) => store.setTemperature(Number(event?.target?.value)), disabled: running },
            h('option', { key: 'stable', value: '0.2' }, t('panel.temperature.stable', '稳定 0.2')),
            h('option', { key: 'flex', value: '0.7' }, t('panel.temperature.flex', '灵活 0.7')),
          ),
        );

        // The delivery receipt: how many hard anchors from the draft survived.
        const ledger = state.ledger;
        let ledgerText = '';
        let ledgerTip = '';
        const hasLedger = ready && ledger !== null && (ledger.anchors > 0 || ledger.added.length > 0);
        if (hasLedger) {
          if (ledger.anchors > 0) {
            ledgerText = format(t('panel.anchors', '锚点 {kept}/{total} 保留'), { kept: ledger.kept, total: ledger.anchors });
            if (ledger.repaired === true) ledgerText += ' · ' + t('panel.repaired', '已自动补回');
            else if (ledger.missing.length > 0) ledgerText += ' · ' + format(t('panel.anchorsMissing', '缺 {n} 处'), { n: ledger.missing.length });
          } else if (ledger.repaired === true) {
            ledgerText = t('panel.repairedOnly', '已删掉编造内容');
          }
          if (ledger.added.length > 0) {
            const addedText = format(t('panel.added', '补全 {n} 条未见于原文'), { n: ledger.added.length });
            ledgerText = ledgerText === '' ? addedText : ledgerText + ' · ' + addedText;
          }
          const chunkCount = Number(ledger.chunks);
        if (Number.isFinite(chunkCount) && chunkCount > 1) {
          const chunkText = format(t('panel.chunks', '分 {n} 段'), { n: chunkCount });
          ledgerText = ledgerText === '' ? chunkText : ledgerText + ' · ' + chunkText;
        }
        const tips = ledger.missing.slice();
          if (ledger.added.length > 0) {
            tips.push(format(t('panel.addedTip', '新增：{list}'), { list: ledger.added.map((entry) => entry.value).join('、') }));
          }
          ledgerTip = tips.join(' · ');
        }

        const notes = [];
        if (state.copied) notes.push(h('div', { key: 'copied', className: 'dsh-po-note' }, t('panel.adoptedCopy', '当前环境无法写回输入框，已复制到剪贴板')));
        if (hasLedger) notes.push(h('div', { key: 'ledger', className: 'dsh-po-note' + (ledger.missing.length > 0 || ledger.added.some((entry) => entry.risk === 'high') ? ' is-warn' : ''), title: ledgerTip === '' ? undefined : ledgerTip }, ledgerText));
        if (!compatible) notes.push(h('div', { key: 'compat', className: 'dsh-po-note is-warn' }, format(t('panel.compat', '本插件按 DSH ≥ {required} 开发，当前 {current}'), { required: REQUIRED_DSH, current: state.version })));
        if (failed && state.error !== '') notes.push(h('div', { key: 'failed', className: 'dsh-po-note is-error' }, format(t('error.failed', '优化失败：{message}'), { message: state.error })));

        let settingsPanel = null;
        if (state.settingsOpen === true) {
          const settings = state.settings;
          const busy = state.settingsBusy === true;
          const children = [];
          if (settings === null) {
            children.push(
              h('span', { key: 'loading', className: 'dsh-po-note' }, busy ? t('panel.settingsLoading', '读取设置中…') : t('panel.settingsFailed', '设置读取失败')),
              h('button', { key: 'reload', type: 'button', className: 'dsh-po-ghost', onClick: () => store.loadSettings(true) }, t('panel.settingsReload', '重试')),
            );
          } else {
            children.push(
              h('label', { key: 'pl', className: 'dsh-po-note' }, t('panel.preset', '预设')),
              h('select', {
                key: 'pv',
                className: 'dsh-po-select',
                value: settings.preset,
                disabled: busy,
                onChange: (event) => store.setSetting('preset', event?.target?.value),
              }, ...state.settingsPresets.map((item) => h('option', { key: item.id, value: item.id }, t(`preset.${item.id}`, item.label)))),
              h('label', { key: 'cl', className: 'dsh-po-note' }, t('panel.candidates', '候选数')),
              h('select', {
                key: 'cv',
                className: 'dsh-po-select',
                value: String(settings.candidates),
                disabled: busy,
                onChange: (event) => store.setSetting('candidates', Number(event?.target?.value)),
              }, ...[1, 2, 3].map((count) => h('option', { key: `c${count}`, value: String(count) }, String(count)))),
              h('label', { key: 'tl2', className: 'dsh-po-note' }, t('panel.maxTokens', '最大长度')),
              h('select', {
                key: 'tv',
                className: 'dsh-po-select',
                value: String(settings.maxOutputTokens),
                disabled: busy,
                onChange: (event) => store.setSetting('maxOutputTokens', Number(event?.target?.value)),
              }, ...[800, 1600, 2400, 3200].map((tokens) => h('option', { key: `k${tokens}`, value: String(tokens) }, String(tokens)))),
              h('label', { key: 'tpl', className: 'dsh-po-note' }, t('panel.temperature', '温度')),
              h('select', {
                key: 'tpv',
                className: 'dsh-po-select',
                value: String(settings.temperature),
                disabled: busy,
                onChange: (event) => store.setSetting('temperature', Number(event?.target?.value)),
              },
                h('option', { key: 'v02', value: '0.2' }, t('panel.temperature.stable', '稳定 0.2')),
                h('option', { key: 'v05', value: '0.5' }, '0.5'),
                h('option', { key: 'v07', value: '0.7' }, t('panel.temperature.flex', '灵活 0.7')),
                h('option', { key: 'v10', value: '1' }, '1.0'),
              ),
              h('button', { key: 'save', type: 'button', className: 'dsh-po-primary', disabled: busy, onClick: () => store.saveSettings() }, busy ? t('panel.saving', '保存中…') : t('panel.save', '保存')),
              h('button', { key: 'reset', type: 'button', className: 'dsh-po-ghost', disabled: busy, onClick: () => store.resetSettings() }, t('panel.resetDefaults', '恢复默认')),
            );
            if (state.settingsSavedAt > 0 && busy !== true) children.push(h('span', { key: 'saved', className: 'dsh-po-note' }, t('panel.saved', '已保存')));
            children.push(h('span', { key: 'hint', className: 'dsh-po-settings-hint' }, t('panel.settingsHint', '设置存在本机，换浏览器也在；模型仍跟随对话框选择的模型。')));
          }
          if (state.settingsError !== '') children.push(h('span', { key: 'serr', className: 'dsh-po-note is-error' }, state.settingsError));
          settingsPanel = h('div', { key: 'settings', className: 'dsh-po-settings' }, ...children);
        }

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
          settingsPanel,
          idle ? null : h('div', { key: 'body', className: 'dsh-po-body' }, columns),
          ...(idle ? [] : notes),
          idle ? null : footer,
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
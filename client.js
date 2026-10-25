/**
 * Prompt Optimizer — Client half.
 *
 * Adds one compact control to the composer tool row
 * (`conversation.input.right`, just before Send). It reads the current draft
 * through the standard `useInput` prop, posts it to the Host half's
 * authenticated route, and writes the rewrite back as ONE undoable edit
 * (`captureInsertion` + `insertText`), falling back to `setDraft` when the
 * editor refuses the mapped span.
 *
 * The pre-rewrite text is stashed per session, so the control can always offer
 * a one-step revert while the draft still holds the rewrite — across remounts
 * and page reloads.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-optimizer',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SLOT = 'conversation.input.right';
    /** Relative on purpose: an absolute `/api/...` drops any mount sub-path. */
    const ROUTE = 'api/prompt.optimize';
    const NS = 'prompt-optimizer';
    const STASH_PREFIX = 'dsh-prompt-optimizer:revert:';
    const STASH_LIMIT = 10;

    const ZH = {
      'slot.label': '优化提示词',
      'action.idle': '优化提示词',
      'action.busy': '优化中',
      'action.revert': '撤销',
      'action.retry': '重试',
      'tip.idle': '把当前输入改写为结构化的专业提示词',
      'tip.empty': '先在输入框写下你的需求，再点这里改写为专业提示词',
      'tip.busy': '正在用默认模型改写提示词…',
      'tip.revert': '恢复优化前的原文',
      'tip.failed': '优化失败：{message}（点击重试）',
      'error.empty': '模型返回了空结果',
      'error.http': 'HTTP {status}',
      'error.network': '请求失败：{message}',
      'error.write': '改写完成，但无法写回输入框',
    };

    const EN = {
      'slot.label': 'Optimize prompt',
      'action.idle': 'Optimize prompt',
      'action.busy': 'Optimizing',
      'action.revert': 'Undo',
      'action.retry': 'Retry',
      'tip.idle': 'Rewrite the current draft into a well-structured prompt',
      'tip.empty': 'Write what you need first, then click here to rewrite it as a prompt',
      'tip.busy': 'Rewriting with the default model…',
      'tip.revert': 'Restore the text from before the rewrite',
      'tip.failed': 'Optimization failed: {message} (click to retry)',
      'error.empty': 'The model returned an empty result',
      'error.http': 'HTTP {status}',
      'error.network': 'Request failed: {message}',
      'error.write': 'The rewrite succeeded but could not be written back',
    };

    const CSS = [
      '.dsh-po{display:inline-flex;align-items:center;min-width:0;gap:6px}',
      '.dsh-po-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 7px;border:1px solid transparent;border-radius:999px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.7;transition:opacity .12s ease,background .12s ease}',
      '.dsh-po-btn:hover:not(:disabled){opacity:1;background:color-mix(in srgb,currentColor 12%,transparent)}',
      '.dsh-po-btn:disabled{cursor:default;opacity:.32}',
      '.dsh-po-btn.is-active{opacity:1;border-color:color-mix(in srgb,currentColor 32%,transparent)}',
      '.dsh-po-btn.is-busy .dsh-po-icon{animation:dsh-po-spin 1.15s linear infinite}',
      '@keyframes dsh-po-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '.dsh-po-icon{display:block;width:15px;height:15px;flex:0 0 auto}',
      '.dsh-po-label{white-space:nowrap}',
      '.dsh-po-error{max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1;color:#e06767}',
    ].join('');

    function Sparkle() {
      return h(
        'svg',
        {
          className: 'dsh-po-icon',
          viewBox: '0 0 24 24',
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M12 3.5l1.7 4.6 4.6 1.7-4.6 1.7L12 16.1l-1.7-4.6L5.7 9.8l4.6-1.7z' }),
        h('path', { d: 'M18.4 15.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z' }),
      );
    }

    function stashKey(sessionId) {
      return `${STASH_PREFIX}${sessionId === undefined || sessionId === null ? 'default' : String(sessionId)}`;
    }

    function readStash(sessionId) {
      try {
        const raw = window.sessionStorage.getItem(stashKey(sessionId));
        const parsed = raw === null ? null : JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry?.original === 'string' && typeof entry?.optimized === 'string') : [];
      } catch {
        return [];
      }
    }

    function writeStash(sessionId, entries) {
      try {
        window.sessionStorage.setItem(stashKey(sessionId), JSON.stringify(entries.slice(-STASH_LIMIT)));
      } catch {
        /* a disabled session storage must not break prompting */
      }
    }

    /**
     * Write the rewrite back as one undoable edit. `captureInsertion()` gives the
     * editor's own detect-coordinate caret and revision; a collapsed caret means
     * its `end` is the document length, so `[0, end)` is the whole draft. Any
     * other shape falls back to the safe whole-draft replacement.
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

    function makeControl(t, localeService) {
      const Control = function Control({ useInput, inputActions, sessionId }) {
        const draft = useInput((state) => (state === undefined ? '' : state.draft ?? ''));
        const [status, setStatus] = React.useState('idle');
        const [error, setError] = React.useState('');
        const [revert, setRevert] = React.useState(null);
        const [, bumpLocale] = React.useReducer((count) => count + 1, 0);
        const alive = React.useRef(true);

        React.useEffect(
          () => () => {
            alive.current = false;
          },
          [],
        );

        React.useEffect(() => {
          if (typeof localeService?.subscribe !== 'function') return undefined;
          return localeService.subscribe(() => bumpLocale());
        }, []);

        React.useEffect(() => {
          const top = readStash(sessionId).at(-1);
          if (top !== undefined && top.optimized === draft) setRevert(top);
          // Restore the pending revert once, on mount.
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        const canWrite = typeof inputActions?.setDraft === 'function' || typeof inputActions?.insertText === 'function';
        const text = draft.trim();
        const canRevert = revert !== null && draft === revert.optimized;
        const busy = status === 'busy';

        const restore = React.useCallback(() => {
          if (revert === null) return;
          const entries = readStash(sessionId);
          if (entries.at(-1)?.optimized === revert.optimized) writeStash(sessionId, entries.slice(0, -1));
          inputActions.setDraft(revert.original);
          setRevert(null);
          setStatus('idle');
          setError('');
        }, [revert, sessionId, inputActions]);

        const run = React.useCallback(async () => {
          if (!canWrite || text === '') return;
          setStatus('busy');
          setError('');
          try {
            const response = await fetch(new URL(ROUTE, document.baseURI).toString(), {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text }),
            });
            let payload = null;
            try {
              payload = await response.json();
            } catch {
              payload = null;
            }
            if (!alive.current) return;
            if (!response.ok) {
              const detail = typeof payload?.error === 'string' && payload.error !== '' ? payload.error : t('error.http', 'HTTP {status}').replace('{status}', String(response.status));
              throw new Error(detail);
            }
            const optimized = typeof payload?.text === 'string' ? payload.text : '';
            if (optimized.trim() === '') throw new Error(t('error.empty', 'The model returned an empty result'));
            if (!applyDraft(inputActions, optimized)) throw new Error(t('error.write', 'Could not write the rewrite back'));
            const entry = { original: draft, optimized };
            writeStash(sessionId, [...readStash(sessionId), entry]);
            setRevert(entry);
            setStatus('idle');
            setError('');
          } catch (cause) {
            if (!alive.current) return;
            const message = cause instanceof Error ? cause.message : String(cause);
            console.error('[prompt-optimizer]', cause);
            setStatus('error');
            setError(message);
          }
        }, [canWrite, text, draft, sessionId, inputActions, t]);

        const label = busy
          ? t('action.busy', '优化中')
          : canRevert
            ? t('action.revert', '撤销')
            : status === 'error'
              ? t('action.retry', '重试')
              : '';
        const title = busy
          ? t('tip.busy', '正在用默认模型改写提示词…')
          : canRevert
            ? t('tip.revert', '恢复优化前的原文')
            : status === 'error'
              ? t('tip.failed', '优化失败：{message}（点击重试）').replace('{message}', error)
              : text === ''
                ? t('tip.empty', '先在输入框写下你的需求')
                : t('tip.idle', '把当前输入改写为结构化的专业提示词');

        return h(
          'div',
          { className: 'dsh-po' },
          h('style', { key: 'style' }, CSS),
          status === 'error' && error !== ''
            ? h('span', { key: 'error', className: 'dsh-po-error', title: `${t('tip.failed', '优化失败：{message}').replace('{message}', error)}` }, error)
            : null,
          h(
            'button',
            {
              key: 'button',
              type: 'button',
              className: `dsh-po-btn${busy ? ' is-busy' : ''}${canRevert ? ' is-active' : ''}`,
              title,
              'aria-label': canRevert ? t('tip.revert', '恢复优化前的原文') : t('action.idle', '优化提示词'),
              'aria-busy': busy,
              disabled: busy || !canWrite || (canRevert ? false : text === ''),
              onClick: canRevert ? restore : run,
            },
            h(Sparkle, { key: 'icon' }),
            label === '' ? null : h('span', { key: 'label', className: 'dsh-po-label' }, label),
          ),
        );
      };
      return Control;
    }

    /** Guarded entry: the standard input props are absent outside a live composer. */
    function makeEntry(Control) {
      return function PromptOptimizer(props) {
        if (typeof props?.useInput !== 'function' || props?.inputActions === undefined) return null;
        return h(Control, props);
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

        const Control = makeControl(t, localeService);
        const Entry = makeEntry(Control);

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

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'prompt-optimizer',
              order: 20,
              label: () => t('slot.label', '优化提示词'),
            },
            Entry,
          ),
        );
      },
    };
  },
});

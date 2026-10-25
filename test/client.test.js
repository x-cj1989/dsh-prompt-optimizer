/**
 * Loads `client.js` in a fake browser shell and exercises the parts that can be
 * checked without a renderer: module registration, slot wiring, locale
 * dictionaries, the pure diff/SSE/version helpers and the adopt→undo path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
  };
}

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => undefined,
  useReducer: (reducer, initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
};

let loaded = null;
const windowMock = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  __DSH_BOOT__: { version: '0.2.1-rc.3' },
};

globalThis.__DSH_TEST__ = true;
globalThis.window = windowMock;
globalThis.document = {
  baseURI: 'http://127.0.0.1:1234/',
  createElement: () => ({ style: {}, select() {}, setAttribute() {} }),
  body: { appendChild() {}, removeChild() {} },
  execCommand: () => true,
};
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => undefined } },
    configurable: true,
    writable: true,
  });
} catch {
  /* a read-only navigator is fine: copyText is not exercised here */
}

await import(new URL('../client.js', import.meta.url).href);

const internals = () => globalThis.__dshPromptOptimizer;

function applyClient() {
  const injected = [];
  const registered = [];
  const effects = [];
  const localeDicts = [];
  const localeService = {
    bind: () => undefined,
    register: (namespace, id, dict) => {
      localeDicts.push({ namespace, id, dict });
      return () => {};
    },
    subscribe: () => () => {},
  };
  const ctx = {
    get: (name) => (name === 'locale' ? localeService : undefined),
    effect: (factory) => {
      effects.push(factory);
      return () => {};
    },
    slots: {
      inject: (name, fn) => injected.push({ name, fn }),
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  const client = loaded.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`unexpected require: ${id}`);
  });
  client.apply(ctx);
  for (const factory of effects) factory();
  for (const entry of injected) entry.fn();
  return { injected, registered, localeDicts, store: globalThis.__dshPromptOptimizer.store };
}

function walk(node, visit) {
  if (typeof node === 'string') {
    visit(node);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  // The fake createElement does not render, so function components are called
  // here; the stubbed hooks are pure enough for one render pass.
  if (typeof node.type === 'function') {
    walk(node.type(node.props ?? {}), visit);
    return;
  }
  for (const child of node.children ?? []) walk(child, visit);
}

function collect(node, predicate) {
  const found = [];
  walk(node, (candidate) => {
    if (predicate(candidate)) found.push(candidate);
  });
  return found;
}

test('the client half registers under the bundle id', () => {
  assert.equal(loaded.id, '@local/dsh-prompt-optimizer');
  assert.equal(typeof loaded.factory, 'function');
});

test('the client half injects only the slots service', () => {
  const client = loaded.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`unexpected require: ${id}`);
  });
  assert.deepEqual(client.inject, ['slots']);
  assert.equal(typeof client.apply, 'function');
});

test('apply registers the composer control, the preview card and both locales', () => {
  const { injected, registered, localeDicts } = applyClient();
  assert.deepEqual(injected.map((entry) => entry.name), ['conversation.input.right', 'conversation.composer.dock']);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].options.id, 'prompt-optimizer');
  assert.equal(registered[0].options.order, 20);
  assert.equal(registered[1].options.id, 'prompt-optimizer-preview');
  assert.equal(registered[0].options.label(), '优化提示词');
  assert.equal(localeDicts.length, 2);
  assert.deepEqual(localeDicts.map((entry) => entry.id).sort(), ['en', 'zh']);
  for (const entry of localeDicts) {
    assert.equal(entry.namespace, 'prompt-optimizer');
    assert.equal(typeof entry.dict['panel.adopt'], 'string');
    assert.equal(typeof entry.dict['error.failed'], 'string');
  }
});

test('the composer control keeps the sparkle mark and a readable label', () => {
  const { registered } = applyClient();
  const Control = registered[0].component;
  const element = Control({
    useInput: (selector) => selector({ draft: '写个周报' }),
    inputActions: { setDraft() {} },
  });
  const button = collect(element, (node) => node.type === 'button')[0];
  const texts = collect(button, (node) => typeof node === 'string');
  assert.ok(texts.includes('\u2728'), `the sparkle glyph is missing: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('优化'), `the button label is missing: ${JSON.stringify(texts)}`);
});

test('the composer control renders and gates on an empty draft', () => {
  const { registered } = applyClient();
  const Control = registered[0].component;
  assert.equal(Control({}), null);

  const element = Control({
    useInput: (selector) => selector({ draft: '写个周报' }),
    inputActions: { setDraft() {} },
  });
  assert.equal(element.type, 'div');
  assert.match(element.props.className, /dsh-po/);
  const buttons = collect(element, (node) => node.type === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, false);

  const empty = Control({ useInput: (selector) => selector({ draft: '   ' }), inputActions: { setDraft() {} } });
  const emptyButtons = collect(empty, (node) => node.type === 'button');
  assert.equal(emptyButtons[0].props.disabled, true);
});

test('the preview card stays out of the layout until there is a result', () => {
  const { registered, store } = applyClient();
  const Preview = registered[1].component;
  assert.equal(Preview({}), null);
  assert.equal(Preview({ useInput: (selector) => selector({ draft: '' }), inputActions: {} }), null);

  store.patch({ status: 'ready', visible: true, source: 'a\nb', result: 'a\nc', provider: 'p', model: 'm' });
  const card = Preview({ useInput: (selector) => selector({ draft: '' }), inputActions: {} });
  assert.equal(card.type, 'div');
  assert.match(card.props.className, /dsh-po-card/);
  const text = collect(card, (node) => typeof node === 'string').join(' ');
  assert.match(text, /采纳并写入/);
});

test('adopting writes one undoable edit and undo restores the original', () => {
  const { store } = applyClient();
  const calls = [];
  const inputActions = {
    captureInsertion: () => ({ start: 12, end: 12, draftRev: 3 }),
    insertText: (text, span) => {
      calls.push({ kind: 'insertText', text, span });
      return true;
    },
    setDraft: (text) => calls.push({ kind: 'setDraft', text }),
  };

  store.patch({ status: 'ready', visible: true, source: '写个周报', result: '# 角色\n写周报' });
  store.adopt({ inputActions, sessionId: 'session-1' });
  assert.equal(store.get().status, 'adopted');
  assert.deepEqual(calls[0], { kind: 'insertText', text: '# 角色\n写周报', span: { start: 0, end: 12, draftRev: 3 } });

  store.undo({ inputActions, sessionId: 'session-1' });
  assert.deepEqual(calls[1], { kind: 'setDraft', text: '写个周报' });
  assert.equal(store.get().status, 'ready');
});

test('adoption falls back to setDraft when the editor refuses the span', () => {
  const { store } = applyClient();
  const calls = [];
  const inputActions = {
    captureInsertion: () => ({ start: 1, end: 4, draftRev: 3 }),
    insertText: () => false,
    setDraft: (text) => calls.push(text),
  };
  store.patch({ status: 'ready', visible: true, source: 'old', result: 'new' });
  store.adopt({ inputActions, sessionId: 's' });
  assert.deepEqual(calls, ['new']);
  assert.equal(store.get().status, 'adopted');
});

test('lineDiff pairs changed lines and counts them', () => {
  const diff = internals().lineDiff('# 角色\n写周报\n要求：简洁', '# 角色\n写一份周报\n要求：简洁、可执行');
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  const same = internals().lineDiff('same\ntext', 'same\ntext');
  assert.equal(same.added, 0);
  assert.equal(same.removed, 0);
  assert.ok(same.rows.every((row) => row.changed === false));
});

test('lineDiff keeps unpaired insertions and deletions visible', () => {
  const diff = internals().lineDiff('a', 'a\nb\nc');
  assert.equal(diff.added, 2);
  const right = diff.rows.filter((row) => row.changed).map((row) => row.right);
  assert.deepEqual(right, ['b', 'c']);
});

test('countChars counts code points, not UTF-16 units', () => {
  assert.equal(internals().countChars('周报'), 2);
  assert.equal(internals().countChars('📝'), 1);
  assert.equal(internals().countChars(''), 0);
});

test('the SSE parser reassembles frames split across chunks', () => {
  const events = [];
  const feed = internals().createSseParser((event) => events.push(event));
  feed('data: {"type":"delta","text":"你');
  feed('好"}\n\ndata: {"type":"done","text":"你好"}\n\n');
  assert.deepEqual(events, [{ type: 'delta', text: '你好' }, { type: 'done', text: '你好' }]);
});

test('the SSE parser ignores comments, keep-alives and [DONE]', () => {
  const events = [];
  const feed = internals().createSseParser((event) => events.push(event));
  feed(': ping\n\ndata: [DONE]\n\ndata: not-json\n\ndata: {"type":"delta","text":"x"}\n\n');
  assert.deepEqual(events, [{ type: 'delta', text: 'x' }]);
});

test('isCompatible compares dotted versions and trusts unknown ones', () => {
  assert.equal(internals().isCompatible('0.2.1-rc.3', '0.2.0'), true);
  assert.equal(internals().isCompatible('0.1.9', '0.2.0'), false);
  assert.equal(internals().isCompatible('1.0.0', '0.2.0'), true);
  assert.equal(internals().isCompatible('', '0.2.0'), true);
  assert.equal(internals().isCompatible('0.2.0', '0.2.0'), true);
});

test('applyDraft is a no-op when the composer exposes no writer', () => {
  assert.equal(internals().applyDraft({}, 'text'), false);
  assert.equal(internals().applyDraft(undefined, 'text'), false);
});

function stubFetch(text) {
  return async (input, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ models: [], default: null }) };
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ text, provider: 'provider-a', model: 'model-b' }) };
  };
}

async function withFetch(text, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(text);
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('direct write-back is on by default and can be turned off', () => {
  window.localStorage.removeItem('dsh-prompt-optimizer:auto-write');
  const { store } = applyClient();
  assert.equal(store.get().autoWrite, true);
  store.setAutoWrite(false);
  assert.equal(store.get().autoWrite, false);
  assert.equal(window.localStorage.getItem('dsh-prompt-optimizer:auto-write'), 'false');
  store.setAutoWrite(true);
  assert.equal(window.localStorage.getItem('dsh-prompt-optimizer:auto-write'), 'true');
});

test('the writer published by the composer control is used without props', () => {
  const { store } = applyClient();
  const calls = [];
  store.setWriter({ inputActions: { setDraft: (text) => calls.push(text) }, sessionId: 's1' });
  store.patch({ status: 'ready', visible: true, source: 'old', result: 'new' });
  assert.equal(store.adopt(), true);
  assert.deepEqual(calls, ['new']);
  assert.equal(store.get().status, 'adopted');
  store.undo();
  assert.deepEqual(calls, ['new', 'old']);
  assert.equal(store.get().status, 'ready');
});

test('a finished run lands in the composer by itself when direct write is on', async () => {
  const { store } = applyClient();
  const written = [];
  store.setWriter({ inputActions: { setDraft: (text) => written.push(text) }, sessionId: 's2' });
  store.setAutoWrite(true);
  await withFetch('# 角色\n写一份周报', () => store.start('写个周报', 's2'));
  assert.equal(store.get().status, 'adopted');
  assert.equal(store.get().autoAdopted, true);
  // Direct write-back needs no decision, so the review panel stays closed and
  // the user opens it only when they want to look at the diff.
  assert.equal(store.get().visible, false);
  assert.deepEqual(written, ['# 角色\n写一份周报']);
});

test('review mode waits for a click, Shift+click writes directly for one run', async () => {
  const { store } = applyClient();
  const written = [];
  store.setWriter({ inputActions: { setDraft: (text) => written.push(text) }, sessionId: 's3' });
  store.setAutoWrite(false);
  await withFetch('改好的提示词', () => store.start('写个周报', 's3'));
  assert.equal(store.get().status, 'ready');
  // Review mode still opens the panel: the user has to choose 采纳 / 放弃.
  assert.equal(store.get().visible, true);
  assert.deepEqual(written, []);

  await withFetch('改好的提示词', () => store.start('写个周报', 's3', { direct: true }));
  assert.equal(store.get().status, 'adopted');
  assert.equal(store.get().visible, false);
  assert.deepEqual(written, ['改好的提示词']);

  store.toggleVisible();
  assert.equal(store.get().visible, true);
  store.toggleVisible();
  assert.equal(store.get().visible, false);
});


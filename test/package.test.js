import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { VERSION } from '../index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFile(join(ROOT, relative), 'utf8');

const manifest = JSON.parse(await read('package.json'));

test('package.json version matches the exported VERSION', () => {
  assert.equal(manifest.version, VERSION);
});

test('the bundle declares the DSH host and client halves', () => {
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-conversation']);
  assert.equal(manifest.exports['.'], './index.js');
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.exports['./icon'], './icon.svg');
});

test('the published file list covers both halves and the docs', () => {
  for (const entry of ['index.js', 'client.js', 'lib', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'CHANGELOG.md']) {
    assert.ok(manifest.files.includes(entry), `files[] is missing ${entry}`);
  }
});

test('the loader patch inserts the package under its manifest name', async () => {
  const patch = await read(manifest.dsh.bundle.patch.replace('./', ''));
  assert.match(patch, /insert:/);
  assert.ok(patch.includes(manifest.name), 'cordis.patch.yml must reference the package name');
});

test('both locale files parse and describe the plugin', async () => {
  for (const id of ['en', 'zh']) {
    const dict = JSON.parse(await read(`locale/${id}.json`));
    assert.equal(typeof dict.meta.title, 'string');
    assert.equal(typeof dict.meta.description, 'string');
    assert.ok(dict.meta.title.length > 0);
  }
});

test('the icon is an svg document', async () => {
  const icon = await read('icon.svg');
  assert.match(icon, /^<svg[\s>]/);
  assert.match(icon, /viewBox="0 0 64 64"/);
});

test('the README documents install, privacy, compatibility and tests', async () => {
  const readme = await read('README.md');
  for (const needle of ['## 安装', '## 隐私', '## 兼容性', '## 开发与测试', 'npm test']) {
    assert.ok(readme.includes(needle), `README is missing the ${needle} section`);
  }
});

test('the test script runs the node test runner', () => {
  assert.match(manifest.scripts.test, /node --test/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { managedBrowserExecutable, browserDir } from '../dist/browser-install.js';
import { BrowserRuntime } from '../dist/browser.js';
import { parseOptions } from '../dist/options.js';
import { fixture, temporaryDirectory } from './helpers.mjs';

test('private Chromium install is reusable, concurrent calls share it, and it serves a real page', async t => {
  const [first, second] = await Promise.all([managedBrowserExecutable(), managedBrowserExecutable()]);
  assert.equal(first, second);
  assert.ok(first.startsWith(browserDir + '/'));
  assert.equal(browserDir, join(dirname(dirname(fileURLToPath(import.meta.url))), '.playwright-browsers'));
  await access(first);
  const temp = await temporaryDirectory(), site = await fixture();
  const runtime = new BrowserRuntime(parseOptions({ profilesDir: temp.path, headless: true, browserMode: 'managed' }), site.url);
  t.after(async () => { await runtime.close(); await site.close(); await temp.close(); });
  const { profileId } = await runtime.beginLogin();
  assert.equal((await runtime.waitLogin(profileId)).authenticated, true);
});

test('missing external browser cache is reported without downloading or changing it', async () => {
  const temp = await temporaryDirectory();
  try {
    const cli = fileURLToPath(new URL('../dist/install-browser-cli.js', import.meta.url));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: temp.path } });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('exit', code => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Configured Playwright cache is missing Chromium/);
  } finally { await temp.close(); }
});

test('keep-open missing configured executable has actionable browser_missing error', async t => {
  const temp = await temporaryDirectory(), site = await fixture();
  const runtime = new BrowserRuntime(parseOptions({ profilesDir: temp.path, executablePath: join(temp.path, 'missing-browser'), headless: true }), site.url);
  t.after(async () => { await runtime.close(); await site.close(); await temp.close(); });
  await assert.rejects(runtime.beginLogin(), error => error.code === 'browser_missing' && /executablePath/.test(error.message));
});

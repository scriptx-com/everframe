// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Real mounted React, Chromium and IndexedDB; controlled HTTP receiver.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
let bundle, online = false;
const attempts = [], accepted = [], checks = [];
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); return; }
  if (req.url === '/api/ingest/release-health') {
    let body = ''; for await (const part of req) body += part;
    const entry = { key: req.headers.authorization, record: JSON.parse(body) };
    attempts.push(entry); if (online) accepted.push(entry);
    res.writeHead(online ? 201 : 503, { 'Content-Type': 'application/json' }); res.end('{}'); return;
  }
  if (req.url?.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end('{"replayEnabled":false,"vitalsEnabled":false}'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><div id="root"></div><script type="module">import * as host from "/bundle.js";window.host=host;</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const result = await build({ entryPoints: [resolve('tests/release-health-host.tsx')], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
    alias: { '@everframe/web/ui': resolve('../sdk-web/src/ui.ts'), '@everframe/web': resolve('../sdk-web/src/index.ts'),
      '@everframe/sdk-core': resolve('../sdk-core/src/index.ts'), '@everframe/protocol': resolve('../protocol/src/index.ts') },
    define: { __EVERFRAME_INGEST_URL__: JSON.stringify(endpoint), 'process.env.NODE_ENV': '"development"' } });
  bundle = result.outputFiles[0].text;
  await writeFile(resolve(output, 'bundle.js'), bundle);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); const page = await context.newPage();
  const browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  async function load() { await page.goto(endpoint); await page.waitForFunction(() => !!window.host); }
  async function mount(options) { await page.evaluate(options => window.host.mount(options), options); }
  async function waitRecords(tab, n) {
    const deadline = Date.now() + 5000; let rows;
    do { rows = await tab.evaluate(() => window.host.records()); if (rows.length === n) return rows; await tab.waitForTimeout(20); } while (Date.now() < deadline);
    assert.equal(rows.length, n, 'durable exposure record count'); return rows;
  }
  const queued = n => waitRecords(page, n);
  async function settle() { await page.waitForTimeout(150); }
  await load(); await mount({ health: true, build: 'build-A', mutateOnMount: true });
  const [first] = await queued(1);
  assert.equal(first.exposure.loadedBuildId, 'build-A');
  await page.evaluate(() => { window.host.identify(); window.host.rerender(); });
  await settle(); assert.equal((await queued(1))[0].recordId, first.recordId);
  await page.evaluate(() => window.host.unmount()); await queued(2);
  await load(); online = true; await mount({ health: true, build: 'build-B' }); await queued(0);
  const old = accepted.filter(row => row.record.exposure.exposureId === first.exposure.exposureId);
  assert.equal(old.length, 2); assert(old.every(row => row.key === 'Bearer pk_test_a' && row.record.exposure.loadedBuildId === 'build-A'));
  assert.equal(accepted.length, 3);
  assert.notEqual(accepted[2].record.exposure.pageLaunchId, first.exposure.pageLaunchId);
  checks.push('committed-provider-replay-vitals-off', 'frozen-config-before-child-effects', 'rerender-no-rotation', 'anonymous', 'offline-unmount-reload-original-owner');

  // Privacy kill erases the current route; normal remount never replays it.
  online = false; await page.evaluate(() => window.host.unmount()); await queued(1);
  await load(); await mount({ health: true, build: 'erased' }); await queued(2);
  await page.evaluate(() => window.host.kill()); await queued(0);
  await page.evaluate(() => window.host.unmount()); await load();
  const count = accepted.length; online = true; await mount({ health: true, build: 'after-kill' });
  await queued(0);
  await settle(); assert.equal(accepted.length, count + 1); assert.equal(accepted.at(-1).record.exposure.loadedBuildId, 'after-kill');
  checks.push('kill-purge-and-reenable');
  await context.close();

  for (const scenario of ['strict', 'child-kill', 'strict-child-kill', 'absent', 'disabled', 'storage-denied']) {
    const isolated = await browser.newContext(); const tab = await isolated.newPage();
    tab.on('pageerror', error => browserErrors.push(error.message));
    if (scenario === 'storage-denied') await tab.addInitScript(() => {
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function(name, ...args) {
        if (name === 'everframe-release-health-v1') throw new DOMException('Denied storage', 'SecurityError');
        return original.call(this, name, ...args);
      };
    });
    const before = accepted.length;
    await tab.goto(endpoint); await tab.waitForFunction(() => !!window.host);
    await tab.evaluate(scenario => window.host.mount({ build: scenario, strict: scenario === 'strict' || scenario === 'strict-child-kill',
      killOnMount: scenario === 'child-kill' || scenario === 'strict-child-kill', health: scenario === 'absent' ? undefined : scenario !== 'disabled' }), scenario);
    if (scenario === 'strict') {
      await waitRecords(tab, 0);
      await tab.waitForTimeout(200); assert.equal(accepted.length, before + 1);
      await tab.evaluate(() => window.host.kill());
    } else {
      await tab.waitForTimeout(200); assert.equal(accepted.length, before, scenario);
      assert.equal(await tab.locator('#alive').count(), 1);
    }
    await tab.evaluate(() => window.host.unmount()); await isolated.close(); checks.push(scenario);
  }
  // A different key cannot deliver the earlier key's frozen queue; explicit disabled consent purges it.
  const routes = await browser.newContext(); const tab = await routes.newPage();
  await tab.goto(endpoint); await tab.waitForFunction(() => !!window.host); online = false;
  await tab.evaluate(() => window.host.mount({ apiKey: 'pk_route_a', health: true, build: 'route-A' }));
  await waitRecords(tab, 1);
  await tab.evaluate(() => window.host.unmount()); await waitRecords(tab, 2);
  const beforeRoute = accepted.length; online = true;
  await tab.evaluate(() => window.host.mount({ apiKey: 'pk_route_b', health: true, build: 'route-B' }));
  await tab.waitForTimeout(200); assert.equal(accepted.length, beforeRoute + 1); assert.equal(accepted.at(-1).key, 'Bearer pk_route_b');
  await tab.evaluate(() => { window.host.unmount(); window.host.mount({ apiKey: 'pk_route_a', health: false }); });
  await tab.waitForTimeout(200);
  const remaining = await tab.evaluate(() => window.host.records());
  assert(remaining.every(row => row.exposure.loadedBuildId === 'route-B'));
  await routes.close(); checks.push('key-isolation-and-disabled-purge');
  assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
  for (const { record } of attempts) {
    assert.equal(record.exposure.subject, 'anonymous_exposure');
    assert(!JSON.stringify(record).includes('must-not-enter-health'));
    for (const key of ['outcome', 'user', 'identityToken', 'sessionId']) assert(!(key in record));
  }
  await writeFile(resolve(output, 'proof.json'), JSON.stringify({ browser: await browser.version(), checks, attempts, accepted,
    bundleSha256: createHash('sha256').update(bundle).digest('hex') }, null, 2));
  console.log(`PASS: ${checks.length} actual React/IndexedDB lifecycle checks; ${accepted.length} accepted records`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }

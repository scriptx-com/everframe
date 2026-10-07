// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Real Chromium/IndexedDB proof. The HTTP receiver is a controllable fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const received = [];
let offline = true;
let bundle;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); return; }
  if (req.url === '/api/ingest/release-health') {
    let body = ''; for await (const part of req) body += part;
    if (offline) { res.writeHead(503); res.end('{}'); return; }
    received.push({ key: req.headers.authorization, record: JSON.parse(body) });
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{}'); return;
  }
  if (req.url?.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ replayEnabled: false, vitalsEnabled: false })); return; }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><title>Exposure proof</title><script type="module">import * as sdk from "/bundle.js"; window.sdk=sdk;</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const result = await build({ stdin: { contents: 'export {init} from "./src/init.ts"; export * from "./src/release-health/journal.ts";', resolveDir: process.cwd() },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    alias: { '@everframe/sdk-core': resolve('../sdk-core/src/index.ts'), '@everframe/protocol': resolve('../protocol/src/index.ts') },
    define: { __EVERFRAME_INGEST_URL__: JSON.stringify(base), 'process.env.NODE_ENV': '"production"' } });
  bundle = result.outputFiles[0].text; await writeFile(resolve(output, 'bundle.js'), bundle);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); const page = await context.newPage();
  async function load() { await page.goto(base); await page.waitForFunction(() => !!window.sdk); }
  async function start(build, key = 'pk_test_a', extra = {}) {
    return page.evaluate(async ({ build, key, extra }) => {
      window.handle = window.sdk.init({ apiKey: key, vitals: { enabled: false },
        releaseHealth: { enabled: true, loadedBuildId: build }, ...extra });
      await window.handle.releaseHealth.ready;
      return window.handle.releaseHealth.diagnostics();
    }, { build, key, extra });
  }
  await load();
  const first = await start('build-A'); assert.equal(first.state, 'active'); assert.equal(first.queued, 1);
  const firstToken = first.exposure;
  await page.evaluate(async () => { window.handle.destroy(); await new Promise(r => setTimeout(r, 100)); });
  await load(); offline = false;
  const second = await start('build-B');
  await page.evaluate(() => window.handle.releaseHealth.flush());
  const old = received.filter(row => row.record.exposure.exposureId === firstToken.exposureId);
  assert.equal(old.length, 2); assert(old.every(row => row.record.exposure.loadedBuildId === 'build-A'));
  assert.equal(second.exposure.loadedBuildId, 'build-B'); assert.notEqual(second.exposure.pageLaunchId, firstToken.pageLaunchId);
  assert(!received.some(row => 'outcome' in row.record));
  // The next project must not drain a prior project's frozen route.
  offline = true; await page.evaluate(() => window.handle.destroy()); await load();
  await start('private-to-A'); await page.evaluate(() => window.handle.destroy()); await load();
  const beforeB = received.length; offline = false; await start('build-C', 'pk_test_b');
  await page.evaluate(() => window.handle.releaseHealth.flush());
  assert(received.slice(beforeB).every(row => row.key === 'Bearer pk_test_b'));
  // Privacy kill purges and invalidates this route, including pending startup.
  offline = true; await page.evaluate(async () => {
    window.handle.kill(); await new Promise(r => setTimeout(r, 100));
  });
  assert.equal((await page.evaluate(() => window.handle.releaseHealth.diagnostics())).queued, 0);
  await page.evaluate(() => window.handle.destroy()); await load();
  const beforeDisabled = received.length; offline = false;
  await start('disabled', 'pk_test_a', { disabled: true });
  await page.evaluate(() => window.handle.releaseHealth.flush());
  assert.equal(received.length, beforeDisabled);
  assert.equal((await page.evaluate(() => window.handle.releaseHealth.diagnostics())).queued, 0);
  // Two real tabs share the same IndexedDB transactions and bounded global budget.
  const isolated = await browser.newContext();
  const left = await isolated.newPage(), right = await isolated.newPage();
  for (const tab of [left, right]) { await tab.goto(base); await tab.waitForFunction(() => !!window.sdk); }
  async function fill(tab, count) {
    return tab.evaluate(async count => {
      const j = await window.sdk.openReleaseHealthJournal();
      const { generation } = await j.activate('capacity-proof');
      const now = new Date().toISOString();
      const make = () => ({ schemaVersion: 1, recordId: crypto.randomUUID(), phase: 'start', sequence: 0, elapsedMs: 0, capturedAt: now,
        exposure: { exposureId: crypto.randomUUID(), pageLaunchId: crypto.randomUUID(), startedAt: now, platform: 'web', sdkVersion: 'test',
          nativeRelease: 'not_applicable', loadedBuildId: null, subject: 'anonymous_exposure',
          coverage: { policy: 'web-page-v1', sampleRate: 1, priorQueueLosses: 0 } } });
      const results = await Promise.all(Array.from({length:count}, () => j.append('capacity-proof', generation, make()).then(() => true, () => false)));
      j.close(); return results.filter(Boolean).length;
    }, count);
  }
  const accepted = await Promise.all([fill(left, 130), fill(right, 130)]);
  assert.equal(accepted[0] + accepted[1], 256);
  const boundaries = await left.evaluate(async () => {
    const j = await window.sdk.openReleaseHealthJournal(); const active = await j.activate('capacity-proof');
    const before = await j.list('capacity-proof', active.generation); const record = before.rows[0].record;
    await j.append('capacity-proof', active.generation, record); // exact replay consumes nothing
    let conflict; try { await j.append('capacity-proof', active.generation, { ...record, exposure: { ...record.exposure, loadedBuildId: 'changed' } }); }
    catch (e) { conflict = e.code; }
    await j.revoke('capacity-proof');
    let stale; try { await j.append('capacity-proof', active.generation, record); } catch (e) { stale = e.code; }
    const next = await j.activate('capacity-proof');
    await j.append('capacity-proof', next.generation, record, Date.now() - 8 * 86400000);
    const after = await j.list('capacity-proof', next.generation);
    await j.revoke('capacity-proof');
    const future = Date.now() + 9 * 86400000;
    await j.activate('cleanup-route', future); await j.activate('capacity-proof', future);
    let retiredGeneration; try { await j.append('capacity-proof', active.generation, record, future); } catch (e) { retiredGeneration = e.code; }
    j.close(); return { retiredGeneration, before: before.rows.length, losses: before.losses, conflict, stale, after: after.rows.length, afterLosses: after.losses };
  });
  assert.deepEqual(boundaries, { retiredGeneration: 'revoked', before: 256, losses: 4, conflict: 'conflict', stale: 'revoked', after: 0, afterLosses: 5 });
  // Immediate kill races the asynchronous route hash/database open/start append.
  await page.evaluate(() => window.handle.destroy()); await load();
  const beforeImmediateKill = received.length;
  await page.evaluate(async () => {
    window.handle = window.sdk.init({ apiKey: 'pk_test_kill', releaseHealth: { enabled: true, loadedBuildId: 'never-sent' } });
    window.handle.kill(); await window.handle.releaseHealth.ready; await window.handle.releaseHealth.flush();
  });
  assert.equal(received.length, beforeImmediateKill);
  await writeFile(resolve(output, 'proof.json'), JSON.stringify({ browser: await browser.version(), received,
    checks: ['actual-init-replay-vitals-off','offline-reload-frozen-build','fresh-page-launch','cross-project-route', 'privacy-kill', 'disabled-purge', 'concurrent-tabs-budget', 'immutable-duplicate', 'stale-generation', 'expiry-loss', 'immediate-kill'] }, null, 2));
  console.log('PASS: actual init, real IndexedDB, offline reload, frozen build/route, privacy kill and disabled purge');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }

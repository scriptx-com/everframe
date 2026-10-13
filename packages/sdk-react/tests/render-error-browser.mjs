// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real Chromium, real React root, controlled ingest receiver. An error that no
// error boundary catches while rendering (or in an effect) must arrive as one
// fatal crash with React's component stack, and must survive a failed send
// and a reload. A press-handler error stays a non-fatal error; an error a
// boundary inside the provider catches is not reported.
//
//   node tests/render-error-browser.mjs <output-dir> [--react-root <dir>]
//
// `--react-root` points at a directory whose node_modules hold another React
// (for example `npm i react@18.3.1 react-dom@18.3.1` there); the default is
// this workspace's React. Each run covers the production and development
// builds of React.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const output = resolve(args[0] ?? 'render-error-proof');
const reactRootArg = args.indexOf('--react-root');
const reactRoot = reactRootArg === -1 ? undefined : resolve(args[reactRootArg + 1]);
await mkdir(output, { recursive: true });

let bundle = '';
let ingestStatus = 200;
const envelopes = [];
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle);
    return;
  }
  if (req.url === '/api/ingest') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Request('http://receiver/api/ingest', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] },
      body: Buffer.concat(chunks),
    }).formData();
    let bytes = Buffer.from(await form.get('envelope').arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    envelopes.push({ status: ingestStatus, envelope: JSON.parse(bytes.toString('utf8')) });
    res.writeHead(ingestStatus, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.url?.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"replayEnabled":false,"vitalsEnabled":false}');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><div id="root"></div><script type="module">import * as host from "/bundle.js";window.host=host;</script>',
  );
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const endpoint = `http://127.0.0.1:${server.address().port}`;

const reactAlias = reactRoot
  ? {
      react: resolve(reactRoot, 'node_modules/react'),
      'react-dom': resolve(reactRoot, 'node_modules/react-dom'),
    }
  : {};

async function bundleFor(mode) {
  const result = await build({
    entryPoints: [resolve('tests/render-error-host.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    alias: {
      ...reactAlias,
      '@everframe/web/ui': resolve('../sdk-web/src/ui.ts'),
      '@everframe/web': resolve('../sdk-web/src/index.ts'),
      '@everframe/sdk-core': resolve('../sdk-core/src/index.ts'),
      '@everframe/protocol': resolve('../protocol/src/index.ts'),
    },
    define: {
      __EVERFRAME_INGEST_URL__: JSON.stringify(endpoint),
      'process.env.NODE_ENV': JSON.stringify(mode),
    },
  });
  return result.outputFiles[0].text;
}

const crashes = () => envelopes.filter(({ envelope }) => envelope.payload?.crash);
const reportIds = (rows) => [...new Set(rows.map(({ envelope }) => envelope.reportId))];

async function waitFor(predicate, label, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail(`timed out: ${label}`);
}

const results = [];
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const mode of ['production', 'development']) {
    bundle = await bundleFor(mode);
    const reactVersion = { value: '' };

    async function open() {
      const context = await browser.newContext();
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(endpoint);
      await page.waitForFunction(() => !!window.host);
      reactVersion.value = await page.evaluate(() => window.host.reactVersion);
      return { context, page, pageErrors };
    }

    for (const scenario of ['render', 'effect', 'render-strict']) {
      envelopes.length = 0;
      ingestStatus = 200;
      const { context, page, pageErrors } = await open();
      await page.evaluate((strict) => window.host.mount({ strict }), scenario.endsWith('strict'));
      await page.waitForSelector('#ready');
      await page.waitForTimeout(100);
      await page.evaluate((kind) => window.host.trigger(kind), scenario.replace('-strict', ''));
      await waitFor(() => crashes().length > 0, `${mode} ${scenario}: crash report`);
      await page.waitForTimeout(400);

      const label = `${mode} ${scenario} (React ${reactVersion.value})`;
      // React's own behaviour is unchanged: the root is unmounted and the
      // page sees the uncaught error.
      assert.equal(await page.evaluate(() => document.getElementById('root').innerHTML), '', label);
      assert(
        pageErrors.some((message) => message.startsWith('smoke js-')),
        `${label}: page error`,
      );
      // React 18's development build runs renders it retries and effects
      // inside a fake DOM event (invokeGuardedCallback), so the browser
      // reports those errors to window.onerror before any boundary sees
      // them: the non-fatal report every React 18 development build has
      // always sent. A failed render is replayed with a new error object, so
      // the fatal report follows; an effect's error is the same object, so it
      // stays that one non-fatal report. Production builds do neither.
      const react18Dev = mode === 'development' && reactVersion.value.startsWith('18.');
      const fatal = crashes().filter(({ envelope }) => envelope.payload.crash.fatal === true);
      const nonFatal = crashes().filter(({ envelope }) => envelope.payload.crash.fatal !== true);
      if (react18Dev && scenario === 'effect') {
        assert.equal(reportIds(fatal).length, 0, label);
        assert.equal(reportIds(nonFatal).length, 1, label);
        results.push({
          label: `${label}: non-fatal, as React 18 development builds always reported it`,
        });
        await context.close();
        continue;
      }
      // One fatal report, with the component stack, and nothing else.
      assert.equal(reportIds(fatal).length, 1, `${label}: one fatal report`);
      assert.equal(reportIds(nonFatal).length, react18Dev ? 1 : 0, `${label}: non-fatal reports`);
      const { envelope } = fatal[0];
      const crash = envelope.payload.crash;
      const component = scenario.startsWith('effect') ? 'ExplodingEffect' : 'ExplodingRow';
      assert.equal(envelope.source, 'crash', label);
      assert.equal(crash.fatal, true, label);
      assert.equal(crash.handled, false, label);
      assert.equal(crash.mechanism, 'onerror', label);
      assert.match(
        crash.message,
        new RegExp(
          `^smoke js-\\w+: ${component}\\n\\nThis error is located at:\\n\\s+at ${component}\\b`,
        ),
        label,
      );
      assert.match(crash.message, /\n\s+at CrashHost\b/, label);
      assert.equal(envelope.reporter.title, `Error: ${crash.message.split('\n')[0]}`, label);
      // A render error's own top frame is the component; an effect's is the
      // anonymous effect callback, so only the component stack names it.
      if (component === 'ExplodingRow') assert.match(crash.frames[0].raw, /ExplodingRow/, label);
      results.push({ label, reportId: envelope.reportId, message: crash.message });
      await context.close();
    }

    // The send fails; the report waits in the outbox and goes out after a reload.
    {
      envelopes.length = 0;
      ingestStatus = 503;
      const { context, page } = await open();
      await page.evaluate(() => window.host.mount());
      await page.waitForSelector('#ready');
      await page.waitForTimeout(100);
      await page.evaluate(() => window.host.trigger('render'));
      await waitFor(() => crashes().length > 0, `${mode} offline: first attempt`);
      await page.waitForTimeout(300);
      ingestStatus = 200;
      await page.reload();
      await page.waitForFunction(() => !!window.host);
      await page.evaluate(() => window.host.mount());
      const deliveredFatal = () =>
        crashes().filter((row) => row.status === 200 && row.envelope.payload.crash.fatal === true);
      await waitFor(() => deliveredFatal().length > 0, `${mode} offline: delivered after reload`);
      const fatalIds = reportIds(
        crashes().filter(({ envelope }) => envelope.payload.crash.fatal === true),
      );
      assert.equal(fatalIds.length, 1);
      const queued = fatalIds[0];
      results.push({
        label: `${mode} render, send failed, delivered after reload`,
        reportId: queued,
      });
      await context.close();
    }

    // A press-handler error leaves the app standing: a non-fatal error, as before.
    {
      envelopes.length = 0;
      ingestStatus = 200;
      const { context, page } = await open();
      await page.evaluate(() => window.host.mount());
      await page.waitForSelector('#ready');
      await page.waitForTimeout(100);
      await page.evaluate(() => window.host.trigger('handler'));
      await waitFor(() => crashes().length > 0, `${mode} handler: report`);
      await page.waitForTimeout(300);
      assert.equal(reportIds(crashes()).length, 1);
      const { envelope } = crashes()[0];
      assert.equal(envelope.source, 'error');
      assert.equal(envelope.payload.crash.fatal, false);
      assert.equal(envelope.payload.crash.message, 'smoke js-handler: onJsHandler');
      assert.equal(await page.locator('#ready').count(), 1);
      results.push({
        label: `${mode} handler: non-fatal error, app still mounted`,
        reportId: envelope.reportId,
      });
      await context.close();
    }

    // A boundary of the host's inside the provider owns the error: nothing is sent.
    {
      envelopes.length = 0;
      const { context, page } = await open();
      await page.evaluate(() => window.host.mount({ hostBoundary: true }));
      await page.waitForSelector('#ready');
      await page.waitForTimeout(100);
      await page.evaluate(() => window.host.trigger('render'));
      await page.waitForSelector('#fallback');
      await page.waitForTimeout(400);
      const sent = crashes();
      // React 18's development build replays a failed render inside a fake
      // DOM event, so the browser reports even a caught render error to
      // window.onerror. That pre-existing non-fatal report is the only one
      // allowed here; nothing fatal.
      assert(
        sent.every(({ envelope }) => envelope.payload.crash.fatal === false),
        `${mode} host boundary: nothing fatal`,
      );
      if (mode === 'production' || !reactVersion.value.startsWith('18.'))
        assert.equal(sent.length, 0, `${mode} host boundary: nothing sent`);
      results.push({ label: `${mode} host boundary inside the provider: ${sent.length} reports` });
      await context.close();
    }
  }

  await writeFile(
    resolve(output, 'proof.json'),
    JSON.stringify(
      { browser: browser.version(), react: reactRoot ?? 'workspace', results },
      null,
      2,
    ),
  );
  for (const { label } of results) console.log(`ok  ${label}`);
  console.log(`PASS: ${results.length} checks in Chromium ${browser.version()}`);
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

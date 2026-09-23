// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The OTHER framework-free path, and the one the marketing FAQ and the docs
// describe: a page with NO BUNDLER, importing the SDK by URL from a single
// `<script type="module">`. In the README that URL is a version-pinned
// jsDelivr path; here it is the same artifact served locally out of the same
// versioned directory.
//
// This is a genuinely different artifact from the one vanilla-mount.spec.ts
// drives, not a second way of loading the same file. `dist/browser/index.js`
// is built from src/index.ts with `noExternal: [/.*/]`, so React, konva, rrweb
// and modern-screenshot are all inlined into ITS OWN chunk graph and nothing
// bare survives for the browser to resolve. vanilla-mount.spec.ts's fixture,
// by contrast, loads `dist/index.js` and needs an import map to resolve the
// two bare dynamic specifiers a consumer's bundler would normally resolve —
// which is the standing proof that `dist/index.js` is NOT loadable on a plain
// HTML page as shipped.
//
// WHAT CHANGED, and why the first assertion below inverted. This slot used to
// hold an IIFE (`dist/everframe.min.js`, from a since-deleted `src/cdn.ts`)
// loaded by a bare `<script src>`, and this spec asserted `moduleScripts: 0`
// to prove the page was bundler-free. An IIFE has no module loader and so
// cannot code-split: React, konva, rrweb and modern-screenshot all downloaded
// on page load, 391 kB gz against 120 kB for the ESM graph, and it bought
// nothing for that — every build here targets es2022, and every engine that
// runs es2022 has supported `<script type="module">` for years. So the module
// count is now 1, and the thing that proves "bundler-free" is the IMPORT-MAP
// count being 0: this page resolves nothing, it just fetches a URL.
//
// NEWLY PRESENT: the lazy-React invariant, which the IIFE could not have had.
// It is asserted on THIS build's own property — React must arrive in a chunk
// fetched only when the reporter opens — and not by the ESM entry's "React is
// absent from the entry entirely", which is false here by design.
import { test, expect } from '@playwright/test';
import {
  SCRIPT_TAG_FIXTURE as FIXTURE,
  expectCaptureExcludesReporterChrome,
  openReporter,
  stubIngestApi,
} from './_helpers.js';

test.beforeEach(async ({ page }) => {
  await stubIngestApi(page);
});

test('one module script, no import map, and one tagged host', async ({ page }) => {
  await page.goto(FIXTURE);

  const state = await page.evaluate(() => {
    const host = document.getElementById('everframe-host');
    return {
      hosts: document.querySelectorAll('#everframe-host').length,
      shadow: !!host?.shadowRoot,
      // The capture-exclusion contract starts here: filterNode drops the host,
      // and the whole shadow subtree goes with it.
      skipCapture: host?.getAttribute('data-everframe-skip-capture'),
      // One module block and NO import map — the point of this fixture. The
      // browser resolved nothing; it fetched a URL out of a versioned
      // directory, exactly as it would from cdn.jsdelivr.net.
      moduleScripts: document.querySelectorAll('script[type=module]').length,
      importMaps: document.querySelectorAll('script[type=importmap]').length,
      // No `window.everframe`. The IIFE installed one and guarded against double
      // inclusion; the module registry dedupes by URL, so the guard has nothing
      // left to guard and the global is gone. Asserted rather than merely
      // dropped, so a resurrected global is a failure and not a silent
      // re-expansion of the public surface.
      global: typeof (window as unknown as { everframe?: unknown }).everframe,
      // …while the handle init() returned is real, which is what makes the line
      // above a statement about the global and not about a dead page.
      handle: typeof (window as unknown as { __everframe?: { open?: unknown } }).__everframe?.open,
    };
  });

  expect(state).toEqual({
    hosts: 1,
    shadow: true,
    skipCapture: 'true',
    moduleScripts: 1,
    importMaps: 0,
    global: 'undefined',
    handle: 'function',
  });
});

test('React is fetched only when the reporter opens', async ({ page }) => {
  // The reason this build is worth having at all, asserted at runtime on the
  // shipped artifact. `format: 'esm'` + `splitting: true` is what puts React
  // behind init.ts's dynamic `import('./mount/react-island.js')`; flip
  // `splitting` off in tsup.config.ts's browserEntry and esbuild inlines that
  // import into the entry — `late` goes empty and this test goes red. It is
  // the runtime half of the same regression .size-limit.json's 135 kB budget
  // catches statically (measured 400 kB with splitting off).
  const fetched: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/dist/browser/') && u.pathname.endsWith('.js')) {
      fetched.push(u.pathname);
    }
  });

  await page.goto(FIXTURE);
  await page.waitForFunction(
    () => !!(window as unknown as { __everframe?: unknown }).__everframe,
    null,
    { timeout: 30_000 },
  );
  const eager = [...fetched];

  await openReporter(page);
  const late = fetched.filter((p) => !eager.includes(p));

  // Read the bodies back off the same server the browser read them from, so
  // this is a statement about what was actually delivered.
  const bodyOf = async (pathname: string): Promise<string> => {
    const res = await page.request.get(pathname);
    expect(res.status(), `${pathname} did not serve`).toBe(200);
    return res.text();
  };
  const REACT = /react-dom|__SECRET_INTERNALS/;

  const eagerWithReact: string[] = [];
  for (const f of eager) if (REACT.test(await bodyOf(f))) eagerWithReact.push(f);
  const lateWithReact: string[] = [];
  for (const f of late) if (REACT.test(await bodyOf(f))) lateWithReact.push(f);

  // eslint-disable-next-line no-console
  console.log('[browser-entry] eager', JSON.stringify(eager), 'late', JSON.stringify(late));

  // Vacuity guards: the page really did load from this directory, and opening
  // the reporter really did pull something new down. Without them a fixture
  // that fetched nothing at all would read as a clean pass.
  expect(eager.length, 'the page fetched nothing from /dist/browser/').toBeGreaterThan(0);
  expect(late.length, 'opening the reporter fetched no additional chunk').toBeGreaterThan(0);

  expect(eagerWithReact, 'React was in the always-loaded graph').toEqual([]);
  expect(lateWithReact.length, 'no chunk fetched on open contains React').toBeGreaterThan(0);
});

test('the dialog opens inside the shadow root, styled, and does not leak', async ({ page }) => {
  await page.goto(FIXTURE);
  await openReporter(page);

  const state = await page.evaluate(() => {
    const sr = document.getElementById('everframe-host')!.shadowRoot!;
    const modal = sr.querySelector('.everframe-modal') as HTMLElement;
    const cs = getComputedStyle(modal);
    return {
      leaked: !!document.body.querySelector('.everframe-modal'),
      leakedDialogs: document.querySelectorAll('[role=dialog]').length,
      bgImage: cs.backgroundImage,
      radius: cs.borderRadius,
    };
  });

  expect(state.leaked).toBe(false);
  expect(state.leakedDialogs).toBe(0);
  // Proves the shadow-root stylesheet actually applied rather than the tree
  // rendering unstyled — .everframe-modal's background is a gradient, so
  // backgroundColor is legitimately transparent and must NOT be asserted on.
  expect(state.bgImage).toContain('gradient');
  expect(state.radius).toBe('18px');
});

test('a capture taken with the dialog open excludes the reporter chrome', async ({ page }) => {
  await page.goto(FIXTURE);
  // Same calibrated measurement, same three vacuity guards, same threshold as
  // the ESM path — see _helpers.ts. The `total > 100_000` guard matters
  // especially here: this build inlines modern-screenshot rather than leaving
  // it to an import map, so a degradation to the 1x1 transparent placeholder
  // would otherwise read as a perfect 0 — and it is what would catch
  // `noExternal` being dropped from browserEntry, which leaves behind a bare
  // `import('modern-screenshot')` this page has no way to resolve.
  await expectCaptureExcludesReporterChrome(page);
});

test('destroy() removes the host entirely', async ({ page }) => {
  await page.goto(FIXTURE);
  await expect(page.locator('#everframe-host')).toHaveCount(1);
  await page.evaluate(() =>
    (window as unknown as { __everframe: { destroy(): void } }).__everframe.destroy(),
  );
  expect(await page.locator('#everframe-host').count()).toBe(0);
});

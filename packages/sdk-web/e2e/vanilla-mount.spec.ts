// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The one test that proves the product claim: a page with no framework on it
// gets a working reporter. Everything else about this package is unit-level
// (jsdom) or build-level (chunk-graph greps); this file drives the SHIPPED
// dist/ in three real engines.
//
// Every shadow-internal assertion goes through `page.evaluate` rather than a
// Playwright selector: the reporter mounts into an open shadow root and the
// normal selector engine does not pierce it from the outside.
import { test, expect } from '@playwright/test';
import {
  ESM_FIXTURE as FIXTURE,
  expectCaptureExcludesReporterChrome,
  openReporter,
  stubIngestApi,
} from './_helpers.js';

test.beforeEach(async ({ page }) => {
  await stubIngestApi(page);
});

// Codex round-1 finding 6. This test used to open with
// `expect('React' in window).toBe(false)` under the name "the host page runs
// no React of its own" — an assertion that CANNOT FAIL under the regression it
// named: eagerly bundling and executing ESM React never assigns `window.React`
// (that global is a UMD/script-tag artefact), so the whole lazy boundary could
// collapse and this stayed green. The React-absence invariant is carried,
// really and over the wire, by the next test — which greps every script the
// page fetched before the reporter opened for `react-dom`/`__SECRET_INTERNALS`.
// What is left here is only what this test can actually observe: the SDK's
// ambient DOM footprint on a plain HTML page is exactly one host element.
test('the SDK mounts exactly one ambient host on a plain HTML page', async ({ page }) => {
  await page.goto(FIXTURE);
  expect(await page.locator('#traceitx-host').count()).toBe(1);
});

test('React is not fetched until the reporter opens', async ({ page }) => {
  // RULING 3 — assert the INVARIANT, not a chunk filename. tsup emits the
  // island under a content-hashed name it is free to change (and under
  // `splitting: false` would not emit it at all), so a `/react-island/` URL
  // regex could fail for a reason unrelated to the invariant or, worse, pass
  // vacuously by never matching. What is asserted instead:
  //
  //   1. the set of .js URLs the page has requested stops growing once load
  //      settles and stays put until the click, then grows after it;
  //   2. NONE of the scripts fetched before the click contains a React marker,
  //      and at least one of the scripts fetched after it does. That is the
  //      same gate the build applies to dist/index.js
  //      (`grep -c "react-dom\|__SECRET_INTERNALS"`), applied over the wire to
  //      whatever the bundler actually named things.
  const REACT_MARKER = /react-dom|__SECRET_INTERNALS/;
  const scripts = new Set<string>();
  const isJs = (url: string): boolean => {
    try {
      return new URL(url).pathname.endsWith('.js');
    } catch {
      return false;
    }
  };
  page.on('request', (r) => {
    if (isJs(r.url())) scripts.add(r.url());
  });

  await page.goto(FIXTURE, { waitUntil: 'networkidle' });
  const eager = [...scripts];
  expect(eager.length).toBeGreaterThan(0);

  // A settle window, not a retry: `networkidle` is Playwright's own quiet
  // point, and this holds the page there long enough to catch anything the
  // SDK might fetch on a timer rather than on the open.
  await page.waitForTimeout(500);
  expect([...scripts], 'the page kept fetching scripts with the reporter closed').toEqual(eager);

  for (const url of eager) {
    const body = await (await page.request.get(url)).text();
    expect(REACT_MARKER.test(body), `${url} was fetched on load and contains React`).toBe(false);
  }

  await openReporter(page);

  const added = [...scripts].filter((u) => !eager.includes(u));
  expect(added.length, 'opening the reporter fetched no new script').toBeGreaterThan(0);
  const bodies = await Promise.all(
    added.map(async (u) => (await page.request.get(u)).text()),
  );
  expect(
    bodies.some((b) => REACT_MARKER.test(b)),
    'no script fetched after opening the reporter contains React',
  ).toBe(true);
});

test('the dialog mounts inside the shadow root, styled, and does not leak', async ({ page }) => {
  await page.goto(FIXTURE);
  await openReporter(page);

  const state = await page.evaluate(() => {
    const sr = document.getElementById('traceitx-host')!.shadowRoot!;
    const modal = sr.querySelector('.txx-modal') as HTMLElement;
    const cs = getComputedStyle(modal);
    return {
      leaked: !!document.body.querySelector('.txx-modal'),
      leakedDialogs: document.querySelectorAll('[role=dialog]').length,
      bgImage: cs.backgroundImage,
      radius: cs.borderRadius,
    };
  });

  // Nothing in the light DOM. This is also the runtime proof that the eager
  // entry and the lazy island share ONE instance of the portal-target seam:
  // with two copies, init() would write the shadow root on one and the dialog
  // would read the other's `document.body` default and render right here.
  expect(state.leaked).toBe(false);
  expect(state.leakedDialogs).toBe(0);
  // Proves the shadow-root stylesheet actually applied rather than the tree
  // rendering unstyled — .txx-modal's background is a gradient, so
  // backgroundColor is legitimately transparent and must NOT be asserted on.
  expect(state.bgImage).toContain('gradient');
  expect(state.radius).toBe('18px');
});

test('a capture taken with the dialog open excludes the reporter chrome', async ({ page }) => {
  await page.goto(FIXTURE);
  // The measurement, its three vacuity guards and the calibrated threshold all
  // live in _helpers.ts, so the ESM entry and the browser build are held to
  // exactly one standard. Measured here: 0 of 921,600 pixels differing
  // (0 of 3,686,400 on webkit's 2x viewport).
  await expectCaptureExcludesReporterChrome(page);
});

test('Tab stays trapped inside the modal (shadow-DOM focus fix)', async ({
  page,
  browserName,
}) => {
  // Task 1's fix: `document.activeElement` reports the shadow HOST for
  // anything focused inside a shadow tree, so a focus trap comparing against
  // it never matches and silently stops wrapping — Tab walks straight out into
  // the page behind the modal. That fix has been proven only by a unit test on
  // `activeElementFor`; this is the Modal-level proof, in a real shadow root.
  //
  // MEASURED, by re-running this walk with the Modal's own Tab handler
  // suppressed (`stopImmediatePropagation` on a capture listener) — i.e. with
  // the trap doing nothing, which is exactly what the shadow-DOM bug caused:
  //
  //   chromium  focus leaves the modal and lands on the fixture's own
  //             `#report` button — the escape this fix exists to prevent.
  //   firefox   focus stalls on the last focusable forever; it never reaches
  //             the page, but it never wraps either.
  //   webkit    IDENTICAL with and without the trap. Playwright's WebKit
  //             inherits Safari's default keyboard-navigation setting, under
  //             which Tab visits text controls only — it skips the watermark
  //             link and both footer buttons, so it never reaches the last
  //             focusable and the trap's wrap branch is unreachable. Focus
  //             does step out to the browser's own UI (document.activeElement
  //             is <body>, never a page element) between the two fields.
  //
  // So the wrap is asserted where it is observable, the escape everywhere, and
  // WebKit is not credited with a pass it cannot earn.
  await page.goto(FIXTURE);
  await openReporter(page);
  // The modal focuses its first field on a microtask after commit; tabbing
  // from `document.body` instead would start the walk outside the trap.
  await page.waitForFunction(
    () => {
      const sr = document.getElementById('traceitx-host')!.shadowRoot!;
      const a = sr.activeElement;
      return !!a && !!sr.querySelector('.txx-modal')?.contains(a);
    },
    null,
    { timeout: 10_000 },
  );

  const trail: {
    inModal: boolean;
    index: number;
    last: number;
    inHostPage: boolean;
    where: string;
  }[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    trail.push(
      await page.evaluate(() => {
        // Character-for-character Modal.tsx's `focusableElementsIn` selector.
        const FOCUSABLE =
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        const sr = document.getElementById('traceitx-host')!.shadowRoot!;
        const modal = sr.querySelector('.txx-modal')!;
        const focusables = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE));
        const active = sr.activeElement;
        const doc = document.activeElement;
        return {
          inModal: !!active && modal.contains(active),
          index: active ? focusables.indexOf(active as HTMLElement) : -1,
          last: focusables.length - 1,
          // The shadow host means focus is inside the reporter; <body> means
          // the browser's own UI has it. Anything else is the page behind.
          inHostPage: !!doc && doc !== document.body && !doc.closest('#traceitx-host'),
          where: active
            ? `${active.tagName}[${active.getAttribute('data-testid') ?? active.className}]`
            : `document:${doc?.tagName}#${doc?.id}`,
        };
      }),
    );
  }

  // Everywhere: Tab never reaches the host page behind the modal.
  expect(
    trail.filter((s) => s.inHostPage).map((s) => s.where),
    'Tab escaped into the page behind the modal',
  ).toEqual([]);

  if (browserName !== 'webkit') {
    // Where Tab visits every focusable, the full contract holds and the wrap
    // is directly observable.
    expect(
      trail.filter((s) => !s.inModal).map((s) => s.where),
      'focus left the modal',
    ).toEqual([]);
    const wrapped = trail.some(
      (s, i) => s.index === s.last && s.last > 0 && trail[i + 1]?.index === 0,
    );
    expect(wrapped, `Tab never wrapped last -> first: ${trail.map((s) => s.where).join(' | ')}`).toBe(
      true,
    );
  } else {
    // WebKit still has to keep coming back into the modal rather than walking
    // off down the page.
    expect(trail.filter((s) => s.inModal).length).toBeGreaterThan(10);
  }
});

test('destroy() removes the host entirely', async ({ page }) => {
  await page.goto(FIXTURE);
  await expect(page.locator('#traceitx-host')).toHaveCount(1);
  await page.evaluate(() =>
    (window as unknown as { __traceitx: { destroy(): void } }).__traceitx.destroy(),
  );
  expect(await page.locator('#traceitx-host').count()).toBe(0);
});

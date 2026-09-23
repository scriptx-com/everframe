// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// What this test proves: the SDK threads cspNonce into the reporter
// stylesheet it injects at mount (init()'s injectReporterStyles call, into
// the shadow root). What it does NOT prove: that the screenshot renderer's
// capture-time font-CSS path is nonced — tracing the installed
// modern-screenshot shows its font-embedding <style> insertions never reach
// a location this test, or the SDK's own capture-time nonce-applier in
// capture/screenshot.ts, can observe (see "Measurement window" below, and
// task-6-report.md for the full trace).
//
// Ported from packages/sdk-react/e2e/strict-csp.spec.ts, with two corrections
// to the observation mechanism (not to the thing being asserted) found while
// implementing this task:
//
// 1. Read the `.nonce` IDL PROPERTY, not `getAttribute('nonce')`. Chrome
//    deliberately clears the `nonce` CONTENT ATTRIBUTE to '' the moment a
//    nonced element is connected to a document, to stop a script from
//    exfiltrating nonces via markup/attribute inspection. getAttribute('nonce')
//    reads '' on every connected nonced element regardless of whether the
//    correct nonce was applied — it cannot discriminate correct from broken.
//    Confirmed empirically: the SDK's own reporter <style> reads
//    attrNonce === '' and idlNonce === STATIC_TEST_NONCE on the exact same
//    element, at the exact same time.
// 2. Watch every shadow root too, not just `document`/`document.head`.
//    @everframe/web mounts its reporter UI into an OPEN SHADOW ROOT by default
//    (`config.__everframeShadowDom !== false`, see init.ts) — its own CSS
//    injection targets that shadow root, not `document`, and a MutationObserver
//    on `document` (subtree or not) cannot see across a shadow boundary. A
//    monkey-patched `attachShadow` observes every shadow root synchronously
//    as it is created, so there is no race with the SDK's own init().
//
// Measurement window: kept as the full reporter lifecycle (page load through
// submit) rather than reset away right before opening the reporter. The only
// real, controllable, cspNonce-driven <style> this SDK produces is
// `injectReporterStyles`' reporter-CSS tag, injected once into the shadow
// root at init() time (idempotent) — i.e. at BOOT, before any "reset after
// boot" point could measure it. Resetting it away would make the positive
// control below permanently fail regardless of whether cspNonce is threaded
// correctly, because modern-screenshot never inserts a <style> anywhere a
// live-document observer (this test's, or the SDK's own
// capture/screenshot.ts::applyNonceToFreshStyles) can see: one path
// (`svgStyleElement`) is only ever XMLSerializer-stringified, never attached
// to a live document; the other
// (`ownerDocument.implementation.createHTMLDocument().head.appendChild(...)`)
// lands in a DETACHED, unrelated Document object, and is itself
// unconditionally blocked by Chromium's CSP enforcement (a `style-src-elem`
// violation against `modern-screenshot.js`, independent of cspNonce —
// confirmed via a `securitypolicyviolation` listener). A permanently-failing
// control would be a spec that cannot discriminate a regression — the exact
// defect this control exists to prevent. See task-6-report.md for both
// measurements (the boot-time count kept here, and the capture-only count
// that motivated this decision).
import { test, expect } from '@playwright/test';
import { stubIngest, openReporter } from './_helpers';

const STATIC_TEST_NONCE = 'STATIC_TEST_NONCE_FOR_PLAYWRIGHT';

test('the SDK threads cspNonce to the reporter stylesheet it injects at mount', async ({ page }) => {
  page.on('pageerror', (e) => console.error('[page]', e.message));
  stubIngest(page);

  const violations: string[] = [];
  await page.exposeFunction('__recordViolation', (d: string) => violations.push(d));

  await page.addInitScript(() => {
    interface StyleRecord {
      nonce: string;
      snippet: string;
    }
    interface W {
      __styles?: StyleRecord[];
    }
    (window as unknown as W).__styles = [];

    const record = (n: Node): void => {
      if (n instanceof HTMLStyleElement) {
        (window as unknown as W).__styles?.push({
          // .nonce, NOT getAttribute('nonce') — see file header. Falls back
          // to '' (never nonced) rather than widening the field to
          // `string | undefined`, which is what HTMLOrSVGElement.nonce is
          // typed as.
          nonce: n.nonce ?? '',
          snippet: (n.textContent ?? '').slice(0, 80),
        });
      }
    };
    const watch = (target: Node): void => {
      new MutationObserver((muts) => {
        for (const m of muts) m.addedNodes.forEach(record);
      }).observe(target, { childList: true, subtree: true });
    };
    watch(document);
    // Every shadow root created from here on is watched too — synchronously,
    // as part of the attachShadow() call itself, so there is no window in
    // which the SDK's own init() could inject a style before we start
    // watching that root. See file header point 2.
    const origAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      const root = origAttachShadow.call(this, init);
      watch(root);
      return root;
    };

    document.addEventListener('securitypolicyviolation', (e) => {
      const w = window as unknown as { __recordViolation?: (d: string) => void };
      w.__recordViolation?.(
        `${e.violatedDirective}: ${e.blockedURI} (${e.sourceFile}:${e.lineNumber})`,
      );
    });
  });

  await page.goto('/strict-csp.html');
  await expect(page.getByTestId('strict-csp-heading')).toBeVisible();
  await expect(page.getByTestId('everframe-bubble')).toBeVisible({ timeout: 15_000 });

  await openReporter(page);
  await page.getByTestId('report-title').fill('strict csp test');
  await page.getByTestId('submit-report').click();
  await page.waitForTimeout(3000);

  const styles = await page.evaluate(
    () => (window as unknown as { __styles?: { nonce: string; snippet: string }[] }).__styles ?? [],
  );

  // Positive control (Ruling R10 / Correction 4): this case must be able to
  // FAIL. Zero styles observed would make the nonce assertion below pass
  // vacuously — that is the exact defect shape this control exists to rule
  // out. See the file header for what is, and is not, being measured here.
  expect(
    styles.length,
    'no <style> elements were observed at all — the measurement window caught nothing, so the nonce assertion below would pass vacuously',
  ).toBeGreaterThan(0);

  const unNonced = styles.filter((s) => s.nonce !== STATIC_TEST_NONCE);
  expect(unNonced).toEqual([]);

  // Positive control for the violations listener itself (F1): the assertion
  // below is a negative (`toEqual([])`) on a collection with no other proof
  // the producer is live. If `__recordViolation` or the
  // `securitypolicyviolation` listener ever stopped working, `violations`
  // would silently be `[]` and the negative assertion would pass reporting
  // nothing. Deliberately violate style-src ourselves and require a
  // violation to show up for it BEFORE trusting the negative.
  const violationCountBeforeControl = violations.length;
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent = '/* F1 positive control: deliberately un-nonced */';
    document.head.appendChild(s);
  });
  await expect
    .poll(() => violations.length, {
      message:
        'appending a deliberate un-nonced <style> produced no securitypolicyviolation — ' +
        'the violation listener is not live, so the "no unexpected violations" assertion ' +
        'below would pass vacuously',
      timeout: 10_000,
    })
    .toBeGreaterThan(violationCountBeforeControl);
  // The violation(s) the control above produced, identified by POSITION
  // (everything recorded from here on), not by matching their content — so
  // excluding them below can't also swallow a real violation that happens to
  // match some pattern.
  const controlViolations = violations.slice(violationCountBeforeControl);
  expect(controlViolations.some((v) => /^style-src/.test(v))).toBe(true);

  // Two KNOWN, orthogonal categories of violation are filtered out here, each
  // confirmed by direct investigation (see task-6-report.md) and each
  // unrelated to whether the SDK threads cspNonce correctly:
  //
  // 1. connect-src, from the SDK's default ingest origin. This fixture's
  //    connect-src is deliberately narrow (localhost/127.0.0.1 only — see
  //    csp-plugin.ts). This fires only when the local dist/ was built against
  //    a production ingest URL: scripts/dev/build-web-sdk.mjs defaults
  //    EVERFRAME_INGEST_URL to http://localhost:8787, which this fixture's
  //    connect-src explicitly allows, so on the documented `pnpm
  //    dev:example:vue` path this violation does not fire at all. It only
  //    shows up if someone installs a dist built with the real
  //    https://everframe.dev baked in (constants.ts's INGEST_URL).
  // 2. style-src-elem, from modern-screenshot.js's scratch-document
  //    font-embedding call specifically (see file header). Anchored to the
  //    `(sourceFile:line)` position at the END of the violation string, not
  //    to the filename anywhere in the record, so a coincidental substring
  //    match elsewhere in the string can't hide behind it.
  //
  //    This anchor is still a filename+line match, not a location the SDK
  //    controls, so it is NOT a general guarantee against modern-screenshot
  //    regressions: a hypothetical future version whose font-embedding
  //    starts inserting into `document.head` would report this same
  //    sourceFile and could still slip past this specific filter. That case
  //    — an un-nonced <style> actually reaching a live, observed document —
  //    is what the structural `unNonced` assertion above catches, not this
  //    violations filter; this filter exists only to keep this ONE known,
  //    unrelated, un-fixable-by-cspNonce quirk from failing a spec about
  //    something else.
  const KNOWN_ORTHOGONAL = [/^connect-src:/, /\(.*modern-screenshot\.js:\d+\)$/];
  // Excludes the positive control's own violation(s) by POSITION (everything
  // from violationCountBeforeControl on is ours, by construction), not by a
  // pattern that could also match a real style-src regression.
  const unexpectedViolations = violations
    .slice(0, violationCountBeforeControl)
    .filter((v) => !KNOWN_ORTHOGONAL.some((re) => re.test(v)));
  expect(unexpectedViolations).toEqual([]);
});

test('the strict CSP header is actually being served', async ({ page }) => {
  // Without this, the spec above would pass just as happily on a page with no
  // policy at all — which is exactly the shape of a test that cannot fail.
  const res = await page.goto('/strict-csp.html');
  const csp = res?.headers()['content-security-policy'];
  expect(csp).toBeTruthy();
  expect(csp).toContain(`'nonce-${STATIC_TEST_NONCE}'`);
});

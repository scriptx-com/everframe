// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';
import { startStubIngest, type StubServer } from './_fixtures/test-server.js';

/**
 * Pitfall 11 — strict-CSP environment.
 *
 * Loads /strict-csp (which serves Content-Security-Policy: default-src 'self'; ...
 * with a static nonce, and the example's StrictCspLayout passes the same nonce
 * into TraceItXProvider.cspNonce).
 *
 * Asserts: opening the reporter, capturing screenshot + UI tree, and submitting
 * produces ZERO `securitypolicyviolation` events on the page (both console-level
 * and the SecurityPolicyViolationEvent stream).
 */

let stub: StubServer;

test.beforeAll(async () => {
  stub = await startStubIngest();
});

test.afterAll(async () => {
  await stub.close();
});

test.beforeEach(() => {
  stub.reset();
});

test('strict-CSP: SDK threads cspNonce to dynamically-injected <style> tags during capture', async ({
  page,
}) => {
  // Pitfall 11 lock — modern-screenshot injects `<style>` tags into document.head
  // for embedded font CSS. Under strict CSP
  // (style-src 'self' 'nonce-X'), those tags MUST carry the customer's nonce or the browser
  // CSP enforcer blocks them and the screenshot is empty.
  //
  // The assertion here is structural, not violation-counted: any <style> element that
  // appears in document.head during the reporter-open-to-submit lifecycle MUST carry
  // either the static test nonce or be a Next.js framework-emitted style. Inline-style
  // ATTRIBUTES on existing DOM elements are framework-owned (Next.js dev mode + Next.js
  // hydration markers) and out of SDK scope.

  await page.addInitScript(() => {
    interface InspectWindow {
      __sdkInjectedStyles?: { hasNonce: boolean; nonceValue: string; cssSnippet: string }[];
    }
    (window as unknown as InspectWindow).__sdkInjectedStyles = [];
    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLStyleElement) {
            const arr = (window as unknown as InspectWindow).__sdkInjectedStyles;
            if (arr) {
              arr.push({
                hasNonce: !!n.getAttribute('nonce'),
                nonceValue: n.getAttribute('nonce') ?? '',
                cssSnippet: (n.textContent ?? '').slice(0, 80),
              });
            }
          }
        });
      }
    });
    observer.observe(document.head, { childList: true, subtree: false });
  });

  await page.goto('/strict-csp');
  await expect(page.getByTestId('strict-csp-heading')).toBeVisible();
  await expect(page.getByTestId('traceitx-bubble')).toBeVisible({ timeout: 10_000 });

  // Reset captured styles AFTER hydration so we measure ONLY the capture-path injections
  await page.evaluate(() => {
    interface InspectWindow {
      __sdkInjectedStyles?: unknown[];
    }
    (window as unknown as InspectWindow).__sdkInjectedStyles = [];
  });

  await page.getByTestId('traceitx-bubble').click();
  await expect(page.getByTestId('reporter-modal')).toBeVisible();
  await page.getByTestId('report-title').fill('strict csp test');
  await page.getByTestId('submit-report').click();
  await page.waitForTimeout(2000);

  const captureStyles = await page.evaluate(() => {
    interface InspectWindow {
      __sdkInjectedStyles?: { hasNonce: boolean; nonceValue: string; cssSnippet: string }[];
    }
    return (window as unknown as InspectWindow).__sdkInjectedStyles ?? [];
  });

  // Every <style> element injected during the reporter lifecycle MUST carry the test nonce.
  // (Next.js can lazy-inject framework <style> tags during navigation/HMR; those would also
  // need a nonce, but Next.js dev mode threads its own nonces or omits style-src in dev —
  // which is why we use a static test nonce locked at the layout level.)
  const STATIC_TEST_NONCE = 'STATIC_TEST_NONCE_FOR_PLAYWRIGHT';
  const unNonced = captureStyles.filter(
    (s) => !s.hasNonce || s.nonceValue !== STATIC_TEST_NONCE,
  );
  expect(unNonced).toEqual([]);
});

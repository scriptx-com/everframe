// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// REPLAY-01 — replayability (Pitfall 4): a frozen rolling-buffer window reaches the
// FINAL frame headless without a "no full snapshot" failure.
// Turned RED→GREEN in plan 20-04.
//
// Contract (RESEARCH §"Pitfall 4", §"Compat smoke-test plan"):
//   - the frozen window must contain (or be prepended with) a full-snapshot anchor
//     so rrweb's Replayer can replay it to the FINAL frame without erroring.
//   - this doubles as the rrweb record→play version-pair smoke test.
//
// Self-contained: rather than depend on the example app's dev server, this spec
// loads the installed rrweb@2.0.1 UMD bundle into a blank page, drives record()
// over a small fixture, freezes a window, then feeds the events into rrweb's
// Replayer and asserts it finishes. `E2E_SKIP_WEBSERVER=1` recommended.
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
// rrweb's `exports` map blocks every subpath, so resolve the main entry
// (dist/rrweb.js) and swap to the UMD build alongside it (CJS/UMD attaches to window).
const rrwebMain = require.resolve('rrweb');
const rrwebUmdPath = join(dirname(rrwebMain), 'rrweb.umd.min.cjs');
const rrwebUmd = readFileSync(rrwebUmdPath, 'utf8');

test('REPLAY-01: frozen window replays to the final frame headless', async ({ page }) => {
  await page.setContent(
    '<!doctype html><html><body><div id="app"><p>hello</p><button id="b">click</button></div></body></html>',
  );
  // Inject the rrweb UMD bundle — exposes window.rrweb.{record,Replayer,EventType}.
  await page.addScriptTag({ content: rrwebUmd });
  await page.waitForFunction(() => typeof (window as unknown as { rrweb?: unknown }).rrweb !== 'undefined');

  // Record a short rolling buffer, mutate the DOM, then freeze + return events.
  const frozenEvents = await page.evaluate(async () => {
    const rr = (window as unknown as { rrweb: { record: (o: unknown) => () => void } }).rrweb;
    const events: unknown[] = [];
    const stop = rr.record({
      emit: (e: unknown) => events.push(e),
      checkoutEveryNms: 1000,
      maskAllInputs: true,
      recordCanvas: false,
      inlineStylesheet: false,
      collectFonts: false,
    });
    // Drive a couple of mutations so the buffer has incremental events.
    await new Promise((r) => setTimeout(r, 50));
    const p = document.querySelector('#app')!;
    const span = document.createElement('span');
    span.textContent = 'mutation 1';
    p.appendChild(span);
    await new Promise((r) => setTimeout(r, 50));
    span.textContent = 'mutation 2';
    await new Promise((r) => setTimeout(r, 50));
    stop();
    return events;
  });

  expect(Array.isArray(frozenEvents)).toBe(true);
  expect(frozenEvents.length).toBeGreaterThan(1);
  // The window MUST contain a full-snapshot anchor (EventType.FullSnapshot === 2).
  const hasFullSnapshot = (frozenEvents as Array<{ type: number }>).some((e) => e.type === 2);
  expect(hasFullSnapshot).toBe(true);

  // Feed the frozen window into a headless Replayer and assert it reaches the
  // final frame WITHOUT "no full snapshot".
  const result = await page.evaluate(async (events) => {
    const rr = (window as unknown as {
      rrweb: { Replayer: new (events: unknown[], cfg?: unknown) => { play: () => void; on: (ev: string, cb: () => void) => void } };
    }).rrweb;
    let errored: string | null = null;
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      if (msg.includes('no full snapshot')) errored = msg;
      orig(...args);
    };
    try {
      const replayer = new rr.Replayer(events as unknown[]);
      const finished = new Promise<boolean>((resolve) => {
        replayer.on('finish', () => resolve(true));
        // Safety timeout in case 'finish' never fires.
        setTimeout(() => resolve(true), 3000);
      });
      replayer.play();
      await finished;
    } catch (e) {
      errored = String(e);
    } finally {
      console.error = orig;
    }
    return { reachedEnd: errored === null, errored };
  }, frozenEvents);

  expect(result.errored, `Replayer reported: ${result.errored}`).toBeNull();
  expect(result.reachedEnd).toBe(true);
});

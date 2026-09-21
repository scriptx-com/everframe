// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-2 finding 4 (P2) — `init()` called from a plain, non-deferred
// `<script>` in `<head>` threw instead of returning a handle.
//
// `document.body` is NULL at that point: the parser has not reached `<body>`
// yet. `createHostElement` appended to it unconditionally, so a host that
// called `init()` from the head — which is where people put script tags — got
// a TypeError out of the SDK's entry point rather than a working reporter.
//
// It was first reported against the IIFE script-tag build, which no longer
// exists: the no-bundler path is a `<script type="module">` now, and modules
// are deferred, so `<body>` is always there for THAT caller. The case this
// spec pins is the remaining one — the ESM entry loaded from a blocking
// classic `<script>` in `<head>`, which a bundler may emit and a consumer may
// hand-write, and which jsdom reproduces exactly by leaving `document.body`
// unset.
//
// The fix must not change what `init()` promises: it returns a handle
// SYNCHRONOUSLY (README's install snippet assigns it and calls
// `setIdentityToken` on the next line, and init.ts's microtask-deferred first
// outbox drain is timed against exactly that). So the host element mounts into
// `documentElement` — always present once parsing has begun — and relocates
// into `<body>` the moment the parser creates it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHostElement } from '../../src/mount/host-element.js';

vi.mock('../../src/mount/react-island.js', () => ({
  mountIsland: () => ({
    setOpen: () => undefined,
    setInboxOpen: () => undefined,
    toast: () => undefined,
    unmount: () => undefined,
  }),
}));

import { init, type TraceItXHandle } from '../../src/init.js';

/** A document mid-parse: `<html><head></head></html>`, no body yet. */
function headOnlyDocument(): Document {
  const doc = document.implementation.createHTMLDocument('parsing');
  doc.body.remove();
  expect(doc.body).toBeNull();
  return doc;
}

/** What the parser does a moment later. */
function parserAppendsBody(doc: Document): HTMLElement {
  const body = doc.createElement('body');
  doc.documentElement.appendChild(body);
  return body;
}

let handle: TraceItXHandle | null = null;
let stolenBody: HTMLElement | null = null;

afterEach(() => {
  handle?.destroy();
  handle = null;
  if (stolenBody) {
    if (!document.body) document.documentElement.appendChild(stolenBody);
    stolenBody = null;
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('finding 4 — the host element mounts before <body> exists', () => {
  it('LIVE control: with a body, it mounts straight into it', () => {
    const doc = document.implementation.createHTMLDocument('normal');

    const { host } = createHostElement(doc);

    expect(host.parentNode).toBe(doc.body);
  });

  it('does not throw when <body> does not exist yet', () => {
    const doc = headOnlyDocument();

    expect(() => createHostElement(doc)).not.toThrow();
  });

  it('parks the host on <html> so the reporter is mountable immediately', () => {
    const doc = headOnlyDocument();

    const { host, root } = createHostElement(doc);

    expect(host.parentNode).toBe(doc.documentElement);
    // The shadow root — everything downstream renders into it — exists just
    // the same, so nothing about this parking spot is a degraded mode.
    expect(root).not.toBe(host);
    expect((root as ShadowRoot).host).toBe(host);
  });

  it('relocates into <body> as soon as the parser creates it', async () => {
    const doc = headOnlyDocument();
    const { host } = createHostElement(doc);

    const body = parserAppendsBody(doc);

    await vi.waitFor(() => expect(host.parentNode).toBe(body));
  });

  it('leaves no observer behind after remove()', async () => {
    const doc = headOnlyDocument();
    const { host, remove } = createHostElement(doc);

    remove();
    const body = parserAppendsBody(doc);
    await new Promise((r) => setTimeout(r, 30));

    // A live MutationObserver would re-home the removed element into the new
    // body and keep a detached node (and its shadow tree) alive for the life
    // of the page.
    expect(host.parentNode).toBeNull();
    expect(body.children).toHaveLength(0);
  });

  it('init() from <head> returns a handle rather than throwing', async () => {
    stolenBody = document.body;
    stolenBody.remove();
    expect(document.body).toBeNull();

    handle = init({ apiKey: 'txx_live_head_script' });

    expect(typeof handle.open).toBe('function');
    expect(document.getElementById('traceitx-host')).not.toBeNull();

    // ...and it lands in the body once the parser gets there.
    document.documentElement.appendChild(stolenBody);
    const parked = document.getElementById('traceitx-host')!;
    await vi.waitFor(() => expect(parked.parentNode).toBe(document.body));
  });
});

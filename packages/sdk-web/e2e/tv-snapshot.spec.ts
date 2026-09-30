// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Smart-TV snapshot path in real Chromium (TV webviews are Chromium): a webOS
// UA, a stubbed /api/config that turns the server path on, and a stubbed
// /api/render. Asserts on the EXACT bytes the SDK uploads, and rebuilds them
// with rrweb-snapshot (tv-rebuild.html) the way the render service does, to
// compare the rebuilt layout with the live page.
//
// The last test pins the committed sample snapshot
// (fixtures/tv-snapshot.sample.json.gz, read by server-side render tests) to
// what the SDK produces today: it fails when the output drifts. Regenerate it
// with EVERFRAME_WRITE_TV_FIXTURE=1.
import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { parseDomSnapshot } from '@everframe/protocol';
import { findLeaks } from '../__tests__/capture/tv-snapshot/leak-assert.js';

const WEBOS_UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager';
const WEBP_1PX = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=', 'base64');
const SECRETS = ['Alice Smith', 'ALICESECRET', 'ALICETYPED', 'SECRETTOKEN', 'SECRETCODE', 'alice:secret', 'PREVIOUSSCREEN'];
const SAMPLE_FIXTURE = fileURLToPath(new URL('./fixtures/tv-snapshot.sample.json.gz', import.meta.url));

test.skip(({ browserName }) => browserName !== 'chromium', 'smart-TV webviews are Chromium');
test.use({ userAgent: WEBOS_UA, viewport: { width: 1280, height: 720 } });

interface StubOptions {
  renderStatus?: number;
  meta?: Record<string, unknown>;
}

const DEFAULT_META = {
  blank: false,
  missingAssets: 1,
  missingAssetUrls: ['https://cdn.example.test/p.png'],
  fontsSubstituted: true,
  renderMs: 5,
};

async function stubApi(page: Page, { renderStatus = 200, meta = DEFAULT_META }: StubOptions = {}): Promise<Buffer[]> {
  const bodies: Buffer[] = [];
  // Every planted asset host is unreachable, so nothing leaves the machine.
  await page.route(/example\.test/, (route) => route.abort());
  // The ingest origin is baked into dist/; matched by path so the stub holds
  // whichever origin that is. Cross-origin, hence the CORS headers.
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Everframe-Render-Meta' };
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/config') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: cors,
        body: JSON.stringify({ replayEnabled: false, replayDurationSec: 30, samplingRate: 1, screenshotRender: true }),
      });
    }
    if (path === '/api/render') {
      bodies.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
      if (renderStatus !== 200) {
        return route.fulfill({ status: renderStatus, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: 'render_unavailable' }) });
      }
      return route.fulfill({
        status: 200,
        contentType: 'image/webp',
        headers: { ...cors, 'X-Everframe-Render-Meta': JSON.stringify(meta) },
        body: WEBP_1PX,
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{}' });
  });
  return bodies;
}

type Shot = { hasImage: boolean; hasSnapshot: boolean; reason: string | null; snapshotBytes: number[] | null };

async function shoot(page: Page): Promise<Shot> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __everframe: { __adapter: { __tvSnapshotPathActive(): boolean } } }).__everframe.__adapter.__tvSnapshotPathActive()))
    .toBe(true);
  return page.evaluate(async () => {
    const a = (window as unknown as { __everframe: { __adapter: { __captureShot(): Promise<{ image?: unknown; snapshot?: { bytes: Uint8Array }; degradedReason?: string }> } } }).__everframe.__adapter;
    const s = await a.__captureShot();
    return { hasImage: !!s.image, hasSnapshot: !!s.snapshot, reason: s.degradedReason ?? null, snapshotBytes: s.snapshot ? Array.from(s.snapshot.bytes) : null };
  });
}

type SnEl = { type: number; id: number; tagName?: string; textContent?: string; attributes?: Record<string, unknown>; childNodes?: SnEl[] };
type Doc = { events: [{ timestamp: number; data: { width: number; height: number } }, { timestamp: number; data: { node: SnEl; initialOffset: { top: number; left: number } } }]; context: Record<string, unknown> };

function findNode(n: SnEl, pred: (e: SnEl) => boolean): SnEl | undefined {
  if (n.type === 2 && pred(n)) return n;
  for (const c of n.childNodes ?? []) {
    const hit = findNode(c, pred);
    if (hit) return hit;
  }
  return undefined;
}
const byId = (root: SnEl, id: string): SnEl | undefined => findNode(root, (e) => e.attributes?.id === id);
const decode = (bytes: number[] | Buffer): { text: string; doc: Doc } => {
  const text = gunzipSync(Buffer.from(bytes)).toString('utf8');
  return { text, doc: JSON.parse(text) as Doc };
};

type Box = { x: number; y: number };
async function liveBoxes(page: Page, ids: string[]): Promise<Record<string, Box>> {
  return page.evaluate((list) => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const id of list) {
      const b = document.getElementById(id)!.getBoundingClientRect();
      out[id] = { x: b.left, y: b.top };
    }
    return out;
  }, ids);
}

/** Rebuild the snapshot in a second page (sandboxed iframe at 0,0) and measure the same ids. */
async function rebuild(page: Page, doc: Doc, ids: string[]): Promise<{ page: Page; boxes: Record<string, Box | null>; railScrollLeft: number | null }> {
  const rebuildPage = await page.context().newPage();
  await rebuildPage.route(/example\.test/, (route) => route.abort());
  await rebuildPage.goto('/e2e/fixtures/tv-rebuild.html');
  await rebuildPage.waitForFunction(() => typeof (window as unknown as { __rebuild?: unknown }).__rebuild === 'function');
  const out = await rebuildPage.evaluate(
    ([d, list]) =>
      (window as unknown as { __rebuild(x: unknown, ids: string[]): { boxes: Record<string, Box | null>; railScrollLeft: number | null } }).__rebuild(d, list),
    [doc, ids] as const,
  );
  return { page: rebuildPage, ...out };
}

function expectSameBoxes(live: Record<string, Box>, rebuilt: Record<string, Box | null>, tolerance: number): void {
  for (const [id, box] of Object.entries(live)) {
    const other = rebuilt[id];
    expect(other, `#${id} missing from the rebuilt snapshot`).not.toBeNull();
    expect(Math.abs(other!.x - box.x), `#${id} x drifted: live ${box.x}, rebuilt ${other!.x}`).toBeLessThanOrEqual(tolerance);
    expect(Math.abs(other!.y - box.y), `#${id} y drifted: live ${box.y}, rebuilt ${other!.y}`).toBeLessThanOrEqual(tolerance);
  }
}

/** RGBA of one viewport pixel, read by decoding a page screenshot in the browser. */
async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }, png.toString('base64'));
}

/** A snapshot with its capture timestamps zeroed, for comparing two runs. */
function normalized(doc: Doc): Doc {
  const copy = JSON.parse(JSON.stringify(doc)) as Doc;
  copy.events[0].timestamp = 0;
  copy.events[1].timestamp = 0;
  return copy;
}

test('uploads a masked snapshot: no planted secret survives, even inside data: payloads', async ({ page }) => {
  const bodies = await stubApi(page);
  await page.goto('/e2e/fixtures/tv-snapshot.html?access_token=SECRETTOKEN#code=SECRETCODE');
  await page.evaluate(() => window.scrollTo(0, 1200));
  const shot = await shoot(page);
  expect(shot).toMatchObject({ hasImage: true, hasSnapshot: true, reason: null });
  expect(bodies).toHaveLength(1);
  const uploaded = decode(bodies[0]!);
  expect(findLeaks(uploaded.text, SECRETS)).toEqual([]);
  expect(Buffer.from(shot.snapshotBytes!).equals(bodies[0]!)).toBe(true); // the attachment IS the render body
  const input = byId(uploaded.doc.events[1].data.node, 'search');
  expect(input?.attributes?.value).toBe('***');
  // The root scroll travels only as initialOffset; the context has no `scroll`.
  expect(uploaded.doc.events[1].data.initialOffset).toEqual({ top: 1200, left: 0 });
  expect(uploaded.doc.context).not.toHaveProperty('scroll');
});

test('pruned previous screen keeps its height: the rebuilt marker lands where the page drew it, rail scroll kept', async ({ page }) => {
  await stubApi(page);
  await page.goto('/e2e/fixtures/tv-snapshot.html');
  await page.evaluate(() => {
    window.scrollTo(0, 1200);
    document.getElementById('rail')!.scrollLeft = 400;
  });
  const live = await liveBoxes(page, ['marker', 'grid', 'search']);
  const { doc } = decode((await shoot(page)).snapshotBytes!);
  const rebuilt = await rebuild(page, doc, Object.keys(live));
  expectSameBoxes(live, rebuilt.boxes, 2);
  expect(rebuilt.railScrollLeft).toBeGreaterThanOrEqual(398);
});

test('scrolled block page: collapsed margins and a fixed-height section above the viewport do not shift visible content', async ({ page }) => {
  const bodies = await stubApi(page);
  await page.goto('/e2e/fixtures/tv-blocks.html');
  // #now's border box starts after its h2's collapsed 48px margin; scrolling
  // 40px above it puts every earlier section (and the collapsed margins
  // between them) wholly above the viewport.
  await page.evaluate(() => window.scrollTo(0, document.getElementById('now')!.offsetTop - 40));
  const ids = ['now', 'v-head', 'v-para', 'v-icon', 'v-badge', 'v-box'];
  const live = await liveBoxes(page, ids);
  const shot = await shoot(page);
  expect(shot).toMatchObject({ hasImage: true, hasSnapshot: true });
  const { text, doc } = decode(bodies[0]!);
  const root = doc.events[1].data.node;
  // Everything above the viewport really was pruned: its text is gone...
  expect(findLeaks(text, ['OFFSCREENTEXT', 'OFFSCREENICON'])).toEqual([]);
  // ...and the fixed-height section (overflow included, wholly above the
  // viewport) was replaced by a same-height placeholder, which keeps no id.
  expect(byId(root, 'fixed-height')).toBeUndefined();
  const fixedPlaceholder = findNode(root, (e) => e.tagName === 'section' && String(e.attributes?.style ?? '').includes('height:260px !important'));
  expect(fixedPlaceholder, 'fixed-height placeholder').toBeDefined();
  expect(fixedPlaceholder!.childNodes ?? []).toEqual([]);

  const rebuilt = await rebuild(page, doc, ids);
  expectSameBoxes(live, rebuilt.boxes, 1);
});

test('an off-screen icon sprite is pruned while visible <use>, url(#) fill, clip-path and stylesheet refs still resolve', async ({ page }) => {
  await stubApi(page);
  await page.goto('/e2e/fixtures/tv-blocks.html');
  await page.evaluate(() => window.scrollTo(0, document.getElementById('now')!.offsetTop - 40));
  const live = await liveBoxes(page, ['v-icon', 'v-badge']);
  const { text, doc } = decode((await shoot(page)).snapshotBytes!);
  const root = doc.events[1].data.node;
  // The sprite section was pruned (its placeholder keeps no id, no text), and
  // its own rendered <use> went with it: only the visible icon's is left.
  expect(byId(root, 'sprite')).toBeUndefined();
  expect(findLeaks(text, ['OFFSCREENICON'])).toEqual([]);
  expect(byId(root, 'v-use')).toBeDefined();
  expect(findNode(root, (e) => e.tagName === 'use' && e.attributes?.id !== 'v-use')).toBeUndefined();
  for (const id of ['icon-tile', 'grad-brand', 'clip-round']) expect(byId(root, id), `#${id} kept`).toBeDefined();

  const rebuilt = await rebuild(page, doc, ['v-icon', 'v-badge']);
  expectSameBoxes(live, rebuilt.boxes, 1);
  // Same pixels in both: the gradient fill and the round clip resolve.
  const icon = live['v-icon']!;
  const badge = live['v-badge']!;
  const probes: Array<[string, number, number]> = [
    ['icon centre (fill=url(#grad-brand) on <use href=#icon-tile>)', icon.x + 24, icon.y + 24],
    ['icon corner (outside clip-path=url(#clip-round))', icon.x + 3, icon.y + 3],
    ['badge centre (stylesheet fill: url(#grad-brand))', badge.x + 20, badge.y + 10],
  ];
  const red = [221, 34, 34, 255];
  const white = [255, 255, 255, 255];
  const expected = [red, white, red];
  for (const [i, [label, x, y]] of probes.entries()) {
    expect(await pixel(page, x, y), `live ${label}`).toEqual(expected[i]);
    expect(await pixel(rebuilt.page, x, y), `rebuilt ${label}`).toEqual(expected[i]);
  }
});

test('in-viewport content that is hidden, transparent or clipped out of a scrolled rail is pruned; visible layout is kept', async ({ page }) => {
  const bodies = await stubApi(page);
  await page.goto('/e2e/fixtures/tv-hidden.html');
  // 220px = one tile + gap: t-0 now sits wholly left of the rail's padding
  // box, t-4/t-5 wholly right of it, all of them inside the viewport.
  await page.evaluate(() => { document.getElementById('rail')!.scrollLeft = 220; });
  const ids = ['h-head', 't-1', 't-2', 'h-after', 'rail', 'plan', 'after-select'];
  const live = await liveBoxes(page, ids);
  const shot = await shoot(page);
  expect(shot).toMatchObject({ hasImage: true, hasSnapshot: true });
  const { text, doc } = decode(bodies[0]!);
  expect(findLeaks(text, ['HIDDENOVERLAY', '4921', 'FADEDPANEL', 'RAILSCROLLEDOUT', 'RAILCLIPPEDOUT', 'UNSELECTEDOPTION', 'Basic'])).toEqual([]);
  expect(text).toContain('VISIBLETILEONE');
  expect(text).toContain('VISIBLETILETWO');

  const rebuilt = await rebuild(page, doc, ids);
  expectSameBoxes(live, rebuilt.boxes, 1);
  // The pruned tiles kept their boxes, so the rail still scrolls to the same offset.
  expect(rebuilt.railScrollLeft).toBeGreaterThanOrEqual(218);
  // The closed select still shows its selected option — masked, as every
  // input value is — at its live width (#after-select above proves the
  // blanked options did not narrow it).
  const shown = await rebuilt.page.evaluate(() => {
    const d = (window as unknown as { __frame: HTMLIFrameElement }).__frame.contentDocument!;
    const sel = d.getElementById('plan') as HTMLSelectElement;
    return sel.options[sel.selectedIndex]?.textContent ?? null;
  });
  expect(shown).toBe('***');
});

test('keeps focus, dark media, ARIA state, grid areas and SVG refs on a masked page', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await stubApi(page);
  await page.goto('/e2e/fixtures/tv-snapshot.html');
  await page.focus('#tile-2');
  const { text, doc } = decode((await shoot(page)).snapshotBytes!);
  const root = doc.events[1].data.node;
  expect(doc.context).toMatchObject({ platform: 'webos', media: { prefersColorScheme: 'dark' } });
  expect(doc.context.focusedId).toBe(byId(root, 'tile-2')!.id);
  expect(byId(root, 'nav-home')!.attributes).toMatchObject({ 'aria-current': 'page', href: 'https://app.example.test/home' });
  expect(text).toContain('[aria-current=\\"page\\"]'); // JSON-escaped CSS quotes
  expect(text).toContain('grid-template-areas:\\"head head\\" \\"side main\\"');
  expect(findNode(root, (e) => e.tagName === 'use')!.attributes).toEqual({ href: '#play', fill: 'url(#g)' });
  expect(findNode(root, (e) => e.tagName === 'path')!.attributes).toEqual({ d: 'M0 0L10 5L0 10z' });
});

test('reads the render meta header (missingAssetUrls included) cross-origin: a blank render is flagged', async ({ page }) => {
  await stubApi(page, { meta: { ...DEFAULT_META, blank: true } });
  await page.goto('/e2e/fixtures/tv-snapshot.html');
  expect(await shoot(page)).toMatchObject({ hasImage: true, hasSnapshot: true, reason: 'screenshot_blank' });
});

test('a failed render ships the snapshot alone, flagged screenshot_render_failed', async ({ page }) => {
  await stubApi(page, { renderStatus: 503 });
  await page.goto('/e2e/fixtures/tv-snapshot.html');
  expect(await shoot(page)).toMatchObject({ hasImage: false, hasSnapshot: true, reason: 'screenshot_render_failed' });
});

test('a live DOM too deep for rrweb-snapshot falls back without breaking the page', async ({ page }) => {
  const bodies = await stubApi(page);
  await page.goto('/e2e/fixtures/tv-snapshot.html');
  const DEPTH = 12_000;
  await page.evaluate((depth) => {
    // Under a display:none root: Chromium's own layout cannot handle a few
    // thousand nested boxes (the renderer crashes), but a deep hidden subtree
    // is legal and rrweb-snapshot serializes it all the same.
    let parent: HTMLElement = document.getElementById('current')!.appendChild(document.createElement('div'));
    parent.id = 'deep-root';
    parent.style.display = 'none';
    for (let i = 0; i < depth; i++) {
      const div = document.createElement('div');
      div.className = 'deep';
      parent.appendChild(div);
      parent = div;
    }
    // A sensitive element at the bottom: the SDK marks it rr-block before
    // serializing, and must take the class off again when serialization throws.
    const leaf = document.createElement('span');
    leaf.id = 'deep-leaf';
    leaf.setAttribute('data-everframe-sensitive', '');
    leaf.textContent = 'deep leaf';
    parent.appendChild(leaf);
  }, DEPTH);
  // Precondition: this depth really does exhaust rrweb-snapshot's recursion
  // in this browser (otherwise the test would only exercise the depth cap).
  const probe = await page.evaluate(async () => {
    const { snapshot } = (await import('rrweb-snapshot' as string)) as { snapshot(d: Document): unknown };
    try {
      snapshot(document);
      return 'ok';
    } catch (e) {
      return e instanceof RangeError ? 'RangeError' : String(e);
    }
  });
  expect(probe).toBe('RangeError');
  const classesBefore = await page.evaluate(() => {
    // Records every class value the deep sensitive leaf held (old values: the
    // callback runs after the synchronous capture has already restored them),
    // to prove the leaf itself was blocked and so really had to be restored.
    const seen: string[] = [];
    (window as unknown as { __classesSeen: string[] }).__classesSeen = seen;
    new MutationObserver((records) => {
      for (const r of records) if ((r.target as Element).id === 'deep-leaf') seen.push(r.oldValue ?? '');
    }).observe(document.body, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class'] });
    return [document.getElementById('vault')!.className, document.getElementById('deep-leaf')!.className];
  });

  const shot = await shoot(page);
  // No snapshot, no render request; the on-device fallback is skipped above
  // 3000 elements, so the shot is honestly unavailable rather than blank.
  expect(shot).toMatchObject({ hasImage: false, hasSnapshot: false, reason: 'screenshot_unavailable' });
  expect(bodies).toHaveLength(0);

  const after = await page.evaluate(() => {
    let depth = 0;
    for (let n = document.getElementById('deep-leaf')!.parentElement; n?.classList.contains('deep'); n = n.parentElement) depth++;
    return {
      masked: document.querySelectorAll('.rr-block, .rr-mask').length,
      classes: [document.getElementById('vault')!.className, document.getElementById('deep-leaf')!.className],
      chain: depth,
      leafText: document.getElementById('deep-leaf')!.textContent,
      blockedDuringCapture: (window as unknown as { __classesSeen: string[] }).__classesSeen.some((c) => c.split(' ').includes('rr-block')),
    };
  });
  expect(after).toEqual({ masked: 0, classes: classesBefore, chain: DEPTH, leafText: 'deep leaf', blockedDuringCapture: true });
});

test('the committed sample snapshot is what the SDK produces today', async ({ page }) => {
  await stubApi(page);
  await page.goto('/e2e/fixtures/tv-snapshot.html');
  await page.focus('#tile-3');
  await page.evaluate(() => {
    window.scrollTo(0, 1200);
    document.getElementById('rail')!.scrollLeft = 400;
  });
  const { text, doc } = decode((await shoot(page)).snapshotBytes!);
  expect(findLeaks(text, SECRETS)).toEqual([]);
  if (process.env.EVERFRAME_WRITE_TV_FIXTURE === '1') {
    // Deterministic bytes: the fixture's timestamps are zeroed and gzip runs
    // here, not in the browser, so a regeneration with no change is a no-op diff.
    writeFileSync(SAMPLE_FIXTURE, gzipSync(Buffer.from(JSON.stringify(normalized(doc))), { level: 9 }));
  }
  const committed = JSON.parse(gunzipSync(readFileSync(SAMPLE_FIXTURE)).toString('utf8')) as Doc;
  expect(parseDomSnapshot(committed).ok).toBe(true);
  expect(committed.context.focusedId).toBe(byId(committed.events[1].data.node, 'tile-3')!.id);
  expect(committed.events[1].data.initialOffset).toEqual({ top: 1200, left: 0 });
  expect(byId(committed.events[1].data.node, 'rail')!.attributes).toMatchObject({ rr_scrollLeft: 400 });
  expect(normalized(doc), 'SDK output drifted from fixtures/tv-snapshot.sample.json.gz; regenerate with EVERFRAME_WRITE_TV_FIXTURE=1').toEqual(committed);
});

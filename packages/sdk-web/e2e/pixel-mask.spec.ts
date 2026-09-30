// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The final pixel-mask pass (src/capture/pixel-mask.ts): whatever a renderer
// did with its clone, every pixel inside a sensitive element's live rects
// ships black, and the page a few pixels away is untouched. One test per
// round-11 leak.
import { test, expect, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

type Rect = { x: number; y: number; width: number; height: number };
type Result = {
  renderer?: string;
  rects: Rect[];
  brightest: number;
  pixels: number;
  neighbour: number[];
  darkest: number;
  mixed: boolean;
};

/**
 * Black-check every live rect and sample one neighbour point on a capture
 * blob. Runs in the page; `scale` maps viewport CSS px onto the bitmap.
 */
const INSPECT = `async (blob, rects, neighbour, clean = []) => {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const scale = bmp.width / window.innerWidth;
  let brightest = 0;
  let pixels = 0;
  for (const r of rects) {
    const x0 = Math.floor(r.x * scale);
    const y0 = Math.floor(r.y * scale);
    const w = Math.ceil((r.x + r.width) * scale) - x0;
    const h = Math.ceil((r.y + r.height) * scale) - y0;
    const d = ctx.getImageData(x0, y0, w, h).data;
    for (let i = 0; i < d.length; i += 4) brightest = Math.max(brightest, d[i], d[i + 1], d[i + 2]);
    pixels += d.length / 4;
  }
  const n = Array.from(ctx.getImageData(Math.round(neighbour[0] * scale), Math.round(neighbour[1] * scale), 1, 1).data);
  // Across the regions that must not show content: the darkest pixel (by its
  // brightest channel), and whether dark and bright pixels mix there (glyphs).
  let darkest = 255;
  let dark = 0;
  let bright = 0;
  for (const r of clean) {
    const d = ctx.getImageData(Math.floor(r.x * scale), Math.floor(r.y * scale), Math.ceil(r.width * scale), Math.ceil(r.height * scale)).data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.max(d[i], d[i + 1], d[i + 2]);
      darkest = Math.min(darkest, v);
      if (v < 40) dark++;
      if (v > 150) bright++;
    }
  }
  return { brightest, pixels, neighbour: n, darkest, mixed: dark > 0 && bright > 0 };
}`;

/** Capture through the real adapter; `prepare` returns the live rects and a neighbour point. */
async function captureAdapter(page: Page, scenario: 'stroke' | 'slot' | 'backdrop' | 'shadow' | 'scroller' | 'direct'): Promise<Result> {
  return page.evaluate(
    async ({ scenario, inspectSrc }) => {
      const inspect = (0, eval)(inspectSrc) as (b: Blob, r: Rect[], n: [number, number], clean?: Rect[]) => Promise<Omit<Result, 'renderer' | 'rects'>>;
      const w = window as unknown as {
        __everframe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }>; __lastScreenshotRenderer?: string } };
      };
      const plain = (list: ArrayLike<DOMRect>): Rect[] =>
        Array.from(list, (r) => ({ x: r.left, y: r.top, width: r.width, height: r.height })).filter((r) => r.width > 0 && r.height > 0);
      let rects: Rect[];
      let neighbourOf: Element;
      let clean: Rect[] = [];
      if (scenario === 'stroke') {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('stroke-wrap')!);
        rects = plain(range.getClientRects());
        neighbourOf = document.getElementById('stroke-line')!;
      } else if (scenario === 'slot') {
        rects = plain(document.getElementById('slotted')!.getClientRects());
        neighbourOf = document.getElementById('slotted')!;
      } else if (scenario === 'shadow') {
        const span = document.getElementById('shadowed')!;
        rects = plain(span.getClientRects());
        neighbourOf = document.getElementById('shadow-vault')!;
        // Where the span's 40px-down text-shadow would paint.
        clean = rects.map((r) => ({ x: r.x, y: r.y + 40, width: r.width, height: r.height }));
      } else if (scenario === 'direct') {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById('direct-vault')!);
        rects = plain(range.getClientRects());
        neighbourOf = document.getElementById('direct-vault')!;
        // Where the 40px-down text-shadow would paint, clear of the (inflated) mask above it.
        clean = rects.map((r) => ({ x: r.x, y: r.y + 40, width: r.width, height: r.height }));
      } else if (scenario === 'scroller') {
        rects = plain(document.getElementById('scroller')!.getClientRects());
        neighbourOf = document.getElementById('scroller')!;
        // The public box right below the scroller, 2000px of scrolled content "over" it.
        const pub = document.getElementById('below-scroller')!.getBoundingClientRect();
        clean = [{ x: pub.left + 4, y: pub.top + 4, width: pub.width - 8, height: pub.height - 8 }];
      } else {
        rects = plain(document.getElementById('bd-text')!.getClientRects());
        neighbourOf = document.getElementById('bd-text')!;
      }
      // A point on the blue page 8 px below the element's box - or, where a
      // text-shadow paints below, 8 px right of the last text run.
      const b = neighbourOf.getBoundingClientRect();
      const last = rects[rects.length - 1];
      const neighbour: [number, number] =
        (scenario === 'shadow' || scenario === 'direct') && last
          ? [last.x + last.width + 8, last.y + last.height / 2]
          : [b.left + 20, b.bottom + 8];
      let shot: Promise<{ blob: Blob }>;
      if (scenario === 'backdrop') {
        // The text becomes sensitive while the capture is already running.
        shot = w.__everframe.__adapter.captureScreenshot();
        await new Promise((r) => setTimeout(r, 0));
        document.getElementById('bd-text')!.setAttribute('data-everframe-sensitive', '');
      } else {
        shot = w.__everframe.__adapter.captureScreenshot();
      }
      const out = await inspect((await shot).blob, rects, neighbour, clean);
      return { renderer: w.__everframe.__adapter.__lastScreenshotRenderer, rects, ...out };
    },
    { scenario, inspectSrc: INSPECT },
  );
}

const isBlue = (px: number[]): boolean => Math.abs(px[0]! - 0) <= 40 && Math.abs(px[1]! - 120) <= 40 && Math.abs(px[2]! - 255) <= 40;

function expectMasked(r: Result): void {
  expect(r.rects.length).toBeGreaterThan(0);
  expect(r.pixels).toBeGreaterThan(100);
  expect(r.brightest).toBeLessThanOrEqual(8); // every pixel inside the live rects black
  expect(isBlue(r.neighbour), `neighbour ${r.neighbour.join(',')}`).toBe(true);
}

test('stroked text in a sensitive display:contents wrapper ships black', async ({ page }) => {
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await captureAdapter(page, 'stroke');
  expect(r.renderer).toBe('snapdom');
  expectMasked(r);
});

test('slotted private text under a sensitive <slot> ships black', async ({ page }) => {
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await captureAdapter(page, 'slot');
  expect(r.renderer).toBe('snapdom');
  expectMasked(r);
});

test('text under a backdrop-filter overlay that turns sensitive mid-capture ships black', async ({ page }) => {
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await captureAdapter(page, 'backdrop');
  expect(r.renderer).toBe('snapdom');
  expectMasked(r);
});

test('slotted text under a sensitive <slot> ships no text-shadow outside the black box', async ({ page }) => {
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await captureAdapter(page, 'shadow');
  expect(r.renderer).toBe('snapdom');
  expectMasked(r);
  expect(r.mixed).toBe(false); // no shadow glyphs 40px below: uniformly page or mask
});

test('a sensitive scroller is black; public content below it is not blacked out by its scrolled content', async ({ page }) => {
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await captureAdapter(page, 'scroller');
  expect(r.renderer).toBe('snapdom');
  expect(r.rects.length).toBeGreaterThan(0);
  expect(r.brightest).toBeLessThanOrEqual(8);
  expect(r.darkest).toBeGreaterThan(150); // the green box below, untouched
});

test('bare text slotted into a sensitive <slot> ships black, its displaced text-shadow too', async ({ page }) => {
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await captureAdapter(page, 'direct');
  expect(r.renderer).toBe('snapdom');
  expect(r.rects.length).toBeGreaterThan(0);
  expect(r.pixels).toBeGreaterThan(100);
  expect(r.brightest).toBeLessThanOrEqual(8);
  // No readable shadow glyphs: the region is uniformly masked black or plain page, never a mix.
  expect(r.mixed).toBe(false);
});

test('SDK chrome that is both excluded and sensitive leaves no black box over the app', async ({ page }) => {
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await page.evaluate(async () => {
    const w = window as unknown as {
      __everframe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }>; __lastScreenshotRenderer?: string } };
    };
    const b = document.getElementById('badge')!.getBoundingClientRect();
    const shot = await w.__everframe.__adapter.captureScreenshot();
    const bmp = await createImageBitmap(shot.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const scale = bmp.width / window.innerWidth;
    const d = ctx.getImageData(Math.floor(b.left * scale), Math.floor(b.top * scale), Math.floor(b.width * scale), Math.floor(b.height * scale)).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i]!, d[i + 1]!, d[i + 2]!) < 40) dark++;
    return { renderer: w.__everframe.__adapter.__lastScreenshotRenderer, dark, pixels: d.length / 4 };
  });
  expect(r.renderer).toBe('snapdom');
  expect(r.pixels).toBeGreaterThan(1000);
  expect(r.dark).toBe(0); // the page under the badge, not a black box (nor the badge itself)
});

// captureScreenshot with a custom root is not on the published surface: the
// spec bundles the SOURCE module (its renderers resolve through the fixture's
// import map, like the built entry's do) and serves it to the page.
let screenshotModule = '';
test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../src/capture/screenshot.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external: ['modern-screenshot', '@zumer/snapdom'],
  });
  screenshotModule = out.outputFiles[0]!.text;
});

test('a sensitive <img> captured as the root ships black', async ({ page }) => {
  await page.route('**/__e2e/screenshot.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: screenshotModule }),
  );
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await page.evaluate(async (inspectSrc) => {
    const inspect = (0, eval)(inspectSrc) as (b: Blob, r: Rect[], n: [number, number]) => Promise<Omit<Result, 'renderer' | 'rects'>>;
    const img = document.getElementById('secret-img') as HTMLImageElement;
    await img.decode();
    const mod = (await import('/__e2e/screenshot.js' as string)) as {
      captureScreenshot(o: Record<string, unknown>): Promise<{ blob: Blob }>;
    };
    let renderer: string | undefined;
    const b = img.getBoundingClientRect();
    const rects = [{ x: b.left, y: b.top, width: b.width, height: b.height }];
    const shot = await mod.captureScreenshot({
      root: img,
      maskTargets: [img],
      isSensitive: (el: Element) => el.hasAttribute('data-everframe-sensitive'),
      __setRenderer: (x: string) => {
        renderer = x;
      },
    });
    // Right of the image: outside the root, so the capture background.
    const out = await inspect(shot.blob, rects, [b.right + 8, b.top + 20]);
    return { renderer, rects, ...out };
  }, INSPECT);
  expect(r.renderer).toBe('snapdom');
  expect(r.pixels).toBeGreaterThan(100);
  expect(r.brightest).toBeLessThanOrEqual(8);
  // Untouched: not painted black (the root's surroundings are the white capture background).
  expect(Math.max(...r.neighbour.slice(0, 3))).toBeGreaterThan(200);
});

// ── The modern-screenshot fallback's canvas mapping ─────────────────────────
// snapDOM is replaced by a module that throws, so the fallback renders. Its
// live-DOM mask leaves an inherited text stroke and an <img>'s own pixels in
// place, so black here can only come from the pixel-mask pass - landing where
// the fallback actually drew the element.
async function breakSnapdom(page: Page): Promise<void> {
  // The built entry carries snapDOM in its own lazy chunk; the source module
  // resolves it through the import map.
  const blocked = 'export const snapdom = () => { throw new Error("blocked"); }; export { snapdom as X };';
  await page.route(/\/(vendor\/snapdom|dist\/snapdom-[^/]*)\.js$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: blocked }),
  );
  await page.route('**/__e2e/screenshot.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: screenshotModule }),
  );
}

test('fallback, <body> root, scrolled: stroked sensitive text ships black at its live rect', async ({ page }) => {
  await breakSnapdom(page);
  await page.goto('/e2e/fixtures/pixel-mask.html');
  await page.evaluate(() => window.scrollTo(0, 30));
  const r = await captureAdapter(page, 'stroke');
  expect(r.renderer).toBe('modern-screenshot');
  expectMasked(r);
});

test('fallback, custom root: stroked sensitive text ships black where the root-relative render put it', async ({ page }) => {
  await breakSnapdom(page);
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await page.evaluate(async (inspectSrc) => {
    const inspect = (0, eval)(inspectSrc) as (b: Blob, r: Rect[], n: [number, number]) => Promise<Omit<Result, 'renderer' | 'rects'>>;
    const root = document.getElementById('stroke-line')!;
    const mod = (await import('/__e2e/screenshot.js' as string)) as {
      captureScreenshot(o: Record<string, unknown>): Promise<{ blob: Blob }>;
    };
    let renderer: string | undefined;
    // The fallback draws a custom root from the canvas origin.
    const o = root.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('stroke-wrap')!);
    const rects = Array.from(range.getClientRects(), (b) => ({ x: b.left - o.left, y: b.top - o.top, width: b.width, height: b.height }));
    const last = rects[rects.length - 1]!;
    const shot = await mod.captureScreenshot({
      root,
      maskTargets: () => Array.from(document.querySelectorAll('[data-everframe-sensitive]')),
      isSensitive: (el: Element) => el.hasAttribute('data-everframe-sensitive'),
      __setRenderer: (x: string) => {
        renderer = x;
      },
    });
    const out = await inspect(shot.blob, rects, [last.x + last.width + 8, last.y + last.height / 2]);
    return { renderer, rects, ...out };
  }, INSPECT);
  expect(r.renderer).toBe('modern-screenshot');
  expect(r.pixels).toBeGreaterThan(100);
  expect(r.brightest).toBeLessThanOrEqual(8);
  expect(Math.max(...r.neighbour.slice(0, 3))).toBeGreaterThan(200); // the root's white capture background
});

test('fallback, sensitive <img> root: no image pixel ships', async ({ page }) => {
  await breakSnapdom(page);
  await page.goto('/e2e/fixtures/pixel-mask.html');
  const r = await page.evaluate(async () => {
    const img = document.getElementById('secret-img') as HTMLImageElement;
    await img.decode();
    const mod = (await import('/__e2e/screenshot.js' as string)) as {
      captureScreenshot(o: Record<string, unknown>): Promise<{ blob: Blob }>;
    };
    let renderer: string | undefined;
    const shot = await mod.captureScreenshot({
      root: img,
      maskTargets: [img],
      isSensitive: (el: Element) => el.hasAttribute('data-everframe-sensitive'),
      __setRenderer: (x: string) => {
        renderer = x;
      },
    });
    const bmp = await createImageBitmap(shot.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    let black = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! > 150 && d[i + 1]! < 100 && d[i + 2]! < 100) red++;
      if (d[i]! < 9 && d[i + 1]! < 9 && d[i + 2]! < 9) black++;
    }
    return { renderer, red, black, w: bmp.width };
  });
  expect(r.renderer).toBe('modern-screenshot');
  expect(r.red).toBe(0);
  expect(r.black).toBeGreaterThan(1000);
});

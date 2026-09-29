// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect, type Page } from '@playwright/test';

type Probe = { renderer?: string; reason?: string; w: number; h: number; samples: Record<string, number[]> };

/** Capture through the real adapter, then sample pixel colours at named viewport points (CSS px). */
async function captureAndSample(page: Page, points: Record<string, [number, number]>): Promise<Probe> {
  return page.evaluate(async (pts) => {
    const w = window as unknown as {
      __everframe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }>; __lastScreenshotRenderer?: string; __lastDegradedReason?: string } };
    };
    const shot = await w.__everframe.__adapter.captureScreenshot();
    const bmp = await createImageBitmap(shot.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const scale = bmp.width / window.innerWidth;
    const samples: Record<string, number[]> = {};
    for (const [name, [x, y]] of Object.entries(pts)) {
      samples[name] = Array.from(ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data);
    }
    return {
      renderer: w.__everframe.__adapter.__lastScreenshotRenderer,
      reason: w.__everframe.__adapter.__lastDegradedReason,
      w: bmp.width,
      h: bmp.height,
      samples,
    };
  }, points);
}

const near = (a: number[], b: number[], tol = 40): boolean => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]!) <= tol);

test('sparse page: a single short line on a white page is captured by snapdom, not flagged blank', async ({ page }) => {
  await page.goto('/e2e/fixtures/sparse.html');
  const r = await captureAndSample(page, {});
  expect(r.renderer).toBe('snapdom');
  expect(r.reason).toBeUndefined();
});

test('sparse page with the line removed is flagged screenshot_blank', async ({ page }) => {
  await page.goto('/e2e/fixtures/sparse.html?empty=1');
  const r = await captureAndSample(page, {});
  expect(r.reason).toBe('screenshot_blank');
});

test('scrolled page shows the scrolled content, masks the sensitive box, keeps video layout', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => document.getElementById('dark')!.scrollIntoView());
  const pos = await page.evaluate(() => {
    const c = (id: string): [number, number] => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    };
    return { secret: c('secret'), after: c('after-video'), bg: [800, 600] as [number, number] };
  });
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.bg!, [13, 17, 23])).toBe(true);        // dark section, not the white top
  expect(near(r.samples.secret!, [0, 0, 0])).toBe(true);        // masked solid black
  expect(near(r.samples.after!, [0, 200, 0])).toBe(true);       // video box kept, nothing shifted
});

test('nested scroll container shows its scrolled position', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => {
    const nested = document.getElementById('nested')!;
    nested.scrollIntoView();
    nested.scrollTop = 800;
  });
  const pos = await page.evaluate(() => {
    const b = document.getElementById('nested-marker')!.getBoundingClientRect();
    return { marker: [b.left + 20, b.top + 20] as [number, number] };
  });
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.marker!, [255, 0, 255])).toBe(true);
});

test('scroller child with a class-applied transform keeps it and the scroll offset', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => {
    const el = document.getElementById('classy')!;
    el.scrollIntoView();
    el.scrollTop = 800;
  });
  const pos = await page.evaluate(() => {
    const b = document.getElementById('classy-marker')!.getBoundingClientRect();
    return {
      marker: [b.left + 20, b.top + 20] as [number, number],
      // the un-shifted x position must NOT be coloured
      unshifted: [b.left - 20, b.top + 20] as [number, number],
    };
  });
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.marker!, [0, 0, 255])).toBe(true);
  expect(near(r.samples.unshifted!, [255, 255, 255])).toBe(true);
});

test('scroller child with an individual scale keeps it without scaling the scroll offset', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => {
    const el = document.getElementById('scaled')!;
    el.scrollIntoView();
    el.scrollTop = 800;
  });
  const pos = await page.evaluate(() => {
    const b = document.getElementById('scaled-marker')!.getBoundingClientRect();
    return {
      marker: [b.left + 40, b.top + b.height / 2] as [number, number],
      above: [b.left + 40, b.top - 20] as [number, number],
    };
  });
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.marker!, [0, 200, 200])).toBe(true);
  expect(near(r.samples.above!, [255, 255, 255])).toBe(true);
});

test('an absolute grandchild anchored to a positioned scroller stays where it is seen', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => {
    const el = document.getElementById('cb-rebase')!;
    el.scrollIntoView();
    el.scrollTop = 100;
  });
  const pos = await page.evaluate(() => {
    const b = document.getElementById('cb-rebase-marker')!.getBoundingClientRect();
    const s = document.getElementById('cb-rebase')!.getBoundingClientRect();
    return {
      offset: b.top - s.top, // 150 - 100 = 50 live
      marker: [b.left + 40, b.top + b.height / 2] as [number, number],
      // Where a re-anchored marker would land (50px lower): must stay white.
      wrong: [b.left + 40, b.top + 50 + b.height / 2] as [number, number],
    };
  });
  expect(pos.offset).toBeCloseTo(50, 0);
  const r = await captureAndSample(page, { marker: pos.marker, wrong: pos.wrong });
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.marker!, [200, 0, 100])).toBe(true);
  expect(near(r.samples.wrong!, [255, 255, 255])).toBe(true);
});

test('scroller with plain in-flow rows shows each row at its live position (one restoration, not two)', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => {
    const el = document.getElementById('rows')!;
    el.scrollIntoView();
    el.scrollTop = 600; // row 10 at the top of the scroller
  });
  const probe = await page.evaluate(() => {
    const at = (id: string): [number, number] => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return [b.left + 20, b.top + b.height / 2];
    };
    const colour = (id: string): number[] =>
      (getComputedStyle(document.getElementById(id)!).backgroundColor.match(/\d+/g) ?? []).map(Number);
    return {
      pos: { row10: at('rows-10'), row12: at('rows-12'), row14: at('rows-14') },
      colours: { row10: colour('rows-10'), row12: colour('rows-12'), row14: colour('rows-14') },
    };
  });
  const r = await captureAndSample(page, probe.pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.row10!, probe.colours.row10, 30)).toBe(true);
  expect(near(r.samples.row12!, probe.colours.row12, 30)).toBe(true);
  expect(near(r.samples.row14!, probe.colours.row14, 30)).toBe(true);
});

/**
 * Scroll `id`, then for each point (CSS px relative to the scroller's box)
 * record the viewport position and the live colour of whatever the user sees
 * there (elementFromPoint), so assertions never hard-code layout.
 */
async function scrollAndProbe(
  page: Page,
  id: string,
  scroll: { left?: number; top?: number },
  points: Record<string, [number, number]>,
  extra: Record<string, string> = {},
): Promise<{ pos: Record<string, [number, number]>; colours: Record<string, number[]> }> {
  return page.evaluate(
    ({ id, scroll, points, extra }) => {
      const el = document.getElementById(id)!;
      el.scrollIntoView({ block: 'center' });
      el.scrollLeft = scroll.left ?? 0;
      el.scrollTop = scroll.top ?? 0;
      const rgb = (node: Element): number[] =>
        (getComputedStyle(node).backgroundColor.match(/\d+/g) ?? []).map(Number);
      const box = el.getBoundingClientRect();
      const pos: Record<string, [number, number]> = {};
      const colours: Record<string, number[]> = {};
      for (const [name, [x, y]] of Object.entries(points)) {
        pos[name] = [box.left + x, box.top + y];
        colours[name] = rgb(document.elementFromPoint(box.left + x, box.top + y)!);
      }
      for (const [name, otherId] of Object.entries(extra)) {
        const b = document.getElementById(otherId)!.getBoundingClientRect();
        pos[name] = [b.left + 20, b.top + b.height / 2];
        colours[name] = rgb(document.getElementById(otherId)!);
      }
      return { pos, colours };
    },
    { id, scroll, points, extra },
  );
}

function expectColoursAt(r: Probe, expected: Record<string, number[]>): void {
  for (const [name, colour] of Object.entries(expected)) {
    const sample = r.samples[name]!;
    expect(near(sample, colour, 30), `${name}: captured ${sample.slice(0, 3)} vs live ${colour}`).toBe(true);
  }
}

test('stylesheet-sized scroller keeps its height and clipping: rows at live positions, content below untouched', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const probe = await scrollAndProbe(
    page,
    'css-rows',
    { top: 600 },
    { top: [20, 30], middle: [20, 150], bottom: [20, 270] },
    { below: 'below-css-rows' },
  );
  const r = await captureAndSample(page, probe.pos);
  expect(r.renderer).toBe('snapdom');
  expectColoursAt(r, probe.colours);
});

test('stylesheet-sized scroller with a fixed child keeps its height and clipping', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const probe = await scrollAndProbe(
    page,
    'css-rows-fixed',
    { top: 600 },
    { top: [20, 30], middle: [20, 150], bottom: [20, 270] },
    { below: 'below-css-rows-fixed' },
  );
  const r = await captureAndSample(page, probe.pos);
  expect(r.renderer).toBe('snapdom');
  expectColoursAt(r, probe.colours);
});

test('horizontally scrolled flex carousel keeps its row layout and scroll offset', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const probe = await scrollAndProbe(page, 'carousel', { left: 450 }, {
    a: [20, 50],
    b: [120, 50],
    c: [300, 50],
    d: [480, 50],
  });
  const r = await captureAndSample(page, probe.pos);
  expect(r.renderer).toBe('snapdom');
  expectColoursAt(r, probe.colours);
});

test('scrolled grid scroller keeps its grid layout and scroll offset', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const probe = await scrollAndProbe(page, 'grid', { top: 170 }, {
    a: [40, 20],
    b: [200, 20],
    c: [40, 120],
    d: [200, 180],
  });
  const r = await captureAndSample(page, probe.pos);
  expect(r.renderer).toBe('snapdom');
  expectColoursAt(r, probe.colours);
});

test('a capture root that scrolls on its own (html overflow hidden) renders at its scroll and masks the sensitive box there', async ({ page }) => {
  await page.goto('/e2e/fixtures/scrolling-body.html');
  const pos = await page.evaluate(() => {
    document.body.scrollTop = 300;
    const at = (id: string): [number, number] => {
      const b = document.getElementById(id)!.getBoundingClientRect();
      return [b.left + 40, b.top + b.height / 2];
    };
    return { marker: at('marker'), secret: at('secret'), top: [40, 50] as [number, number] };
  });
  // Live: marker at y~100-200, secret at y~200-300, white above.
  expect(pos.marker[1]).toBeCloseTo(150, 0);
  const r = await captureAndSample(page, pos);
  expect(r.renderer).toBe('snapdom');
  expect(near(r.samples.top!, [255, 255, 255])).toBe(true);
  expect(near(r.samples.marker!, [0, 160, 0])).toBe(true);
  expect(near(r.samples.secret!, [0, 0, 0])).toBe(true);
});

test('an app update to ellipsized text during capture is kept and no text node is left emptied', async ({ page }) => {
  await page.goto('/e2e/fixtures/ellipsis.html');
  const r = await page.evaluate(async () => {
    const w = window as unknown as {
      __everframe: { __adapter: { captureScreenshot(): Promise<unknown>; __lastScreenshotRenderer?: string } };
    };
    const price = document.getElementById('price')!;
    const [amount, suffix] = Array.from(price.childNodes) as Text[];
    let captureMeasuredLiveText = false;
    let intactWhenAppRan = false;
    // snapDOM measures the ellipsis by writing the live text synchronously
    // and (patched) restores it before returning; the app updates the price
    // the moment control returns to it, while the capture is still running.
    const mo = new MutationObserver((records) => {
      mo.disconnect();
      captureMeasuredLiveText = records.length > 0;
      intactWhenAppRan = amount!.data === '$1,234,567.00' && suffix!.data === ' / month';
      amount!.data = '$9.99';
    });
    mo.observe(price, { characterData: true, subtree: true });
    await w.__everframe.__adapter.captureScreenshot();
    mo.disconnect();
    return {
      captureMeasuredLiveText,
      intactWhenAppRan,
      renderer: w.__everframe.__adapter.__lastScreenshotRenderer,
      amount: amount!.data,
      suffix: suffix!.data,
      text: price.textContent,
      sameNodes: price.firstChild === amount && price.lastChild === suffix,
    };
  });
  expect(r.renderer).toBe('snapdom');
  expect(r.captureMeasuredLiveText).toBe(true); // the scenario actually happened
  expect(r.intactWhenAppRan).toBe(true); // the page never sees the rewrite
  expect(r.amount).toBe('$9.99'); // the app's update survives
  expect(r.suffix).toBe(' / month'); // capture never leaves a node emptied
  expect(r.text).toBe('$9.99 / month');
  expect(r.sameNodes).toBe(true);
});

test('grid with justify-content: space-between keeps its second column at its live x', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const probe = await scrollAndProbe(page, 'grid-sb', { top: 100 }, {
    first: [40, 30],
    second: [340, 30], // live second column: x 300..400
    gap: [200, 30], // between the tracks: scroller background
  });
  const r = await captureAndSample(page, probe.pos);
  expect(r.renderer).toBe('snapdom');
  expectColoursAt(r, probe.colours);
});

test('snapDOM masks a sensitive element on the clone: black at its live rect, the live element never restyled', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  await page.evaluate(() => document.getElementById('dark')!.scrollIntoView());
  const pos = await page.evaluate(() => {
    const b = document.getElementById('secret')!.getBoundingClientRect();
    const w = window as unknown as { __secretMutations: number };
    w.__secretMutations = 0;
    new MutationObserver((records) => {
      w.__secretMutations += records.length;
    }).observe(document.getElementById('secret')!, { attributes: true, childList: true, subtree: true, characterData: true });
    return {
      centre: [b.left + b.width / 2, b.top + b.height / 2] as [number, number],
      left: [b.left + 6, b.top + b.height / 2] as [number, number],
      right: [b.right - 6, b.top + b.height / 2] as [number, number],
    };
  });
  const r = await captureAndSample(page, pos);
  const mutations = await page.evaluate(() => (window as unknown as { __secretMutations: number }).__secretMutations);
  expect(r.renderer).toBe('snapdom');
  expect(mutations).toBe(0);
  for (const name of ['centre', 'left', 'right']) expect(near(r.samples[name]!, [0, 0, 0]), name).toBe(true);
});

test('a checked appearance:none checkbox marked sensitive ships as a plain black box', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const r = await page.evaluate(async () => {
    const el = document.getElementById('consent-box')!;
    el.scrollIntoView({ block: 'center' });
    const w = window as unknown as {
      __everframe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }>; __lastScreenshotRenderer?: string } };
    };
    const shot = await w.__everframe.__adapter.captureScreenshot();
    const bmp = await createImageBitmap(shot.blob);
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const scale = bmp.width / window.innerWidth;
    const b = el.getBoundingClientRect();
    // Every pixel inside the box, 5px in from its edge (the 4px rounded
    // corners and anti-aliasing): a synthesized checkmark is thin, so spot
    // samples could miss it.
    const x0 = Math.ceil((b.left + 5) * scale);
    const y0 = Math.ceil((b.top + 5) * scale);
    const w0 = Math.floor((b.width - 10) * scale);
    const h0 = Math.floor((b.height - 10) * scale);
    const data = ctx.getImageData(x0, y0, w0, h0).data;
    let brightest = 0;
    for (let i = 0; i < data.length; i += 4) brightest = Math.max(brightest, data[i]!, data[i + 1]!, data[i + 2]!);
    return { renderer: w.__everframe.__adapter.__lastScreenshotRenderer, brightest, pixels: data.length / 4 };
  });
  expect(r.renderer).toBe('snapdom');
  expect(r.pixels).toBeGreaterThan(100);
  expect(r.brightest).toBeLessThanOrEqual(40);
});

test('a script edit to an existing stylesheet rule shows up in the next capture', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html');
  const pos = await page.evaluate(() => {
    const el = document.getElementById('cx')!;
    el.scrollIntoView();
    const b = el.getBoundingClientRect();
    return { cx: [b.left + b.width / 2, b.top + b.height / 2] as [number, number] };
  });
  const first = await captureAndSample(page, pos);
  expect(first.renderer).toBe('snapdom');
  expect(near(first.samples.cx!, [0, 0, 255])).toBe(true);

  await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule && rule.selectorText === '.cx') rule.style.background = 'rgb(0,255,0)';
      }
    }
  });
  const second = await captureAndSample(page, pos);
  expect(second.renderer).toBe('snapdom');
  expect(near(second.samples.cx!, [0, 255, 0])).toBe(true);
});

test('15k-node page is captured by snapdom and is not blank', async ({ page }) => {
  await page.goto('/e2e/fixtures/capture-cases.html?bulk=15000');
  const r = await captureAndSample(page, {});
  expect(r.renderer).toBe('snapdom');
  expect(r.reason).toBeUndefined();
});

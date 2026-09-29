// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// snapDOM captures a same-origin iframe with a nested capture of its
// document. Stock snapDOM pinned the LIVE iframe <html>/<body> to the
// iframe's size (an injected stylesheet) for that nested capture: a short
// flex body grew to the iframe height, re-centering its content, both on the
// page while the capture ran and in the shot. patches/@zumer__snapdom pins
// the nested CLONE instead.
import { test, expect } from '@playwright/test';

for (const htmlBg of ['rgb(255,255,255)', null] as const) {
  test(`a same-origin iframe is captured without restyling its live document, content at its live y (html background ${htmlBg ?? 'none'})`, async ({ page }) => {
    await page.goto('/e2e/fixtures/plain.html');
    const r = await page.evaluate(async (htmlBg) => {
      document.body.style.background = '#fff';
      document.querySelector('main')!.remove();
      const frame = document.createElement('iframe');
      frame.style.cssText = 'display:block;position:absolute;left:40px;top:40px;width:300px;height:300px;border:0';
      frame.srcdoc =
        '<!doctype html><html><head><style>' + (htmlBg ? `html{background:${htmlBg}}` : '') +
        'body{margin:0;height:100px;display:flex;align-items:center;background:rgb(0,120,255)}' +
        '#dot{width:300px;height:20px;background:rgb(255,0,255)}</style></head>' +
        '<body><div id="dot"></div></body></html>';
      await new Promise((resolve) => {
        frame.onload = resolve;
        document.body.appendChild(frame);
      });
      const doc = frame.contentDocument!;
      const win = frame.contentWindow!;
      const liveDotTop = frame.getBoundingClientRect().top + doc.getElementById('dot')!.getBoundingClientRect().top;
      // Watch the live iframe document for as long as the capture runs.
      let maxBodyHeight = 0;
      let injected = 0;
      const sample = (): void => {
        maxBodyHeight = Math.max(maxBodyHeight, parseFloat(win.getComputedStyle(doc.body).height));
      };
      const mo = new MutationObserver((records) => {
        for (const rec of records) injected += rec.addedNodes.length;
        sample();
      });
      mo.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
      let running = true;
      const loop = (): void => {
        sample();
        if (running) requestAnimationFrame(loop);
      };
      loop();
      const w = window as unknown as {
        __everframe: { __adapter: { captureScreenshot(): Promise<{ blob: Blob }>; __lastScreenshotRenderer?: string } };
      };
      const shot = await w.__everframe.__adapter.captureScreenshot();
      running = false;
      mo.disconnect();
      const bmp = await createImageBitmap(shot.blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const scale = bmp.width / window.innerWidth;
      // The magenta dot's rows down the middle column of the iframe.
      const x = Math.round((40 + 150) * scale);
      const rows: number[] = [];
      for (let y = 40; y < 340; y++) {
        const d = ctx.getImageData(x, Math.round(y * scale), 1, 1).data;
        if (d[0]! > 200 && d[1]! < 60 && d[2]! > 200) rows.push(y);
      }
      // Below the 100px body: the html background, or - with none - the body's
      // background propagated to the whole iframe canvas, as live.
      const below = Array.from(ctx.getImageData(x, Math.round((40 + 250) * scale), 1, 1).data);
      return {
        below,
        renderer: w.__everframe.__adapter.__lastScreenshotRenderer,
        maxBodyHeight,
        injected,
        liveDotTop,
        dotTop: rows.length ? rows[0]! : -1,
        dotRows: rows.length,
        bodyStyle: doc.body.getAttribute('style'),
      };
    }, htmlBg);
    expect(r.renderer).toBe('snapdom');
    expect(r.maxBodyHeight).toBe(100); // the live body never grew
    expect(r.injected).toBe(0); // nothing inserted into the live iframe document
    expect(r.bodyStyle).toBeNull();
    expect(r.dotRows).toBeGreaterThanOrEqual(18);
    expect(Math.abs(r.dotTop - r.liveDotTop)).toBeLessThanOrEqual(2);
    const expected = htmlBg ? [255, 255, 255] : [0, 120, 255];
    expect(r.below.slice(0, 3).every((v, i) => Math.abs(v - expected[i]!) <= 30), `below ${r.below.join(',')}`).toBe(true);
  });
}

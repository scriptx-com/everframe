// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FAST_CLONE_STYLE_PROPERTIES } from '../src/capture/capture-profile.js';

const chunk = readdirSync(fileURLToPath(new URL('../dist/', import.meta.url)))
  .find((file) => /^dist-.*\.js$/.test(file));
if (!chunk) throw new Error('Build the SDK: the patched screenshot chunk is missing');
const moduleUrl = `/dist/${chunk}`;

for (const content of ['', 'none']) {
  for (const fast of [false, true]) {
    test(`preserves hidden and visible scrollbars when the engine reports content=${JSON.stringify(content)}, fast=${fast}`, async ({ page, browserName }) => {
      test.skip(browserName === 'firefox', 'Firefox does not expose WebKit scrollbar pseudos');
      await page.route('**/scrollbar-fixture', (route) => route.fulfill({ contentType: 'text/html', body: `
        <!doctype html><style>
        .row { width: 200px; height: 80px; overflow: scroll; }
        .row > div { width: 500px; height: 100px; }
        #hidden::-webkit-scrollbar, #resize::-webkit-scrollbar { display: none; }
        #resize { resize: both; }
        #resize::-webkit-resizer { background: rgb(0, 128, 0); }
        #standard { scrollbar-width: none; }
        #visible::-webkit-scrollbar { width: 12px; height: 12px; background: rgb(255, 0, 0); }
        </style><main id="fixture"><div id="hidden" class="row"><div>Hidden</div></div>
        <div id="visible" class="row"><div>Visible</div></div>
        <div id="standard" class="row"><div>Standard CSS</div></div>
        <textarea id="resize" class="row">Resize me</textarea></main>`,
      }));
      await page.goto('/scrollbar-fixture');
      const result = await page.evaluate(async ({ content, properties, moduleUrl }) => {
        const modern = await import(moduleUrl);
        const getStyle = window.getComputedStyle;
        let hiddenPartsRead = 0;
        // Emulate the actual Chrome 53 API result, preserving every real computed
        // property except content. Unlike ::before, scrollbar pseudos need no content.
        window.getComputedStyle = (element, pseudo) => {
          if (element.id === 'hidden' && pseudo?.startsWith('::-webkit-') && pseudo !== '::-webkit-scrollbar' && pseudo !== '::-webkit-resizer') hiddenPartsRead++;
          const style = getStyle.call(window, element, pseudo);
          if (!pseudo?.startsWith('::-webkit-')) return style;
          return new Proxy(style, { get(target, key) {
            if (key === 'getPropertyValue') return (name: string) => name === 'content' ? content : target.getPropertyValue(name);
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
        };
        let svg: SVGSVGElement;
        try {
          svg = await modern.domToForeignObjectSvg(document.getElementById('fixture')!, { font: false, includeStyleProperties: properties });
        } finally { window.getComputedStyle = getStyle; }
        // A fresh document prevents the original #hidden rule from accidentally
        // masking a failure to copy it into the capture.
        const iframe = document.createElement('iframe');
        document.body.appendChild(iframe);
        const doc = iframe.contentDocument!;
        doc.body.appendChild(doc.importNode(svg, true));
        const hidden = doc.getElementById('hidden')!;
        const visible = doc.getElementById('visible')!;
        const win = iframe.contentWindow!;
        return {
          hiddenPartsRead,
          resizer: win.getComputedStyle(doc.getElementById('resize')!, '::-webkit-resizer').backgroundColor,
          standard: win.getComputedStyle(doc.getElementById('standard')!).getPropertyValue('scrollbar-width'),
          hidden: win.getComputedStyle(hidden, '::-webkit-scrollbar').display,
          visible: win.getComputedStyle(visible, '::-webkit-scrollbar').display,
          visibleHeight: win.getComputedStyle(visible, '::-webkit-scrollbar').height,
          visibleColor: win.getComputedStyle(visible, '::-webkit-scrollbar').backgroundColor,
          hiddenOverflow: win.getComputedStyle(hidden).overflowX,
        };
      }, { content, properties: fast ? FAST_CLONE_STYLE_PROPERTIES : null, moduleUrl });
      expect(result.hidden).toBe('none');
      expect(result.hiddenPartsRead).toBe(0);
      expect(result.resizer).toBe('rgb(0, 128, 0)');
      expect(result.standard).toBe('none');
      expect(result.visible).not.toBe('none');
      expect(result.visibleHeight).toBe('12px');
      expect(result.visibleColor).toBe('rgb(255, 0, 0)');
      expect(result.hiddenOverflow).toBe('scroll');
    });
  }
}

for (const fast of [false, true]) {
  test(`preserves standard scrollbar-width in isolated captures, fast=${fast}`, async ({ page }) => {
    await page.route('**/standard-scrollbar-fixture', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><div id="row" style="width:200px;height:80px;overflow:scroll;scrollbar-width:none"><div style="width:500px;height:100px">Row</div></div>',
    }));
    await page.goto('/standard-scrollbar-fixture');
    const result = await page.evaluate(async ({ properties, moduleUrl }) => {
      const modern = await import(moduleUrl);
      const svg = await modern.domToForeignObjectSvg(document.getElementById('row'), { font: false, includeStyleProperties: properties });
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      iframe.contentDocument!.body.appendChild(iframe.contentDocument!.importNode(svg, true));
      const row = iframe.contentDocument!.getElementById('row')!;
      const style = iframe.contentWindow!.getComputedStyle(row);
      return { width: style.getPropertyValue('scrollbar-width'), overflow: style.overflowX };
    }, { properties: fast ? FAST_CLONE_STYLE_PROPERTIES : null, moduleUrl });
    expect(result.width).toBe('none');
    expect(result.overflow).toBe('scroll');
  });
}

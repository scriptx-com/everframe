// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const chunk = readdirSync(fileURLToPath(new URL('../dist/', import.meta.url))).find(file => /^dist-.*\.js$/.test(file));
if (!chunk) throw Error('Build the SDK first');

test('captures cross-realm nodes and scroll transforms with legacy DOM APIs', async ({ page }) => {
  await page.goto('/e2e/fixtures/plain.html');
  const result = await page.evaluate(async url => {
    const modern = await import(url);
    const NativeMatrix = DOMMatrix;
    const globals = window as unknown as Record<string, unknown>;
    globals.DOMMatrix = undefined;
    globals.WebKitCSSMatrix = function (transform: string) {
      const matrix = new NativeMatrix(transform);
      Object.defineProperty(matrix, 'translateSelf', { value: undefined });
      return matrix;
    };
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const win = frame.contentWindow!;
    const doc = frame.contentDocument!;
    // Separate realm: installing a shim on the host's Element prototype would
    // not fix these nodes. Exercise the actual built vendor chunk.
    const proto = (win as unknown as { Element: typeof Element }).Element.prototype;
    Object.defineProperty(proto, 'getAttributeNames', { value: undefined });
    Object.defineProperty(proto, 'append', { value: undefined });
    doc.body.innerHTML = '<div id="row" data-marker="retained" style="width:100px;height:80px;overflow:scroll"><div id="content" style="width:500px;height:400px;background:red;transform:scale(1.5) rotate(15deg)">Visible row</div></div>';
    const row = doc.getElementById('row')!;
    row.scrollLeft = 40;
    row.scrollTop = 20;
    // Root transform is intentionally removed by the library; capture its parent.
    const svg = await modern.domToForeignObjectSvg(doc.body, { font: false, features: { restoreScrollPosition: true } });
    const cloned = svg.querySelector('#row') as HTMLElement;
    const expected = new NativeMatrix(win.getComputedStyle(doc.getElementById('content')!).transform);
    const linear = [expected.a, expected.b, expected.c, expected.d];
    const actual = new NativeMatrix((svg.querySelector('#content') as HTMLElement).style.transform);
    return { marker: cloned.getAttribute('data-marker'), text: cloned.textContent, linear: [actual.a, actual.b, actual.c, actual.d], expected: linear, x: actual.e, y: actual.f, liveX: row.scrollLeft, liveY: row.scrollTop, svg: svg.tagName };
  }, `/dist/${chunk}`);
  expect(result.marker).toBe('retained');
  expect(result.text).toBe('Visible row');
  expect(result.linear).toEqual(result.expected);
  expect(result.x).toBe(-40);
  expect(result.y).toBe(-20);
  expect(result.liveX).toBe(40);
  expect(result.liveY).toBe(20);
  expect(result.svg.toLowerCase()).toBe('svg');
});

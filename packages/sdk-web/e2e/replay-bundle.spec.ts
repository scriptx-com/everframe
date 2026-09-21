// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');

for (const variant of ['', 'browser/']) {
  test(`the ${variant || 'ESM'} replay chunk ships the snapshot fix and remains lazy`, async ({ page }) => {
    const directory = resolve(dist, variant);
    const recorder = readdirSync(directory).find((file) => /^rrweb-.*\.js$/.test(file));
    expect(recorder, 'patched rrweb must be shipped instead of an external bare import').toBeTruthy();
    // Walk static edges from the actual entry; the recorder must only be reachable
    // through import(), even if a future build moves that import to a shared chunk.
    const eager = new Set<string>();
    function visit(file: string) {
      if (eager.has(file)) return;
      eager.add(file);
      const source = readFileSync(resolve(directory, file), 'utf8');
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)(['"])(\.\/[^'"\n]+\.js)\1/g)) {
        visit(match[2]!);
      }
      expect(source).not.toContain('SCRIPT_PLACEHOLDER');
    }
    visit('index.js');
    expect([...eager].some((file) => file.endsWith(recorder!))).toBe(false);

    await page.route('**/replay-bundle-fixture', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><div id="card" style="color: red">Card</div>',
    }));
    await page.goto('/replay-bundle-fixture');
    const result = await page.evaluate(async (url) => {
      const rr = await import(url);
      const original = HTMLAnchorElement.prototype.setAttribute;
      let hrefWrites = 0;
      HTMLAnchorElement.prototype.setAttribute = function (name, value) {
        if (name === 'href') hrefWrites++;
        return original.call(this, name, value);
      };
      const snapshots: unknown[] = [];
      let stop: (() => void) | undefined;
      try {
        stop = rr.record({ emit: (e: { type: number }) => { if (e.type === 2) snapshots.push(e); } });
        rr.record.takeFullSnapshot();
        return { hrefWrites, snapshots: snapshots.length, dom: JSON.stringify(snapshots.at(-1)) };
      } finally {
        stop?.();
        HTMLAnchorElement.prototype.setAttribute = original;
      }
    }, `/dist/${variant}${recorder}`);
    expect(result.snapshots).toBeGreaterThan(0);
    expect(result.dom).toContain('color: red');
    expect(result.hrefWrites).toBe(0);
  });
}

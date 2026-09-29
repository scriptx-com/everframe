// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Screenshot capture perf check. Loads the e2e capture fixture at several
// node counts, captures through the real adapter at 1x and 4x CPU throttle,
// and prints median total time, longest main-thread block and blank/degraded
// flags. Local fixtures only — never point this at third-party sites.
//
//   pnpm build && pnpm perf:screenshot
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PERF_PORT ?? '8898';
const root = fileURLToPath(new URL('..', import.meta.url));
const server = spawn(process.execPath, ['e2e/static-server.mjs'], { cwd: root, env: { ...process.env, E2E_PORT: PORT }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const RUNS = Number(process.env.RUNS ?? 3);
const cases = [0, 5000, 15000];
const browser = await chromium.launch();
try {
  for (const bulk of cases) {
    for (const rate of [1, 4]) {
      const totals = [];
      const blocks = [];
      const flags = new Set();
      for (let i = 0; i < RUNS; i++) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
        const cdp = await page.context().newCDPSession(page);
        await page.goto(`http://127.0.0.1:${PORT}/e2e/fixtures/capture-cases.html?bulk=${bulk}`);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        const r = await page.evaluate(async () => {
          let longest = 0;
          let last = performance.now();
          let stop = false;
          const tick = () => { const t = performance.now(); longest = Math.max(longest, t - last); last = t; if (!stop) setTimeout(tick, 0); };
          setTimeout(tick, 0);
          const a = window.__everframe.__adapter;
          const t0 = performance.now();
          await a.captureScreenshot();
          const total = performance.now() - t0;
          stop = true;
          return { total, longest: Math.max(longest, performance.now() - last), renderer: a.__lastScreenshotRenderer, reason: a.__lastDegradedReason };
        });
        totals.push(r.total);
        blocks.push(r.longest);
        flags.add(`${r.renderer}${r.reason ? `/${r.reason}` : ''}`);
        await page.close();
      }
      const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      console.log(`bulk=${bulk} cpu=${rate}x  total=${Math.round(med(totals))}ms  longestBlock=${Math.round(med(blocks))}ms  ${[...flags].join(',')}`);
    }
  }
} finally {
  await browser.close();
  server.kill();
}

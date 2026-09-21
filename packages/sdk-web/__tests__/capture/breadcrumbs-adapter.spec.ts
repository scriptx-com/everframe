// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, afterEach } from 'vitest';
import { createBreadcrumbBuffer, BREADCRUMBS_CONFIG_DEFAULT } from '@traceitx/sdk-core';
import { createWebPlatformAdapter } from '../../src/adapter.js';
import { applyBreadcrumbsConfigToBuffer } from '../../src/capture/breadcrumbs.js';

const adapters: Array<{ __testCleanup: () => void }> = [];
afterEach(() => {
  while (adapters.length) adapters.pop()!.__testCleanup();
  history.replaceState(null, '', '/');
});

const mk = () => {
  const adapter = createWebPlatformAdapter({ apiKey: 'k' });
  adapters.push(adapter);
  return adapter;
};

describe('adapter breadcrumb wiring', () => {
  it('auto-capture flows into the bound buffer once __setBreadcrumbBuffer is called', () => {
    const adapter = mk();
    const buf = createBreadcrumbBuffer();
    adapter.__setBreadcrumbBuffer(() => buf);
    history.pushState(null, '', '/wired');
    expect(buf.size).toBe(1);
    buf.freeze();
    expect(buf.takeFrozen()![0]).toMatchObject({ kind: 'navigation' });
  });

  it('drops events silently before the buffer is bound (no throw, no leak)', () => {
    mk();
    expect(() => history.pushState(null, '', '/unbound')).not.toThrow();
  });

  it('__breadcrumbTrimOptions returns spec defaults pre-config', () => {
    const adapter = mk();
    expect(adapter.__breadcrumbTrimOptions()).toEqual({
      byteBudget: BREADCRUMBS_CONFIG_DEFAULT.byteBudget,
      consoleEntryCap: BREADCRUMBS_CONFIG_DEFAULT.consoleEntryCap,
    });
  });

  it('__applyBreadcrumbsConfig applies default maxCount without a resolved config', () => {
    const adapter = mk();
    const buf = createBreadcrumbBuffer({ maxCount: 500 });
    adapter.__setBreadcrumbBuffer(() => buf);
    for (let i = 0; i < 150; i++) buf.add({ kind: 'tap', message: `m${i}` });
    adapter.__applyBreadcrumbsConfig(); // default maxCount = 100
    expect(buf.size).toBe(100);
  });

  it('applyBreadcrumbsConfigToBuffer zeroizes when disabled, caps when enabled', () => {
    const buf = createBreadcrumbBuffer();
    for (let i = 0; i < 5; i++) buf.add({ kind: 'tap', message: `m${i}` });
    applyBreadcrumbsConfigToBuffer(buf, { enabled: true, maxCount: 3 });
    expect(buf.size).toBe(3);
    applyBreadcrumbsConfigToBuffer(buf, { enabled: false, maxCount: 3 });
    expect(buf.size).toBe(0);
  });

  it('a remounted adapter recaptures the install-once patchers (StrictMode/Fast Refresh)', () => {
    const first = mk(); // installs patchers, owns the global markers
    const bufA = createBreadcrumbBuffer();
    first.__setBreadcrumbBuffer(() => bufA);

    // Provider remount WITHOUT __testCleanup — markers stay owned by `first`.
    const second = createWebPlatformAdapter({ apiKey: 'k' });
    adapters.push(second);
    const bufB = createBreadcrumbBuffer();
    second.__setBreadcrumbBuffer(() => bufB);

    history.pushState(null, '', '/after-remount');
    expect(bufB.size).toBe(1); // live adapter gets the crumb…
    expect(bufA.size).toBe(0); // …not the dead one

    document.body.innerHTML = '<button id="dup">Once</button>';
    const sizeBefore = bufB.size;
    document.querySelector('#dup')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(bufB.size).toBe(sizeBefore + 1); // exactly one tap crumb, not two
    expect(bufA.size).toBe(0);
  });
});

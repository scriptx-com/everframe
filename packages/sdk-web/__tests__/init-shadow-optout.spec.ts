// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { init } from '../src/init.js';

let handle: { destroy(): void } | null = null;
afterEach(() => {
  handle?.destroy();
  handle = null;
  document.body.innerHTML = '';
});

describe('__traceitxShadowDom opt-out', () => {
  it('attaches a shadow root by default', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    expect(document.getElementById('traceitx-host')?.shadowRoot).not.toBeNull();
  });

  it('renders into the host element directly when opted out', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0', __traceitxShadowDom: false });
    const host = document.getElementById('traceitx-host');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
  });

  it('still injects the stylesheet when opted out — into the document head', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0', __traceitxShadowDom: false });
    expect(document.head.querySelector('style[data-traceitx-styles]')).not.toBeNull();
  });

  it('keeps the skip-capture tag in both modes', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0', __traceitxShadowDom: false });
    expect(
      document.getElementById('traceitx-host')?.getAttribute('data-traceitx-skip-capture'),
    ).toBe('true');
  });
});

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

describe('__everframeShadowDom opt-out', () => {
  it('attaches a shadow root by default', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0' });
    expect(document.getElementById('everframe-host')?.shadowRoot).not.toBeNull();
  });

  it('renders into the host element directly when opted out', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0', __everframeShadowDom: false });
    const host = document.getElementById('everframe-host');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
  });

  it('still injects the stylesheet when opted out — into the document head', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0', __everframeShadowDom: false });
    expect(document.head.querySelector('style[data-everframe-styles]')).not.toBeNull();
  });

  it('keeps the skip-capture tag in both modes', () => {
    handle = init({ apiKey: 'pk_test', appVersion: '1.0.0', __everframeShadowDom: false });
    expect(
      document.getElementById('everframe-host')?.getAttribute('data-everframe-skip-capture'),
    ).toBe('true');
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { applyThemeVarsToHost, __setThemeHost } from '../../src/branding/theme-host.js';

afterEach(() => {
  __setThemeHost(null);
  document.body.innerHTML = '';
});

describe('theme vars on the shadow host', () => {
  it('writes each var onto the host element so it cascades into the shadow tree', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    applyThemeVarsToHost(host, { '--everframe-accent': '#336699' });
    expect(host.style.getPropertyValue('--everframe-accent')).toBe('#336699');
  });

  it('clears vars that are no longer present rather than leaving them stale', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    applyThemeVarsToHost(host, { '--everframe-accent': '#336699' });
    applyThemeVarsToHost(host, {});
    expect(host.style.getPropertyValue('--everframe-accent')).toBe('');
  });

  it('is a no-op with no host registered (unentitled / pre-mount)', () => {
    expect(() => applyThemeVarsToHost(null as unknown as HTMLElement, {})).not.toThrow();
  });
});

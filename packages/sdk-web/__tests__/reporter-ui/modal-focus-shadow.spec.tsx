// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { activeElementFor } from '../../src/reporter-ui/primitives/active-element.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('activeElementFor (shadow-DOM focus resolution)', () => {
  it('returns document.activeElement for a node in the light DOM', () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    expect(activeElementFor(btn)).toBe(btn);
  });

  it('returns the SHADOW root active element, not the host, inside a shadow tree', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    shadow.appendChild(btn);
    btn.focus();

    // The bug this guards: document.activeElement reports the HOST.
    expect(document.activeElement).toBe(host);
    expect(activeElementFor(btn)).toBe(btn);
  });

  it('returns null for a detached node rather than throwing', () => {
    expect(activeElementFor(document.createElement('div'))).toBeNull();
  });
});

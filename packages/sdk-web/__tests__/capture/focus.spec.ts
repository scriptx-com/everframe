// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureFocusedNode } from '../../src/capture/focus.js';
import { FocusedNode as FocusedNodeSchema } from '@everframe/protocol';

describe('captureFocusedNode', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="app" data-everframe-display-name="App">
        <div data-everframe-display-name="Form">
          <input id="email" data-everframe-display-name="EmailInput" data-testid="email-field" aria-label="Email address" role="textbox" type="email" />
        </div>
      </div>
    `.trim();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns null when nothing meaningful is focused', () => {
    if (document.body.focus) document.body.focus();
    expect(captureFocusedNode()).toBeNull();
  });

  it('returns FocusedNode with PAY-02 root-to-leaf componentPath when input focused', () => {
    const input = document.getElementById('email')! as HTMLInputElement;
    input.focus();
    const fn = captureFocusedNode()!;
    expect(fn).not.toBeNull();
    expect(fn.componentPath).toBe('App > Form > EmailInput');
    expect(fn.source).toBe('programmatic');
    expect(Array.isArray(fn.path)).toBe(true);
    expect(fn.path.length).toBeGreaterThan(0);
  });

  it('emits empty componentPath string when no displayName ancestors exist', () => {
    document.body.innerHTML = '<input id="bare" />';
    document.getElementById('bare')!.focus();
    const fn = captureFocusedNode()!;
    expect(fn.componentPath).toBe('');
  });

  it('returned FocusedNode validates against protocol schema', () => {
    const input = document.getElementById('email')! as HTMLInputElement;
    input.focus();
    const fn = captureFocusedNode()!;
    const result = FocusedNodeSchema.safeParse(fn);
    expect(result.success).toBe(true);
  });

  it('takes the cursor from left/top when the rect has no x/y (Chrome < 61 ClientRect), and it passes the schema', () => {
    const input = document.getElementById('email')! as HTMLInputElement;
    // Chrome 53's ClientRect: left/top/right/bottom/width/height, no x/y.
    input.getBoundingClientRect = () => ({ left: 120, top: 48, right: 320, bottom: 88, width: 200, height: 40 }) as DOMRect;
    input.focus();
    const fn = captureFocusedNode()!;
    expect(fn.cursor).toEqual({ x: 120, y: 48 });
    expect(FocusedNodeSchema.safeParse(JSON.parse(JSON.stringify(fn))).success).toBe(true);
  });

  it('omits the cursor rather than sending NaN when the rect has no usable position', () => {
    const input = document.getElementById('email')! as HTMLInputElement;
    input.getBoundingClientRect = () => ({}) as DOMRect;
    input.focus();
    const fn = captureFocusedNode()!;
    expect(fn).not.toHaveProperty('cursor');
    expect(FocusedNodeSchema.safeParse(JSON.parse(JSON.stringify(fn))).success).toBe(true);
  });
});

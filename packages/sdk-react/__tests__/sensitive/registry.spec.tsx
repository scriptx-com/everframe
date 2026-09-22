// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { sensitiveRegistry, SENSITIVE_ATTR } from '@traceitx/web';
import { Sensitive } from '../../src/sensitive/Sensitive.js';

describe('sensitiveRegistry', () => {
  beforeEach(() => {
    sensitiveRegistry.__clearForTesting();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    sensitiveRegistry.__clearForTesting();
    document.body.innerHTML = '';
  });

  it('addRef → snapshot returns one rect', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        top: 20,
        left: 10,
        right: 40,
        bottom: 60,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(el);
    sensitiveRegistry.addRef(el);
    const rects = sensitiveRegistry.snapshot();
    expect(rects.length).toBe(1);
    expect(rects[0]).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it('addRef is idempotent (Set membership)', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        top: 0,
        left: 0,
        right: 1,
        bottom: 1,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(el);
    sensitiveRegistry.addRef(el);
    sensitiveRegistry.addRef(el);
    expect(sensitiveRegistry.snapshot().length).toBe(1);
  });

  it('removeRef unregisters the element', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        top: 0,
        left: 0,
        right: 1,
        bottom: 1,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(el);
    sensitiveRegistry.addRef(el);
    sensitiveRegistry.removeRef(el);
    expect(sensitiveRegistry.snapshot().length).toBe(0);
  });

  it('also includes data-traceitx-sensitive elements (DOM scan merge)', () => {
    const el = document.createElement('div');
    el.setAttribute(SENSITIVE_ATTR, '');
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        x: 5,
        y: 5,
        width: 10,
        height: 10,
        top: 5,
        left: 5,
        right: 15,
        bottom: 15,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(el);
    const rects = sensitiveRegistry.snapshot();
    expect(rects.length).toBe(1);
    expect(rects[0]).toEqual({ x: 5, y: 5, width: 10, height: 10 });
  });

  it('skips zero-size rects (display: none / unmounted)', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'getBoundingClientRect', {
      value: () => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        toJSON: () => ({}),
      }),
    });
    sensitiveRegistry.addRef(el);
    expect(sensitiveRegistry.snapshot().length).toBe(0);
  });
});

describe('<Sensitive>', () => {
  beforeEach(() => {
    sensitiveRegistry.__clearForTesting();
  });
  afterEach(() => {
    sensitiveRegistry.__clearForTesting();
  });

  it('registers the wrapper on mount; unregisters on unmount (via snapshotElements)', () => {
    const { unmount } = render(
      <Sensitive>
        <span>secret</span>
      </Sensitive>,
    );
    // Masking pipeline switched from post-capture rect painting to live-DOM
    // masking (see registry.ts:applyDomMask). The relevant API for "is it
    // registered?" is now snapshotElements(); rect-based snapshot() is kept
    // only for the legacy maskPlan path (adapter.applyMaskPlan) and will
    // return 0 entries in jsdom because getBoundingClientRect is zero-size.
    //
    // snapshotElements() recurses into the display:contents wrapper and
    // surfaces the underlying child elements that the renderer can mask.
    const wrapper = document.querySelector('[data-traceitx-sensitive=""]');
    expect(wrapper).not.toBeNull();
    const elements = sensitiveRegistry.snapshotElements();
    // The wrapper itself is display:contents — recursion yields its <span>
    // child as the maskable element.
    expect(elements.length).toBeGreaterThanOrEqual(1);
    unmount();
    expect(sensitiveRegistry.snapshotElements().length).toBe(0);
  });

  it('renders children verbatim with display:contents wrapper by default', () => {
    const { getByText } = render(
      <Sensitive>
        <span>visible-text</span>
      </Sensitive>,
    );
    expect(getByText('visible-text')).toBeInTheDocument();
    const wrapper = document.querySelector('[data-traceitx-sensitive=""]') as HTMLElement;
    expect(wrapper.style.display).toBe('contents');
  });
});

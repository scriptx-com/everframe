// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../../src/quickcapture/copy.js';
import { createOverlay, type Overlay } from '../../src/quickcapture/overlay.js';
import { __filterNodeForTests } from '../../src/capture/screenshot.js';

let overlay: Overlay;
const host = (): HTMLElement => document.getElementById('everframe-quick-capture')!;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  overlay = createOverlay(document);
});
afterEach(() => {
  overlay.destroy();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('quick-capture overlay', () => {
  it('banner shows the matching number and the subline', () => {
    overlay.showBanner(47);
    expect(host().textContent).toContain('Linking to Everframe · 47');
    expect(host().textContent).toContain(
      "A teammate is linking a device. If that's not you, ignore this.",
    );
    overlay.hideBanner();
    expect(document.getElementById('everframe-quick-capture')?.textContent ?? '').not.toContain(
      'Linking to Everframe',
    );
  });

  it('the overlay is excluded from screenshots, TV snapshots and replay', () => {
    overlay.showBanner(1);
    expect(host().getAttribute('data-everframe-skip-capture')).toBe('true');
    expect(host().classList.contains('rr-block')).toBe(true);
    expect(__filterNodeForTests(host())).toBe(false);
  });

  it('the overlay never takes focus', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    overlay.showBanner(5);
    overlay.toast('Captured · team device');
    expect(document.activeElement).toBe(button);
    expect(host().querySelector('[tabindex]')).toBeNull();
    expect(host().hasAttribute('tabindex')).toBe(false);
    expect(host().style.pointerEvents).toBe('none');
    expect(host().getAttribute('role')).toBe('status');
    expect(host().getAttribute('aria-live')).toBe('polite');
  });

  it('the banner sits above the reporter host', () => {
    overlay.showBanner(3);
    const reporter = document.createElement('div');
    reporter.id = 'everframe-host';
    document.body.appendChild(reporter);
    expect(document.body.lastElementChild).toBe(reporter);
    overlay.showBanner(3);
    expect(document.body.lastElementChild).toBe(host());
    expect(host().style.zIndex).toBe('2147483647');
    expect(document.querySelectorAll('#everframe-quick-capture')).toHaveLength(1);
    document.body.appendChild(reporter);
    overlay.toast('x');
    expect(document.body.lastElementChild).toBe(host());
  });

  it('a toast replaces the previous one and hides after 3000 ms', () => {
    overlay.toast('first');
    expect(host().textContent).toContain('first');
    vi.advanceTimersByTime(2_000);
    overlay.toast('second');
    expect(host().textContent).not.toContain('first');
    expect(host().textContent).toContain('second');
    vi.advanceTimersByTime(2_999);
    expect(host().textContent).toContain('second');
    vi.advanceTimersByTime(1);
    expect(document.getElementById('everframe-quick-capture')?.textContent ?? '').not.toContain(
      'second',
    );
  });

  it('a toast and the banner can show together', () => {
    overlay.showBanner(12);
    overlay.toast('Linked to Aurimas');
    expect(host().textContent).toContain('Linking to Everframe · 12');
    expect(host().textContent).toContain('Linked to Aurimas');
  });

  it('a name with markup renders as text', () => {
    overlay.toast(COPY.captured({ kind: 'user', name: '<b>x</b>' }, 'TV'));
    expect(host().querySelector('b')).toBeNull();
    expect(host().textContent).toContain('Captured · <b>x</b>');
  });

  it('destroy removes the host and cancels timers', () => {
    overlay.showBanner(9);
    overlay.toast('t');
    overlay.destroy();
    expect(document.getElementById('everframe-quick-capture')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // Calls after destroy are harmless and show nothing.
    overlay.showBanner(1);
    overlay.toast('late');
    expect(document.getElementById('everframe-quick-capture')).toBeNull();
  });

  it('never throws without a body', () => {
    const doc = document.implementation.createHTMLDocument('x');
    doc.documentElement.removeChild(doc.body);
    const o = createOverlay(doc);
    expect(() => {
      o.showBanner(1);
      o.toast('x');
      o.hideBanner();
      o.destroy();
    }).not.toThrow();
  });

  it('copy is verbatim', () => {
    expect(COPY.bannerTitle(47)).toBe('Linking to Everframe · 47');
    expect(COPY.BANNER_SUBLINE).toBe(
      "A teammate is linking a device. If that's not you, ignore this.",
    );
    expect(COPY.linked({ kind: 'user', name: 'Aurimas' })).toBe('Linked to Aurimas');
    expect(COPY.linked({ kind: 'team' })).toBe('Linked as team device');
    expect(COPY.captured({ kind: 'user', name: 'Aurimas' }, 'QE55')).toBe('Captured · Aurimas');
    expect(COPY.captured({ kind: 'team' }, 'QE55')).toBe('Captured · team device');
    expect(COPY.captured(null, 'Samsung TV')).toBe('Captured · Samsung TV');
    expect(COPY.UNLINKED).toBe('This device was unlinked');
    expect(COPY.CAPTURE_REJECTED).toBe("Capture didn't upload");
    expect(COPY.CAPTURE_FAILED).toBe('Capture failed');
    expect(COPY.linked({ kind: 'user', name: '  ' })).toBe('Linked to teammate');
    expect(COPY.captured({ kind: 'user', name: 'y'.repeat(41) }, 'x')).toBe(
      'Captured · ' + 'y'.repeat(40) + '…',
    );
  });
});

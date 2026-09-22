// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, afterEach } from 'vitest';
import type { BreadcrumbInput } from '@traceitx/sdk-core';
import {
  installNavigationCrumbs,
  installLifecycleCrumbs,
  installTapCrumbs,
  describeEventTarget,
} from '../../src/capture/breadcrumbs.js';

const collect = () => {
  const crumbs: BreadcrumbInput[] = [];
  const sink = (i: BreadcrumbInput) => crumbs.push(i);
  return { crumbs, sink };
};
const allOn = () => true;

const uninstalls: Array<() => void> = [];
afterEach(() => {
  while (uninstalls.length) uninstalls.pop()!();
  history.replaceState(null, '', '/');
});

describe('installNavigationCrumbs', () => {
  it('emits a navigation crumb on pushState with from/to', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installNavigationCrumbs(sink, allOn));
    history.pushState(null, '', '/checkout?step=2');
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      kind: 'navigation',
      message: '/ → /checkout?step=2',
      data: { from: '/', to: '/checkout?step=2' },
    });
  });

  it('emits on replaceState and popstate, skips same-URL no-ops', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installNavigationCrumbs(sink, allOn));
    history.replaceState(null, '', '/a');
    history.replaceState(null, '', '/a'); // same URL — no crumb
    window.dispatchEvent(new PopStateEvent('popstate'));
    // popstate with unchanged URL is also a no-op
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]!.data).toEqual({ from: '/', to: '/a' });
  });

  it('respects the kind gate and is install-once idempotent', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installNavigationCrumbs(sink, () => false));
    const second = installNavigationCrumbs(sink, allOn); // no-op: marker present
    uninstalls.push(second);
    history.pushState(null, '', '/gated');
    expect(crumbs).toHaveLength(0);
  });

  it('uninstall restores pushState and stops emitting', () => {
    const { crumbs, sink } = collect();
    const un = installNavigationCrumbs(sink, allOn);
    un();
    history.pushState(null, '', '/after-uninstall');
    expect(crumbs).toHaveLength(0);
  });
});

describe('installLifecycleCrumbs', () => {
  it('emits a lifecycle crumb on visibilitychange', () => {
    const { crumbs, sink } = collect();
    uninstalls.push(installLifecycleCrumbs(sink, allOn));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      kind: 'lifecycle',
      message: `visibility: ${document.visibilityState}`,
      data: { state: document.visibilityState },
    });
  });

  it('respects the gate and uninstalls cleanly', () => {
    const { crumbs, sink } = collect();
    const un = installLifecycleCrumbs(sink, () => false);
    document.dispatchEvent(new Event('visibilitychange'));
    un();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(crumbs).toHaveLength(0);
  });
});

describe('describeEventTarget', () => {
  it('prefers aria-label, then text, then tag#id, then tag', () => {
    document.body.innerHTML = `
      <button id="buy" aria-label="Buy now"><span>💰</span></button>
      <button id="plain">Add to cart</button>
      <div id="box"></div>`;
    const byAria = describeEventTarget(document.querySelector('#buy span')!, []);
    expect(byAria.label).toBe('Buy now'); // climbed to the button, used aria-label
    const byText = describeEventTarget(document.querySelector('#plain')!, []);
    expect(byText.label).toBe('Add to cart');
    const byId = describeEventTarget(document.querySelector('#box')!, []);
    expect(byId).toMatchObject({ label: 'div#box', meta: { tag: 'div', id: 'box' } });
  });

  it('labels [masked] and reads NO text when the target is inside a masked element', () => {
    document.body.innerHTML = `<div id="secret"><button id="s">SSN 123-45-6789</button></div>`;
    const masked = [document.querySelector('#secret')!];
    const d = describeEventTarget(document.querySelector('#s')!, masked);
    expect(d.masked).toBe(true);
    expect(d.label).toBe('[masked]');
    expect(JSON.stringify(d)).not.toContain('123-45');
  });

  it('reads NOTHING but the tag from a masked subtree — id/role never leak', () => {
    document.body.innerHTML =
      `<div id="wrap"><button id="ssn-123-45-6789" role="button">pay</button></div>`;
    const masked = [document.querySelector('#wrap')!];
    const d = describeEventTarget(document.querySelector('button')!, masked);
    expect(d).toEqual({ label: '[masked]', masked: true, meta: { tag: 'button' } });
    expect(JSON.stringify(d)).not.toContain('ssn-123');
  });
});

describe('installTapCrumbs', () => {
  it('emits a tap crumb from a capture-phase pointerdown', () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const { crumbs, sink } = collect();
    uninstalls.push(installTapCrumbs(sink, allOn, () => []));
    document
      .querySelector('#go')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      kind: 'tap',
      message: 'tap Go',
      data: { tag: 'button', id: 'go' },
    });
  });

  it('marks masked taps and respects the gate + uninstall', () => {
    document.body.innerHTML = `<div id="pin"><button id="k">1234</button></div>`;
    const maskedEl = document.querySelector('#pin')!;
    const { crumbs, sink } = collect();
    const un = installTapCrumbs(sink, allOn, () => [maskedEl]);
    document.querySelector('#k')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(crumbs[0]).toMatchObject({ message: 'tap [masked]', data: { masked: true } });
    un();
    document.querySelector('#k')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(crumbs).toHaveLength(1);

    const gated: BreadcrumbInput[] = [];
    uninstalls.push(installTapCrumbs((i) => gated.push(i), () => false, () => []));
    document.querySelector('#k')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(gated).toHaveLength(0);
  });
});

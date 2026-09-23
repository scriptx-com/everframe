// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, describe, expect, it, vi } from 'vitest';
import { record } from 'rrweb';
import { buildRecordOptions } from '../../../src/capture/replay/mask-mapping.js';
import { createRollingBuffer, type BufferEvent } from '../../../src/capture/replay/buffer.js';

type SnapshotNode = {
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  isCustom?: boolean;
  childNodes?: SnapshotNode[];
};

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

function capture() {
  const snapshots: SnapshotNode[] = [];
  stop = record(buildRecordOptions({ durationSec: 30, emit(event) {
    const e = event as { type: number; data: { node: SnapshotNode } };
    if (e.type === 2) snapshots.push(e.data.node);
  } }));
  record.takeFullSnapshot();
  return { snapshots, latest: () => snapshots[snapshots.length - 1]! };
}
function find(node: SnapshotNode, id: string): SnapshotNode | undefined {
  if (node.attributes?.id === id) return node;
  for (const child of node.childNodes ?? []) {
    const match = find(child, id);
    if (match) return match;
  }
}

describe('rrweb snapshot compatibility and hot paths', () => {
  it('retains real snapshots of deeply nested component wrappers', () => {
    let parent: HTMLElement = document.body;
    for (let i = 0; i < 100; i++) {
      const child = document.createElement('div');
      parent.appendChild(child);
      parent = child;
    }
    parent.textContent = 'Visible content';
    const buffer = createRollingBuffer({ durationSec: 30 });
    stop = record(buildRecordOptions({ durationSec: 30, emit(event) {
      buffer.push(event as BufferEvent);
    } }));
    record.takeFullSnapshot();
    expect(buffer.frames().some(event => event.type === 2)).toBe(true);
    expect(buffer.capBreached()).toBe(false);
    expect(buffer.byteSize()).toBeLessThan(100000);
  });

  it('captures URL-free inline styles without resolving the document URL for every element', () => {
    document.body.innerHTML = '<div id="card" style="color: red; transform: translateX(10px)">Card</div>';
    const setAttribute = vi.spyOn(HTMLAnchorElement.prototype, 'setAttribute');
    const { latest } = capture();
    expect(find(latest(), 'card')?.attributes?.style).toBe('color: red; transform: translateX(10px)');
    // Resolving the base URL mutates rrweb's detached anchor. It is unnecessary
    // for styles without url(), and is repeated hundreds of times on the TV.
    expect(setAttribute.mock.calls.filter(([name]) => name === 'href')).toHaveLength(0);
  });

  it('resolves relative inline URLs again after the document base changes', () => {
    document.head.innerHTML = '<base href="https://example.test/first/page.html">';
    document.body.innerHTML = '<div id="card" style="background: url(../poster.png)"></div>';
    const { latest } = capture();
    expect(find(latest(), 'card')?.attributes?.style).toBe('background: url(https://example.test/poster.png)');
    document.querySelector('base')!.href = 'https://example.test/second/nested/page.html';
    record.takeFullSnapshot();
    expect(find(latest(), 'card')?.attributes?.style).toBe('background: url(https://example.test/second/poster.png)');
  });

  it('captures changed CSS rules and inline styles on subsequent checkouts', () => {
    document.head.innerHTML = '<style id="theme">.card { color: red; }</style>';
    document.body.innerHTML = '<div id="card" class="card" style="opacity: 1">Card</div>';
    const { latest } = capture();
    expect(find(latest(), 'theme')?.attributes?._cssText).toContain('color: red');
    (document.querySelector('style')!.sheet!.cssRules[0] as CSSStyleRule).style.setProperty('color', 'blue');
    document.getElementById('card')!.setAttribute('style', 'opacity: 0.5');
    record.takeFullSnapshot();
    expect(find(latest(), 'theme')?.attributes?._cssText).toContain('color: blue');
    expect(find(latest(), 'card')?.attributes?.style).toBe('opacity: 0.5');
  });

  it('records without Custom Elements support and still identifies registered custom elements', () => {
    const registry = window.customElements;
    registry.define('everframe-snapshot-card', class extends HTMLElement {});
    document.body.innerHTML = '<everframe-snapshot-card id="custom">Card</everframe-snapshot-card>';
    const { latest } = capture();
    expect(find(latest(), 'custom')?.isCustom).toBe(true);
    vi.stubGlobal('customElements', undefined);
    record.takeFullSnapshot();
    expect(find(latest(), 'custom')?.tagName).toBe('everframe-snapshot-card');
    expect(find(latest(), 'custom')?.isCustom).toBeUndefined();
  });
});

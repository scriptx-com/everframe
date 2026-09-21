// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createAmbientUI } from '../../src/mount/ambient.js';

let shadow: ShadowRoot;
function makeShadow(): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return (shadow = host.attachShadow({ mode: 'open' }));
}
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ambient UI (no React)', () => {
  it('renders nothing until made visible — the FAB is opt-in', () => {
    createAmbientUI(makeShadow(), { onOpen: () => undefined });
    expect(shadow.querySelector('[data-testid=reporter-fab]')).toBeNull();
  });

  it('renders a FAB into the shadow root when made visible', () => {
    const ui = createAmbientUI(makeShadow(), { onOpen: () => undefined });
    ui.setVisible(true);
    expect(shadow.querySelector('[data-testid=reporter-fab]')).not.toBeNull();
  });

  it('calls onOpen when the FAB is clicked', () => {
    const onOpen = vi.fn();
    const ui = createAmbientUI(makeShadow(), { onOpen });
    ui.setVisible(true);
    (shadow.querySelector('[data-testid=reporter-fab]') as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows an unread dot only when the count is above zero', () => {
    const ui = createAmbientUI(makeShadow(), { onOpen: () => undefined });
    ui.setVisible(true);
    expect(shadow.querySelector('.txx-fab-dot')).toBeNull();
    ui.setUnread(3);
    expect(shadow.querySelector('.txx-fab-dot')).not.toBeNull();
    ui.setUnread(0);
    expect(shadow.querySelector('.txx-fab-dot')).toBeNull();
  });

  it('labels the button for screen readers, including the unread count', () => {
    const ui = createAmbientUI(makeShadow(), { onOpen: () => undefined });
    ui.setVisible(true);
    ui.setUnread(2);
    expect(
      shadow.querySelector('[data-testid=reporter-fab]')?.getAttribute('aria-label'),
    ).toBe('Your reports — 2 unread');
  });

  it('destroy() removes it from the shadow root', () => {
    const ui = createAmbientUI(makeShadow(), { onOpen: () => undefined });
    ui.setVisible(true);
    ui.destroy();
    expect(shadow.querySelector('[data-testid=reporter-fab]')).toBeNull();
  });

  it('matches ReporterFab.tsx markup — same wrapper, button classes and default label', () => {
    const ui = createAmbientUI(makeShadow(), { onOpen: () => undefined });
    ui.setVisible(true);
    const wrap = shadow.querySelector('.txx-root.txx-fab-wrap');
    expect(wrap).not.toBeNull();
    const button = wrap?.querySelector('button.txx-fab') as HTMLButtonElement;
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Your reports');
    // The MessageSquare glyph, inlined so no icon package reaches this graph.
    const svg = button.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
    expect(svg?.getAttribute('height')).toBe('20');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });
});

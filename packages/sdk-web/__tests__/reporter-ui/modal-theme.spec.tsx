// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, act } from '@testing-library/react';
import { Modal } from '../../src/reporter-ui/primitives/Modal.js';
import { __setBrandingServerConfig } from '../../src/branding/server-config.js';
import { __setInlineReporterTheme } from '../../src/branding/inline-theme.js';

afterEach(() => {
  cleanup();
  __setBrandingServerConfig(undefined);
  __setInlineReporterTheme(undefined);
});

function renderModal() {
  return render(
    <Modal open={true} onClose={() => undefined} title="t">
      <div>body</div>
    </Modal>,
  );
}

function portalRoot(): HTMLElement {
  const el = document.querySelector('.txx-root');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

describe('Modal theme vars (branding spec 2026-08-25)', () => {
  it('applies resolved vars inline on the portal root when entitled', () => {
    __setBrandingServerConfig({ watermark: false, theme: { accent: '#336699' } });
    renderModal();
    expect(portalRoot().style.getPropertyValue('--txx-accent')).toBe('#336699');
  });

  it('applies NOTHING when unentitled, even with an inline theme (fail closed)', () => {
    __setInlineReporterTheme({ accent: '#336699' });
    renderModal();
    expect(portalRoot().style.getPropertyValue('--txx-accent')).toBe('');
  });

  it('inline theme applies once the server confirms entitlement — live, mid-open', () => {
    __setInlineReporterTheme({ accent: '#336699' });
    renderModal();
    expect(portalRoot().style.getPropertyValue('--txx-accent')).toBe('');
    act(() => __setBrandingServerConfig({ watermark: false }));
    expect(portalRoot().style.getPropertyValue('--txx-accent')).toBe('#336699');
  });

  it('server theme field beats the inline one per-field', () => {
    __setInlineReporterTheme({ accent: '#00ff00', accentForeground: '#111111' });
    __setBrandingServerConfig({ watermark: false, theme: { accent: '#ff0000' } });
    renderModal();
    expect(portalRoot().style.getPropertyValue('--txx-accent')).toBe('#ff0000');
    expect(portalRoot().style.getPropertyValue('--txx-accent-fg')).toBe('#111111');
  });

  it('the hidden prop still hides the modal when themed', () => {
    __setBrandingServerConfig({ watermark: false, theme: { accent: '#336699' } });
    render(
      <Modal open={true} onClose={() => undefined} title="t" hidden={true}>
        <div>body</div>
      </Modal>,
    );
    expect(portalRoot().style.visibility).toBe('hidden');
    expect(portalRoot().style.getPropertyValue('--txx-accent')).toBe('#336699');
  });
});

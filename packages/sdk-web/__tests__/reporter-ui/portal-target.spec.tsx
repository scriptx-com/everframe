// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Modal } from '../../src/reporter-ui/primitives/Modal.js';
import { __setPortalTarget } from '../../src/reporter-ui/portal-target.js';

afterEach(() => {
  cleanup();
  __setPortalTarget(null);
  document.body.innerHTML = '';
});

function renderModal() {
  return render(
    <Modal open={true} onClose={() => undefined} title="t">
      <div>body</div>
    </Modal>,
  );
}

describe('portal target', () => {
  it('defaults to document.body so the React path is unchanged', () => {
    renderModal();
    expect(document.body.querySelector('.everframe-modal')).not.toBeNull();
  });

  it('renders into a shadow root when one is set, and NOT into document.body', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    __setPortalTarget(shadow);

    renderModal();

    expect(shadow.querySelector('.everframe-modal')).not.toBeNull();
    expect(document.body.querySelector('.everframe-modal')).toBeNull();
  });

  it('restores the document.body default when reset to null', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    __setPortalTarget(host.attachShadow({ mode: 'open' }));
    __setPortalTarget(null);
    renderModal();
    expect(document.body.querySelector('.everframe-modal')).not.toBeNull();
  });
});

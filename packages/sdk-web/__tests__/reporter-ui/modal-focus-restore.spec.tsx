// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Codex round-3 finding 5 (P2) — closing the reporter lost focus, in the
// vanilla (shadow-DOM) mount only.
//
// `Modal`'s focus effect captured the element to restore with
// `activeElementFor(modalRef.current)`. That resolves "what is focused inside
// the MODAL's root", which is right for the Tab trap and wrong for restore:
// the element focused before the reporter opened lives in the HOST PAGE's
// light DOM, so asking the reporter's shadow root returned
// `shadowRoot.activeElement` — `null` — and the cleanup restored focus to
// nothing.
//
// The two uses now resolve differently (`deepActiveElement()` for restore,
// `activeElementFor()` for the trap), so this spec pins BOTH: the restore in
// each mount mode, and the trap still matching inside the shadow tree.
//
// `modal-focus-shadow.spec.tsx` covers `activeElementFor` itself and is left
// untouched.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Modal } from '../../src/reporter-ui/primitives/Modal.js';
import {
  activeElementFor,
  deepActiveElement,
} from '../../src/reporter-ui/primitives/active-element.js';
import { __setPortalTarget } from '../../src/reporter-ui/portal-target.js';

afterEach(() => {
  cleanup();
  __setPortalTarget(null);
  document.body.innerHTML = '';
});

/** The vanilla mount's shape: a shadow root that Modal portals into. */
function shadowPortalTarget(): ShadowRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  __setPortalTarget(shadow);
  return shadow;
}

/** An element of the HOST PAGE, focused before the reporter opens. */
function hostPageInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  return input;
}

describe('deepActiveElement()', () => {
  it('returns the light-DOM focused element (the restore case)', () => {
    const input = hostPageInput();
    expect(deepActiveElement()).toBe(input);
  });

  it('unwraps the shadow host to the element actually focused inside it', () => {
    const shadow = shadowPortalTarget();
    const btn = document.createElement('button');
    shadow.appendChild(btn);
    btn.focus();

    // The bug the whole finding turns on: document.activeElement is the HOST.
    expect(document.activeElement).toBe(shadow.host);
    expect(deepActiveElement()).toBe(btn);
  });

  it('unwraps nested shadow roots too', () => {
    const outerHost = document.createElement('div');
    document.body.appendChild(outerHost);
    const outer = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('div');
    outer.appendChild(innerHost);
    const inner = innerHost.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    inner.appendChild(btn);
    btn.focus();

    expect(deepActiveElement()).toBe(btn);
  });
});

describe('<Modal> focus restore', () => {
  it('returns focus to the host page input when the shadow-mounted modal closes', async () => {
    shadowPortalTarget();
    const input = hostPageInput();
    expect(document.activeElement).toBe(input);

    const view = render(
      <Modal open onClose={() => undefined} title="Report a bug">
        <button type="button">inside</button>
      </Modal>,
    );
    // Modal's focus-on-open runs in a microtask; let it land. That it lands at
    // all is load-bearing here: without focus actually moving, "restored"
    // would be indistinguishable from "never left".
    await Promise.resolve();
    expect(deepActiveElement()).not.toBe(input);

    view.unmount();

    expect(document.activeElement).toBe(input);
  });

  it('still restores in the React (light-DOM, document.body portal) mount', async () => {
    // No portal target set: `resolvePortalTarget()` falls back to
    // document.body, which is the shape `@traceitx/react`'s Provider produces.
    // This is the "must not regress the published SDK" half.
    const input = hostPageInput();

    const view = render(
      <Modal open onClose={() => undefined} title="Report a bug">
        <button type="button">inside</button>
      </Modal>,
    );
    await Promise.resolve();
    expect(document.activeElement).not.toBe(input);

    view.unmount();

    expect(document.activeElement).toBe(input);
  });

  it('leaves the Tab trap resolving against the modal root, not the page', () => {
    // The other half of the split. `activeElementFor` is what the keydown
    // handler uses; swapping IT for `deepActiveElement()` would happen to work
    // here, but swapping the RESTORE for `activeElementFor` is the regression
    // this finding is about — so pin that the trap's resolution still sees
    // shadow-internal focus.
    const shadow = shadowPortalTarget();
    render(
      <Modal open onClose={() => undefined} title="Report a bug">
        <button type="button" data-testid="inside">
          inside
        </button>
      </Modal>,
    );
    const btn = shadow.querySelector('button');
    expect(btn).not.toBeNull();
    btn!.focus();

    expect(activeElementFor(btn!)).toBe(btn);
  });
});

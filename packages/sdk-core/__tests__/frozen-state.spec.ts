// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The breadcrumb and network-body buffers say whether a snapshot is held, so
// a second capture flow (web-TV quick capture) never takes evidence the
// reporter froze.
import { describe, expect, it } from 'vitest';
import { createBreadcrumbBuffer } from '../src/breadcrumbs/buffer.js';
import { createNetworkBodyBuffer } from '../src/capture/network-body-buffer.js';

describe('frozen state', () => {
  it('a breadcrumb buffer reports a held snapshot until it is taken or discarded', () => {
    const b = createBreadcrumbBuffer({});
    expect(b.isFrozen?.()).toBe(false);
    b.freeze();
    expect(b.isFrozen?.()).toBe(true);
    b.takeFrozen();
    expect(b.isFrozen?.()).toBe(false);
    b.freeze();
    b.discardAndResume();
    expect(b.isFrozen?.()).toBe(false);
  });

  it('a network-body buffer reports a held snapshot until it is taken or discarded', () => {
    const b = createNetworkBodyBuffer();
    expect(b.isFrozen?.()).toBe(false);
    b.freeze();
    expect(b.isFrozen?.()).toBe(true);
    b.takeFrozen();
    expect(b.isFrozen?.()).toBe(false);
    b.freeze();
    b.discardAndResume();
    expect(b.isFrozen?.()).toBe(false);
  });
});

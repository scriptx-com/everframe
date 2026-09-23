// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Follow-up (spec 2026-08-12-followups-cleanup-round): `init()` used to assign
// `state.config` and nothing else, so a second `init()` under a DIFFERENT
// apiKey left project A's self-declared user, extra, breadcrumb chain,
// captured bodies and — worst — its signed identity token live for project B.
// Unreachable through EverframeProvider (fresh client per mount), but
// `createClient` is a public export, so a direct-SDK host can do exactly this.
import { describe, it, expect } from 'vitest';
import { createClient, __internalClientState, resolveClientExtra } from '../src/client.js';
import type { PlatformAdapter } from '../src/types/platform.js';
import type { EverframeClient } from '../src/client.js';

/** Minimal adapter — none of these paths touch an adapter method. */
function stubAdapter(): PlatformAdapter {
  return {} as unknown as PlatformAdapter;
}

const stateOf = (c: EverframeClient) => __internalClientState.get(c)!;

/** Populate every tenant-scoped field the reset is responsible for. */
function populate(client: EverframeClient): void {
  client.setUser({ id: 'u_1', email: 'alice@a.com', displayName: 'Alice' });
  client.setExtra('order-4417');
  client.setIdentityToken('signed.jwt.for.project.a');
  client.addBreadcrumb({ kind: 'tap', message: 'crumb-under-project-a' });
  // No public client method fills the network-body buffer (the adapter's
  // fetch patcher does it in production) — reach it through the same
  // internal-state seam the spec already imports.
  stateOf(client).networkBodies.add({ ref: 1, t: Date.now(), reqBody: 'body-under-project-a' });
}

describe('init() with a different apiKey resets tenant-scoped state', () => {
  it('clears user, extra, identity token and both buffers', () => {
    const client = createClient(stubAdapter());
    client.init({ apiKey: 'pk_project_a' });
    populate(client);

    const before = stateOf(client);
    expect(before.user).not.toBeNull();
    expect(before.breadcrumbs.size).toBeGreaterThan(0);
    expect(before.networkBodies.size).toBeGreaterThan(0);

    client.init({ apiKey: 'pk_project_b' });

    const after = stateOf(client);
    expect(after.user).toBeNull();
    expect(resolveClientExtra(client)).toBe('');
    expect(after.identityToken.hasSource()).toBe(false);
    expect(after.breadcrumbs.size).toBe(0);
    expect(after.networkBodies.size).toBe(0);
    expect(after.config?.apiKey).toBe('pk_project_b');
  });

  it('keeps capturing for the new tenant — clear(), not kill()', () => {
    const client = createClient(stubAdapter());
    client.init({ apiKey: 'pk_project_a' });
    populate(client);
    client.init({ apiKey: 'pk_project_b' });

    client.addBreadcrumb({ kind: 'tap', message: 'crumb-under-project-b' });

    const s = stateOf(client);
    expect(s.breadcrumbs.size).toBe(1);
    const [crumb] = s.breadcrumbs.snapshot();
    expect(crumb?.message).toBe('crumb-under-project-b');
  });

  it('a same-key re-init preserves the crumb trail', () => {
    const client = createClient(stubAdapter());
    client.init({ apiKey: 'pk_project_a' });
    populate(client);

    client.init({ apiKey: 'pk_project_a', appVersion: '2.0.0' });

    const s = stateOf(client);
    expect(s.user).toEqual({ id: 'u_1', email: 'alice@a.com', displayName: 'Alice' });
    expect(resolveClientExtra(client)).toBe('order-4417');
    expect(s.breadcrumbs.size).toBe(1);
    expect(s.networkBodies.size).toBe(1);
    expect(s.config?.appVersion).toBe('2.0.0');
  });

  it('the very first init() resets nothing', () => {
    const client = createClient(stubAdapter());
    client.init({ apiKey: 'pk_project_a' });
    expect(stateOf(client).config?.apiKey).toBe('pk_project_a');
    expect(stateOf(client).user).toBeNull();
  });
});

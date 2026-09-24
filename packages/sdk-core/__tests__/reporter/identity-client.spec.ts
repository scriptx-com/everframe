// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter identity recognition (spec 2026-08-06) — `tx.setIdentityToken`
// wiring on the sdk-core client: guarded like every other handler
// (no-op pre-init / post-kill), wrapped in safeWrap (never throws), and
// backed by the same `IdentityTokenHolder` the platform layer reads via
// `__internalClientState` to attach the header to submits/reporter calls.
import { describe, it, expect } from 'vitest';
import { createClient, __internalClientState } from '../../src/client.js';
import { createFakePlatformAdapter } from '../../src/__test-helpers__/fake-platform-adapter.js';

const mkJwt = (expSec: number): string => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: expSec })}.sig`;
};

const freshClient = () => {
  const client = createClient(createFakePlatformAdapter());
  client.init({ apiKey: 'k' });
  return client;
};

describe('EverframeClient.setIdentityToken', () => {
  it('a one-shot string is retrievable through the shared holder', async () => {
    const client = freshClient();
    const jwt = mkJwt(Date.now() / 1000 + 300);
    client.setIdentityToken(jwt);
    const holder = __internalClientState.get(client)!.identityToken;
    expect(await holder.get(Date.now())).toBe(jwt);
  });

  it('null clears a previously-set token', async () => {
    const client = freshClient();
    client.setIdentityToken(mkJwt(Date.now() / 1000 + 300));
    client.setIdentityToken(null);
    const holder = __internalClientState.get(client)!.identityToken;
    expect(await holder.get(Date.now())).toBeNull();
  });

  it('is a no-op before init() — no state to guard yet', () => {
    const client = createClient(createFakePlatformAdapter());
    expect(() => client.setIdentityToken('whatever')).not.toThrow();
  });

  it('is a no-op after kill() — never throws (safeWrap doctrine)', () => {
    const client = freshClient();
    client.kill();
    expect(() => client.setIdentityToken(mkJwt(Date.now() / 1000 + 300))).not.toThrow();
  });

  it('a throwing provider never escapes setIdentityToken or a later get()', async () => {
    const client = freshClient();
    client.setIdentityToken(() => {
      throw new Error('no session');
    });
    const holder = __internalClientState.get(client)!.identityToken;
    expect(await holder.get(Date.now())).toBeNull();
  });

  it('kill() clears a live token — a sign-out/privacy path must not leave a signed credential in memory', async () => {
    const client = freshClient();
    const jwt = mkJwt(Date.now() / 1000 + 300);
    client.setIdentityToken(jwt);
    const holder = __internalClientState.get(client)!.identityToken;
    expect(await holder.get(Date.now())).toBe(jwt); // confirm it was live before kill
    client.kill();
    expect(await holder.get(Date.now())).toBeNull();
  });
});

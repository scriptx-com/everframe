// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// setExtra resolver form (spec 2026-09-17 setExtra-resolver). Triggers the
// SDK owns (the dashboard hotkey on web, native shake on mobile) open the
// reporter directly, with no chance for the host to refresh a pushed
// `extra` snapshot first — so a host has to push a fresh value on every
// input change or ship stale diagnostics. `setExtra(() => ...)` lets the
// host register a function the SDK calls when it assembles the report
// instead. These specs cover the resolver's lifecycle contract:
//   - registration (`setExtra`) never calls it
//   - `resolveClientExtra` (the one read seam — see client.ts) calls it,
//     once per call, so a second report sees fresh values
//   - its result is budgeted exactly like the eager object/string forms
//   - a throw is caught, warned, and never propagates or breaks the report
// String/object forms are also re-verified here so a regression that only
// showed up under the resolver branch can't silently change their behavior.
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createClient, __internalClientState, resolveClientExtra } from '../src/client.js';
import { createFakePlatformAdapter } from '../src/__test-helpers__/fake-platform-adapter.js';
import { EXTRA_MAX_CHARS } from '../src/extra-budget.js';

function mountedClient() {
  const client = createClient(createFakePlatformAdapter());
  client.init({ apiKey: 'test' });
  return client;
}

describe('setExtra resolver form', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is NOT invoked by setExtra itself — only by the read seam', () => {
    const client = mountedClient();
    const resolve = vi.fn(() => ({ screen: 'checkout' }));

    client.setExtra(resolve);
    expect(resolve).toHaveBeenCalledTimes(0);

    const extra = resolveClientExtra(client);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(extra).toBe(JSON.stringify({ screen: 'checkout' }));
  });

  it('re-invokes on every read, so a second report gets fresh values', () => {
    const client = mountedClient();
    let call = 0;
    client.setExtra(() => ({ n: ++call }));

    expect(resolveClientExtra(client)).toBe(JSON.stringify({ n: 1 }));
    expect(resolveClientExtra(client)).toBe(JSON.stringify({ n: 2 }));
    expect(resolveClientExtra(client)).toBe(JSON.stringify({ n: 3 }));
  });

  it('resolver returning a string under budget is returned verbatim', () => {
    const client = mountedClient();
    client.setExtra(() => 'order-4417');
    expect(resolveClientExtra(client)).toBe('order-4417');
  });

  it('resolver returning an over-budget object is omitted and warns, same as the object form', () => {
    const client = mountedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.setExtra(() => ({ huge: 'y'.repeat(EXTRA_MAX_CHARS * 2) }));

    const extra = resolveClientExtra(client);

    expect(extra).toBe('');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(`exceeds the ${EXTRA_MAX_CHARS}-char limit`);
  });

  it('resolver returning an over-budget string is omitted and warns', () => {
    const client = mountedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = 'x'.repeat(EXTRA_MAX_CHARS + 500);
    client.setExtra(() => big);

    const extra = resolveClientExtra(client);

    expect(extra).toBe('');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(`exceeds the ${EXTRA_MAX_CHARS} limit`);
  });

  it('a throwing resolver warns once, omits extra, and never propagates', () => {
    const client = mountedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.setExtra(() => {
      throw new Error('boom: player store not ready');
    });

    let extra: string | undefined;
    expect(() => {
      extra = resolveClientExtra(client);
    }).not.toThrow();

    expect(extra).toBe('');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('setExtra');
  });

  it('a throwing resolver does not corrupt subsequent reads with a good resolver re-registered', () => {
    const client = mountedClient();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.setExtra(() => {
      throw new Error('boom');
    });
    expect(resolveClientExtra(client)).toBe('');

    client.setExtra(() => ({ ok: true }));
    expect(resolveClientExtra(client)).toBe(JSON.stringify({ ok: true }));
  });

  it('registering a resolver REPLACES a previously registered string/object value', () => {
    const client = mountedClient();
    client.setExtra('stale-snapshot');
    expect(resolveClientExtra(client)).toBe('stale-snapshot');

    client.setExtra(() => 'fresh-from-resolver');
    expect(resolveClientExtra(client)).toBe('fresh-from-resolver');
  });

  it('registering a string/object REPLACES a previously registered resolver', () => {
    const client = mountedClient();
    const resolve = vi.fn(() => 'from-resolver');
    client.setExtra(resolve);
    expect(resolveClientExtra(client)).toBe('from-resolver');

    client.setExtra('plain-string');
    expect(resolveClientExtra(client)).toBe('plain-string');
    // The old resolver must not still be reachable/invoked after replacement.
    expect(resolveClientExtra(client)).toBe('plain-string');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('is a no-op before init / after kill, same as the string and object forms', () => {
    const adapter = createFakePlatformAdapter();
    const client = createClient(adapter);
    const resolve = vi.fn(() => ({ a: 1 }));

    // Before init: no config yet.
    client.setExtra(resolve);
    expect(resolveClientExtra(client)).toBe('');

    client.init({ apiKey: 'test' });
    client.kill();
    client.setExtra(resolve);
    expect(resolveClientExtra(client)).toBe('');
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('setExtra string/object forms — unchanged by the resolver addition', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('string form is read back verbatim when under budget', () => {
    const client = mountedClient();
    client.setExtra('hello world');
    expect(resolveClientExtra(client)).toBe('hello world');
  });

  it('string form over budget warns at the call site (unchanged behavior)', () => {
    const client = mountedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const big = 'x'.repeat(EXTRA_MAX_CHARS + 500);
    client.setExtra(big);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(`${big.length} chars exceeds the ${EXTRA_MAX_CHARS} limit`);
  });

  it('object form under budget serializes and is read back as JSON', () => {
    const client = mountedClient();
    const value = { userId: 'u_1', screen: 'checkout', cartSize: 3 };
    client.setExtra(value);
    expect(resolveClientExtra(client)).toBe(JSON.stringify(value));
  });

  it('object form over budget is omitted immediately (at setExtra time) with a warning', () => {
    const client = mountedClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const value = { huge: 'y'.repeat(EXTRA_MAX_CHARS * 2) };
    client.setExtra(value);
    expect(resolveClientExtra(client)).toBe('');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(`exceeds the ${EXTRA_MAX_CHARS}-char limit`);
  });

  it('resolveClientExtra returns "" for a client with no recorded state (defensive)', () => {
    const client = createClient(createFakePlatformAdapter());
    // Simulate a client whose internal state was never registered.
    __internalClientState.delete(client);
    expect(resolveClientExtra(client)).toBe('');
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** @vitest-environment jsdom */
//
// Fix round 2 — the vanilla path must not announce a PIN surface it has no
// way to render.
//
// `attachPinUi` defaults to `'builtin'`, which announces `supportsAttachPin`
// to the relay (singleton.ts). But the builtin surface is `CompanionPinCard`,
// and the ONLY thing that mounts it is `EverframeProvider`. So a vanilla host
// that calls `companion.start()` with defaults tells the relay it can show a
// PIN, a dashboard member requests attach, and the challenge expires with
// nothing ever shown — burning an attempt from the budget and the member's
// TTL window. `AttachPinUiMode`'s own FAIL-CLOSED WARNING calls this state
// "strictly worse than 'off'", and the remedy it names ("Mount the Provider,
// or pass 'off'") is not something a vanilla host can follow.
//
// The fix is a guard, not the feature: `init()` declares that this host has
// no builtin PIN surface, and `start()` resolves `'builtin'` -> `'off'` when
// that is so. React never calls the declaration, so its default stays
// `'builtin'` and CompanionPinCard keeps rendering.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as companion from '../../src/companion/singleton.js';
import {
  __getAttachPinUiMode,
  __getCompanionBadgeConfig,
  __resetPinSurfaceStateForTests,
} from '../../src/companion/singleton.js';
import { __setCompanionBadgeServerConfig } from '../../src/companion/server-config.js';
import { __resetDeviceIdForTests } from '../../src/companion/device-id.js';
import { init, type Everframe } from '../../src/init.js';

// The island is never mounted here (nothing opens the reporter), but stub it
// anyway so a stray open can't drag React into a companion spec.
vi.mock('../../src/mount/react-island.js', () => ({
  mountIsland: () => ({
    setOpen: () => undefined,
    setInboxOpen: () => undefined,
    toast: () => undefined,
    unmount: () => undefined,
  }),
}));

/** Minimal WebSocket stand-in — `start()` opens one; we only read the announce. */
function fakeWebSocket(): typeof WebSocket {
  return function FakeWS(url: string) {
    return {
      url,
      readyState: 0,
      binaryType: 'blob',
      OPEN: 1,
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: () => undefined,
    };
  } as unknown as typeof WebSocket;
}

let handle: Everframe | null = null;
let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The one-time warning latch and the surface declaration are module state,
  // so they outlive a test — reset both or the assertions become
  // order-dependent.
  __resetPinSurfaceStateForTests();
  __resetDeviceIdForTests();
  // Module-level box, written by adapter.ts's config refresh — cleared so the
  // badge assertions below are not order-dependent.
  __setCompanionBadgeServerConfig(undefined);
  vi.stubGlobal('WebSocket', fakeWebSocket());
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/companion/announce')) {
      return new Response(JSON.stringify({ ticket: 'tkt', code: '7K2Q' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  companion.stop();
  handle?.destroy();
  handle = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** The body of the `/api/companion/announce` POST, once it has been sent. */
async function announceBody(): Promise<Record<string, unknown>> {
  const call = await vi.waitFor(() => {
    const found = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/companion/announce'),
    );
    expect(found).toBeTruthy();
    return found!;
  });
  return JSON.parse(call[1].body as string);
}

const startOpts = { endpoint: 'https://relay.example.com', sdkKey: 'txx_live_x' };

describe('attach-PIN capability is only announced when something can render it', () => {
  it('a vanilla init() host does NOT announce supportsAttachPin under the default', async () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start(startOpts);
    expect(__getAttachPinUiMode()).toBe('off');
    expect(await announceBody()).not.toHaveProperty('supportsAttachPin');
  });

  it('warns once, naming the routes that actually work', async () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start(startOpts);
    companion.stop();
    companion.start(startOpts);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('attachPinUi');
    expect(message).toContain("'custom'");
    expect(message).toContain("'off'");
  });

  it("still announces when a vanilla host explicitly takes responsibility with 'custom'", async () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start({ ...startOpts, attachPinUi: 'custom' });
    expect(__getAttachPinUiMode()).toBe('custom');
    expect(await announceBody()).toHaveProperty('supportsAttachPin', true);
    // An explicit choice is the host's to make: no lecture.
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for an explicit 'off' — nothing was promised, nothing to warn about", async () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start({ ...startOpts, attachPinUi: 'off' });
    expect(__getAttachPinUiMode()).toBe('off');
    expect(await announceBody()).not.toHaveProperty('supportsAttachPin');
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves the React path alone: no init() means the builtin surface is presumed present', async () => {
    // @everframe/react never calls the declaration — EverframeProvider mounts
    // CompanionPinCard, so 'builtin' is honest there and must keep announcing.
    companion.start(startOpts);
    expect(__getAttachPinUiMode()).toBe('builtin');
    expect(await announceBody()).toHaveProperty('supportsAttachPin', true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("destroy() gives the declaration back, so a later Provider mount is not poisoned", async () => {
    handle = init({ apiKey: 'txx_live_test' });
    handle.destroy();
    handle = null;
    companion.start(startOpts);
    expect(__getAttachPinUiMode()).toBe('builtin');
    expect(await announceBody()).toHaveProperty('supportsAttachPin', true);
  });
});


// Codex round-2 finding 5 (P2), the same failure one surface over.
// `companionBadge` is documented as default-ON, but `CompanionBadge` is
// rendered ONLY by `@everframe/react`'s Provider. It is an AMBIENT surface — it
// has to be on screen while the reporter is closed — and the vanilla mount's
// only ambient element is the plain-DOM FAB; the badge lives behind the lazy
// React island, which by construction is not mounted then. So a Vue or
// plain-HTML host could enable it, position it, have the dashboard turn it on,
// and get nothing, with no signal anywhere.
//
// Treated exactly like the attach-PIN limitation above (the precedent this
// follows): the vanilla host declares it has no badge surface, the effective
// config resolves to OFF, and the README says so. Rendering it instead would
// mean a second always-loaded ambient surface — the thing the lazy island
// exists to avoid.
describe('the companion badge is only enabled where something can render it', () => {
  it('leaves the React path alone: no init() means the badge stays on by default', () => {
    companion.start(startOpts);
    expect(__getCompanionBadgeConfig().enabled).toBe(true);
  });

  it('resolves to OFF on a vanilla init() host', () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start(startOpts);
    expect(__getCompanionBadgeConfig().enabled).toBe(false);
  });

  it('stays OFF even when the host explicitly enables it — and says so, once', () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start({ ...startOpts, companionBadge: { enabled: true } });
    companion.stop();
    companion.start({ ...startOpts, companionBadge: { enabled: true } });

    expect(__getCompanionBadgeConfig().enabled).toBe(false);
    const badgeWarnings = (warn.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .filter((m: string) => m.includes('companionBadge'));
    expect(badgeWarnings).toHaveLength(1);
    expect(badgeWarnings[0]).toContain('CompanionBadge');
  });

  it('says nothing when the host never asked for a badge', () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start(startOpts);
    // The PIN downgrade warns on its default because 'builtin' ANNOUNCES a
    // capability to the relay and burns a real member's attach attempt. The
    // badge has no off-device consequence, so lecturing every vanilla start()
    // about a surface nobody asked for would be pure noise.
    expect(
      (warn.mock.calls as unknown[][])
        .map((c) => String(c[0]))
        .filter((m: string) => m.includes('companionBadge')),
    ).toHaveLength(0);
  });

  it('a dashboard override cannot conjure a renderer either', () => {
    handle = init({ apiKey: 'txx_live_test' });
    companion.start({ ...startOpts, companionBadge: { enabled: false } });

    // The server block normally WINS over the inline option (that is the
    // point of the dashboard control) — but it cannot make a surface exist.
    __setCompanionBadgeServerConfig({ enabled: true, position: 'top-left' });

    expect(__getCompanionBadgeConfig().enabled).toBe(false);
  });

  it('LIVE control: the same server override DOES enable it on the React path', () => {
    companion.start(startOpts);
    __setCompanionBadgeServerConfig({ enabled: true, position: 'top-left' });
    expect(__getCompanionBadgeConfig().enabled).toBe(true);
  });

  it('destroy() gives the declaration back, so a later Provider mount is not poisoned', () => {
    handle = init({ apiKey: 'txx_live_test' });
    handle.destroy();
    handle = null;
    companion.start(startOpts);
    expect(__getCompanionBadgeConfig().enabled).toBe(true);
  });
});

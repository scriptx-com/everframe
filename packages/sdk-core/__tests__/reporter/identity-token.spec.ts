// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Reporter identity recognition (spec 2026-08-06), SDK side — the in-memory
// token holder. See src/reporter/identity-token.ts for the decode-not-verify
// posture and the never-throw contract this suite pins.
import { describe, it, expect, vi } from 'vitest';
import {
  IdentityTokenHolder,
  IDENTITY_PROVIDER_TIMEOUT_MS,
  IDENTITY_TOKEN_MAX_CHARS,
  decodeSub,
  presentableIdentityToken,
} from '../../src/reporter/identity-token.js';

const mkJwt = (expSec: number, sub = 'u1'): string => {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ sub, exp: expSec })}.sig`;
};

describe('IdentityTokenHolder', () => {
  it('returns a one-shot token until it nears expiry', async () => {
    const h = new IdentityTokenHolder();
    const now = 1_000_000_000_000;
    h.set(mkJwt(now / 1000 + 300));
    expect(await h.get(now)).not.toBeNull();
  });

  it('drops a one-shot token once it is inside the refresh margin', async () => {
    const h = new IdentityTokenHolder();
    const now = 1_000_000_000_000;
    h.set(mkJwt(now / 1000 + 10)); // 10s left, margin is 30s
    expect(await h.get(now)).toBeNull();
  });

  it('re-asks the provider when the cached token nears expiry', async () => {
    const now = 1_000_000_000_000;
    let calls = 0;
    const h = new IdentityTokenHolder();
    h.set(() => {
      calls += 1;
      return mkJwt(now / 1000 + 300);
    });

    await h.get(now);
    await h.get(now);
    expect(calls).toBe(1); // cached

    await h.get(now + 280_000); // inside the margin
    expect(calls).toBe(2);
  });

  it('resolves null when the provider throws', async () => {
    const h = new IdentityTokenHolder();
    h.set(() => {
      throw new Error('no session');
    });
    expect(await h.get(Date.now())).toBeNull();
  });

  it('resolves null when the provider outlives the timeout', async () => {
    vi.useFakeTimers();
    const h = new IdentityTokenHolder();
    h.set(() => new Promise<string>(() => {})); // never settles
    const pending = h.get(Date.now());
    await vi.advanceTimersByTimeAsync(IDENTITY_PROVIDER_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();
    vi.useRealTimers();
  });

  it('null clears everything', async () => {
    const h = new IdentityTokenHolder();
    h.set(mkJwt(Date.now() / 1000 + 300));
    h.set(null);
    expect(await h.get(Date.now())).toBeNull();
  });

  it('treats an undecodable token as absent rather than throwing', async () => {
    const h = new IdentityTokenHolder();
    h.set('not-a-jwt');
    expect(await h.get(Date.now())).toBeNull();
  });

  // PR review Finding 1 (2026-08-06 identity spec) — a provider call started
  // for one identity must not repopulate the cache once `set()` has moved
  // the holder on while that call was still in flight. Concretely: a token
  // request starts for Alice; Alice signs out (`set(null)`) or the host
  // switches to Bob (`set(bobProvider)`) before the request resolves; the
  // late result must be discarded, not cached and not returned.
  describe('generation guard against a stale in-flight provider result (Finding 1)', () => {
    it('discards a late provider result after set(null) mid-flight — resolves null and does not repopulate the cache', async () => {
      vi.useFakeTimers();
      const h = new IdentityTokenHolder();
      const now = 1_000_000_000_000;
      let resolveProvider!: (v: string) => void;
      h.set(() => new Promise<string>((resolve) => { resolveProvider = resolve; }));

      const pending = h.get(now); // Alice's request starts…
      // Let get() actually invoke source() (deferred one microtask via the
      // `Promise.resolve().then(() => source())` wrapper) before we act.
      await Promise.resolve();
      await Promise.resolve();

      h.set(null); // …Alice signs out while it's still in flight…
      resolveProvider(mkJwt(now / 1000 + 300, 'alice')); // …then Alice's token arrives late.

      expect(await pending).toBeNull();
      // A subsequent get() must still be null — the cache was NOT
      // repopulated by the stale result (there's also no source anymore).
      expect(await h.get(now)).toBeNull();
      vi.useRealTimers();
    });

    it('discards a late provider result after set() swaps identity mid-flight — later get() returns the NEW token, never the stale one', async () => {
      vi.useFakeTimers();
      const h = new IdentityTokenHolder();
      const now = 1_000_000_000_000;
      let resolveProvider!: (v: string) => void;
      h.set(() => new Promise<string>((resolve) => { resolveProvider = resolve; }));

      const pending = h.get(now); // Alice's request starts…
      await Promise.resolve();
      await Promise.resolve();

      const bobToken = mkJwt(now / 1000 + 300, 'bob');
      h.set(bobToken); // …the host switches straight to Bob while it's in flight…
      resolveProvider(mkJwt(now / 1000 + 300, 'alice')); // …then Alice's stale result arrives.

      expect(await pending).toBeNull(); // the in-flight call's own result is discarded
      expect(await h.get(now)).toBe(bobToken); // a later get() sees Bob, never Alice
      vi.useRealTimers();
    });
  });
});

// Adversarial review of PR #218 round 2, finding 3 — the cold-start twin. The
// vitals collector reads identity synchronously and cache-only, so a fresh
// session's first summary cannot carry a token; it used to carry the
// self-declared `user` block instead and mint an UNVERIFIED person the next
// summary then verified into a SECOND row. `hasUnresolvedSource()` is what
// lets the collector withhold that block while the verified tier is
// configured but has nothing to present.
//
// ROUND 5 REPLACED THE MECHANISM WITH A STATELESS RULE: "a source is set and
// `peek(now)` is null". Rounds 2, 3 and 4 each shipped a flag recording
// whether the source had "settled on nobody", and each round found a new
// ordering that left the flag disagreeing with the cache — always in the
// dangerous direction, the `user` block going out with no credential beside
// it. The two round-5 reproductions are pinned below; the tests that used to
// assert the flag's re-arming rules are gone with the flag.
describe('IdentityTokenHolder.hasUnresolvedSource', () => {
  const NOW = 1_000_000_000_000;

  it('is false with no source configured — the verified tier is not in play', () => {
    expect(new IdentityTokenHolder().hasUnresolvedSource(NOW)).toBe(false);
  });

  it('is true the moment a source is set, before any get() has resolved', () => {
    const h = new IdentityTokenHolder();
    h.set(async () => mkJwt(NOW / 1000 + 300));
    expect(h.hasUnresolvedSource(NOW)).toBe(true);
  });

  it('is false while a resolved token is warm in the cache', async () => {
    const h = new IdentityTokenHolder();
    h.set(async () => mkJwt(NOW / 1000 + 300));
    await h.get(NOW);
    expect(h.hasUnresolvedSource(NOW)).toBe(false);
    expect(h.peek(NOW)).not.toBeNull();
  });

  // ROUND 3, reproduction 1 — the expiring cache. Nothing failed here: the
  // provider works, the token was fetched, and it has simply aged into
  // `IDENTITY_REFRESH_MARGIN_MS`. `peek()` says null, so a summary sent now
  // carries no token; answering "settled" as well would let the self-declared
  // block go out and mint the unverified half of a twin the refresh is about
  // to verify.
  it('ROUND 3: is true again once the cached token ages into the refresh margin', async () => {
    const h = new IdentityTokenHolder();
    h.set(async () => mkJwt(NOW / 1000 + 60));
    await h.get(NOW);
    expect(h.hasUnresolvedSource(NOW)).toBe(false);

    const inMargin = NOW + 40_000; // exp - now < IDENTITY_REFRESH_MARGIN_MS
    expect(h.peek(inMargin)).toBeNull();
    expect(h.hasUnresolvedSource(inMargin)).toBe(true);
  });

  // ROUND 5 — THE KNOWN COST OF THE STATELESS RULE, asserted rather than
  // discovered. A provider that answers "nobody is signed in" leaves the cache
  // empty, so a configured source keeps withholding the self-declared block
  // and those sessions stay ANONYMOUS. That is invariant 1's trade (see
  // `hasUnresolvedSource`); the opt-out is `setIdentityToken(null)`, covered
  // by the sign-out test at the bottom of this block.
  it('ROUND 5: stays true for a provider that resolves NULL — signed-out stays anonymous', async () => {
    const h = new IdentityTokenHolder();
    h.set(async () => null);
    await h.get(NOW);
    expect(h.hasUnresolvedSource(NOW)).toBe(true);
  });

  // ROUND 3, reproduction 2 — the recovering provider. A throw or a timeout is
  // a FAILURE: treating it as settled let the self-declared block out, and the
  // provider's next success then minted the verified twin. A failed credential
  // resolves anonymous instead (invariant 1).
  it('ROUND 3: stays true after a provider throws or times out', async () => {
    const h = new IdentityTokenHolder();
    h.set(() => {
      throw new Error('provider exploded');
    });
    await h.get(NOW);
    expect(h.hasUnresolvedSource(NOW)).toBe(true);

    vi.useFakeTimers();
    try {
      const hung = new IdentityTokenHolder();
      hung.set(() => new Promise<string>(() => undefined));
      const pending = hung.get(NOW);
      await vi.advanceTimersByTimeAsync(IDENTITY_PROVIDER_TIMEOUT_MS + 1);
      expect(await pending).toBeNull();
      expect(hung.hasUnresolvedSource(NOW)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // A one-shot string cannot be re-asked, so a GOOD one settles by being
  // cached and an UNUSABLE one is a configured credential that failed —
  // anonymous, never a downgrade to the self-declared block (invariant 1).
  it('is false for a warm one-shot string, and true for an undecodable one', async () => {
    const good = new IdentityTokenHolder();
    good.set(mkJwt(NOW / 1000 + 300));
    await good.get(NOW);
    expect(good.hasUnresolvedSource(NOW)).toBe(false);

    const junk = new IdentityTokenHolder();
    junk.set('not-a-jwt');
    expect(await junk.get(NOW)).toBeNull();
    expect(junk.hasUnresolvedSource(NOW)).toBe(true);
  });

  // ROUND 4, finding 1's other half, and the one property that survives it:
  // asking repeatedly must not change the answer either way. The collector
  // warms this holder in the SAME synchronous turn as the summary that
  // follows, so a predicate that moved on `get()` alone would flap every tick.
  it('ROUND 4: repeated get() calls do not move the answer on their own', async () => {
    let token: string | null = null;
    const h = new IdentityTokenHolder();
    h.set(() => token);
    for (let tickNo = 0; tickNo < 5; tickNo++) {
      const warm = h.get(NOW); // the collector's warm…
      expect(h.hasUnresolvedSource(NOW)).toBe(true); // …summary in the same turn
      await warm;
      expect(h.hasUnresolvedSource(NOW)).toBe(true);
    }

    // Only a readable token moves it, and it does so immediately.
    token = mkJwt(NOW / 1000 + 300);
    await h.get(NOW);
    expect(h.peek(NOW)).toBe(token);
    expect(h.hasUnresolvedSource(NOW)).toBe(false);
  });

  // ROUND 5, FINDING 1 (reproduced). A provider that resolves null and then
  // starts returning an UNDECODABLE token used to leave the stale "nobody"
  // answer in place, so the summary that followed carried the `user` block
  // with no credential — a failed identity downgraded to a self-declared one.
  // Throws and non-string results took the same path.
  it('ROUND 5: null then an undecodable/broken result never opens the self-declared block', async () => {
    for (const broken of ['not-a-jwt', 12345, undefined]) {
      const h = new IdentityTokenHolder();
      let value: unknown = null;
      h.set((() => value) as () => string | null);
      await h.get(NOW);

      value = broken;
      expect(await h.get(NOW)).toBeNull();
      expect(h.peek(NOW)).toBeNull();
      expect(h.hasUnresolvedSource(NOW)).toBe(true);
    }
  });

  // ROUND 5, FINDING 2 (reproduced). Two overlapping `get()` calls — the
  // vitals warm and a reporter submission — resolving TOKEN FIRST, NULL LAST.
  // The outstanding-call counter guarded only the opposite ordering, so the
  // null sibling stamped "nobody" over a holder that had just cached a real
  // token; once that token aged into the refresh margin, a summary during the
  // next pending refresh carried `user` with no credential.
  it('ROUND 5: a late null sibling cannot open the block while a token is cached', async () => {
    const defer = () => {
      let resolve!: (v: string | null) => void;
      const promise = new Promise<string | null>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const first = defer();
    const second = defer();
    const third = defer();
    const queue = [first, second, third];
    const h = new IdentityTokenHolder();
    h.set(() => queue.shift()!.promise);

    const p1 = h.get(NOW);
    const p2 = h.get(NOW);
    const alice = mkJwt(NOW / 1000 + 60);
    first.resolve(alice); // the token lands…
    expect(await p1).toBe(alice);
    second.resolve(null); // …and the sibling answers "nobody" afterwards
    expect(await p2).toBeNull();

    // A usable token is cached, so nothing is withheld.
    expect(h.peek(NOW)).toBe(alice);
    expect(h.hasUnresolvedSource(NOW)).toBe(false);

    // And once it ages into the refresh margin the block is withheld again,
    // rather than being released by that stale null.
    const inMargin = NOW + 40_000;
    const refresh = h.get(inMargin);
    expect(h.hasUnresolvedSource(inMargin)).toBe(true);
    third.resolve(mkJwt(inMargin / 1000 + 300));
    await refresh;
    expect(h.hasUnresolvedSource(inMargin)).toBe(false);
  });

  // ROUND 4, finding 4 — OVERLAPPING CALLS, null first and a token second.
  // The window must stay open until the token is actually readable, and close
  // the moment it is.
  it('ROUND 4: a null resolution does not close the window while a sibling call is still outstanding', async () => {
    const defer = () => {
      let resolve!: (v: string | null) => void;
      const promise = new Promise<string | null>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const first = defer();
    const second = defer();
    let call = 0;
    const h = new IdentityTokenHolder();
    h.set(() => (call++ === 0 ? first.promise : second.promise));

    const p1 = h.get(NOW); // the vitals warm
    const p2 = h.get(NOW); // a reporter submission, same generation

    first.resolve(null);
    expect(await p1).toBeNull();
    // The window MUST still be open: the sibling has not answered, and it is
    // about to answer with Alice's token.
    expect(h.hasUnresolvedSource(NOW)).toBe(true);

    const alice = mkJwt(NOW / 1000 + 300);
    second.resolve(alice);
    expect(await p2).toBe(alice);
    expect(h.peek(NOW)).toBe(alice);
    expect(h.hasUnresolvedSource(NOW)).toBe(false);
  });

  // `set()` drops the cache, so a NEW source reopens the window — the host
  // switching users must not inherit the old source's token. `set(null)` is
  // the sign-out the stateless rule relies on: no source, nothing withheld.
  it('reopens on a new source and closes again on sign-out', async () => {
    const h = new IdentityTokenHolder();
    h.set(async () => mkJwt(NOW / 1000 + 300));
    await h.get(NOW);
    expect(h.hasUnresolvedSource(NOW)).toBe(false);

    h.set(async () => mkJwt(NOW / 1000 + 600));
    expect(h.hasUnresolvedSource(NOW)).toBe(true);

    h.set(null); // sign-out: no source, so the self-declared tier is free
    expect(h.hasUnresolvedSource(NOW)).toBe(false);
  });
});

// PR review, Serious finding (feat/traceitx-identity) — a non-destructive
// validity predicate consulted at the top of BOTH get() and peek(). See
// src/reporter/identity-token.ts's `setGuard` doc for the design: a refusal
// must never clear the cache or touch the source, so a spurious refusal
// costs one anonymous read rather than destroying a live token.
describe('IdentityTokenHolder guard', () => {
  it('get() resolves null when the guard returns false, without invoking the source', async () => {
    const h = new IdentityTokenHolder();
    const now = 1_000_000_000_000;
    let providerCalls = 0;
    h.set(() => {
      providerCalls += 1;
      return mkJwt(now / 1000 + 300);
    });
    h.setGuard(() => false);

    expect(await h.get(now)).toBeNull();
    expect(providerCalls).toBe(0);
  });

  it('peek() resolves null when the guard returns false, without touching the cache', async () => {
    const h = new IdentityTokenHolder();
    const now = 1_000_000_000_000;
    h.set(mkJwt(now / 1000 + 300));
    expect(await h.get(now)).not.toBeNull(); // populate the cache first

    h.setGuard(() => false);
    expect(h.peek(now)).toBeNull();
  });

  it('a refusal is non-destructive: the cache survives and is served again once the guard allows it, with no new provider call', async () => {
    const now = 1_000_000_000_000;
    let providerCalls = 0;
    const h = new IdentityTokenHolder();
    h.set(() => {
      providerCalls += 1;
      return mkJwt(now / 1000 + 300);
    });

    let allowed = true;
    h.setGuard(() => allowed);

    const token = await h.get(now);
    expect(token).not.toBeNull();
    expect(providerCalls).toBe(1);

    allowed = false;
    expect(await h.get(now)).toBeNull(); // refused, but the cache is untouched
    expect(h.peek(now)).toBeNull();

    allowed = true;
    expect(await h.get(now)).toBe(token); // same cached token, no re-mint
    expect(h.peek(now)).toBe(token);
    expect(providerCalls).toBe(1);
  });

  it('a throwing guard yields null rather than propagating', async () => {
    const h = new IdentityTokenHolder();
    const now = 1_000_000_000_000;
    h.set(mkJwt(now / 1000 + 300));
    await h.get(now); // populate the cache

    h.setGuard(() => {
      throw new Error('guard blew up');
    });

    await expect(h.get(now)).resolves.toBeNull();
    expect(h.peek(now)).toBeNull();
  });

  // PR review (Serious, feat/traceitx-identity) — the guard was previously
  // consulted only ONCE, at the top of get(), before the provider await. A
  // guard flip that happens WHILE a provider mint is in flight (e.g. the
  // app switching from Alice to Bob mid-request) must still block the
  // in-flight result from being cached and returned — not just a guard
  // check made before the request ever started.
  it('discards an in-flight provider result if the guard denies after the await resolves — does not cache it either', async () => {
    const h = new IdentityTokenHolder();
    const now = 1_000_000_000_000;
    let resolveProvider!: (v: string) => void;
    h.set(() => new Promise<string>((resolve) => { resolveProvider = resolve; }));

    let allowed = true;
    h.setGuard(() => allowed);

    const pending = h.get(now); // Alice's mint starts while the guard allows…
    // Let get() actually invoke source() (deferred one microtask via the
    // `Promise.resolve().then(() => source())` wrapper) before we act, same
    // as the generation-guard tests above.
    await Promise.resolve();
    await Promise.resolve();

    allowed = false; // …the app switches to Bob, flipping the guard to deny…
    resolveProvider(mkJwt(now / 1000 + 300, 'alice')); // …then Alice's token arrives late.

    expect(await pending).toBeNull();

    // The important half: the cache must NOT have been populated with
    // Alice's token. Re-allow the guard and confirm peek() (cache-only,
    // synchronous — never re-invokes the provider) still sees nothing —
    // proving Alice's token was never stored, not just withheld from this
    // one call.
    allowed = true;
    expect(h.peek(now)).toBeNull();
  });

  it('setGuard(null) restores normal behaviour', async () => {
    const h = new IdentityTokenHolder();
    const now = 1_000_000_000_000;
    h.set(mkJwt(now / 1000 + 300));
    const token = await h.get(now);

    h.setGuard(() => false);
    expect(await h.get(now)).toBeNull();

    h.setGuard(null);
    expect(await h.get(now)).toBe(token);
    expect(h.peek(now)).toBe(token);
  });
});

// ROUND 4, finding 2 — SURROUNDING WHITESPACE IS NOT A BROKEN CREDENTIAL.
// A provider handing back `' ' + jwt + ' '` (a template literal, a header
// echoed back with its padding) was cached by the holder and then refused by
// the wire gate, which withheld the self-declared `user` block along with the
// token: an anonymous session for a credential that authenticates perfectly —
// native `Request` normalizes those spaces, so the fetch path used to send it
// happily. The gate trims first and hands back WHAT TO SEND, and the holder
// caches that same normalized string, so there is one value and no drift.
describe('presentableIdentityToken', () => {
  const NOW = 1_000_000_000_000;

  it('accepts a padded token and returns it trimmed', () => {
    const jwt = mkJwt(NOW / 1000 + 300);
    expect(presentableIdentityToken(`  ${jwt}\n`)).toBe(jwt);
    expect(presentableIdentityToken(jwt)).toBe(jwt);
  });

  it('still refuses what is genuinely unusable in a header', () => {
    // Interior CR/LF — the case that made `fetch` refuse the header outright
    // (round-3 finding 3), which no amount of trimming makes safe.
    expect(presentableIdentityToken('eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.si\ng')).toBeNull();
    // Not a compact JWS at all.
    expect(presentableIdentityToken('not-a-jwt')).toBeNull();
    // Over the server's own ceiling — refused there as `malformed` anyway.
    expect(presentableIdentityToken(`eyJ.${'a'.repeat(IDENTITY_TOKEN_MAX_CHARS)}.sig`)).toBeNull();
    // Trimmed to nothing.
    expect(presentableIdentityToken('   ')).toBeNull();
  });

  it('measures the TRIMMED length against the cap, not the padding', () => {
    const atCap = `eyJ.${'a'.repeat(IDENTITY_TOKEN_MAX_CHARS - 'eyJ..sig'.length)}.sig`;
    expect(atCap).toHaveLength(IDENTITY_TOKEN_MAX_CHARS);
    expect(presentableIdentityToken(`   ${atCap}   `)).toBe(atCap);
  });
});

describe('IdentityTokenHolder normalizes what it caches (round 4, finding 2)', () => {
  const NOW = 1_000_000_000_000;

  it('caches and returns the TRIMMED token from a provider', async () => {
    const jwt = mkJwt(NOW / 1000 + 300);
    const h = new IdentityTokenHolder();
    h.set(async () => `  ${jwt}\n`);
    expect(await h.get(NOW)).toBe(jwt);
    expect(h.peek(NOW)).toBe(jwt);
  });

  it('caches and returns the TRIMMED token from a one-shot string', async () => {
    const jwt = mkJwt(NOW / 1000 + 300);
    const h = new IdentityTokenHolder();
    h.set(` ${jwt} `);
    expect(await h.get(NOW)).toBe(jwt);
    expect(h.peek(NOW)).toBe(jwt);
  });
});

describe('decodeSub', () => {
  it('decodes the sub claim of a well-formed token', () => {
    expect(decodeSub(mkJwt(2_000_000_000, 'alice-123'))).toBe('alice-123');
  });

  it('returns null for an undecodable token', () => {
    expect(decodeSub('not-a-jwt')).toBeNull();
  });

  it('returns null when sub is missing', () => {
    const b64 = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${b64({ alg: 'HS256' })}.${b64({ exp: 2_000_000_000 })}.sig`;
    expect(decodeSub(token)).toBeNull();
  });
});

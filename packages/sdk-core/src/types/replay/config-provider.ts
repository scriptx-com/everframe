// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CONFIG-02 — fail-closed remote per-app session-replay config provider.
//
// Contract (RESEARCH §"GET /api/config contract", Pitfall 7):
//   - `GET /api/config` authed by the Bearer SDK key (exactly like /api/ingest).
//   - Response is Zod-validated both ends: { replayEnabled, replayDurationSec, samplingRate }.
//   - Default object is OFF; overwritten ONLY by a fully Zod-validated 200.
//   - FAIL CLOSED on every error path: network rejection / non-200 / malformed body /
//     missing/wrong-typed field (Zod fail) / timeout (AbortSignal). On any failure the
//     cache keeps its current value and `refresh()` resolves silently (never throws).
//   - TTL 5 min; refresh is a no-op within the window; refetches after expiry.
//   - `samplingRate` is surfaced verbatim for the lifecycle sampling gate (CONFIG-04).
//
// sdk-core stays DOM-free — this module pulls in no browser/replay library.
import { z } from 'zod';
import { BreadcrumbKind } from '@everframe/protocol';
import { boundWait, timeoutSignal } from '../../transport/timeout-signal.js';
import { __traceReplay } from '../../debug/replay-trace.js';

/**
 * Server-driven breadcrumbs config (spec §6), delivered inside the existing
 * `GET /api/config` response. UNLIKE replay (fail-closed OFF), breadcrumbs
 * default ON when the block is absent — they are cheap, permission-free, and
 * the spec's default. A malformed block still fails the whole response parse,
 * keeping the last-good cache (CONFIG-02 semantics unchanged).
 */
export const BreadcrumbsConfig = z
  .object({
    enabled: z.boolean(),
    kinds: z.array(BreadcrumbKind),
    maxCount: z.number().int().positive(),
    byteBudget: z.number().int().positive(),
    consoleEntryCap: z.number().int().positive(),
  })
  .strict();

export type BreadcrumbsConfig = z.infer<typeof BreadcrumbsConfig>;

/** Client-side defaults applied when the server omits the block (spec §6). */
export const BREADCRUMBS_CONFIG_DEFAULT: BreadcrumbsConfig = Object.freeze({
  enabled: true,
  kinds: [...BreadcrumbKind.options],
  maxCount: 100,
  byteBudget: 16384,
  consoleEntryCap: 1024,
});

/**
 * Server-driven network-body-capture config (spec 2026-07-18 §4.1), delivered
 * inside the existing `GET /api/config` response. Fail-closed like replay:
 * absent block ⇒ capture OFF with SDK defaults. `captureBodies` is the master
 * gate.
 *
 * F21 (round-2 review): the known fields below are bounded to the exact
 * ceilings the server enforces in `NetworkBodiesBlockSchema`
 * (the server configuration contract) and the native SDKs
 * decode-time-validate in `NetworkBodiesConfigWire`/`init(from:)` (826e5f76,
 * F10) — `bodyByteCap` 1...65536, `bodyTotalBudget` 1...1_048_576,
 * `bodyContentTypes` 1...16 entries of 1...64 chars each. Without these, an
 * out-of-range value (e.g. `bodyByteCap: 999999999`) would sail through and
 * reach the live web body buffer/capture path ungoverned by the server's own
 * contract.
 *
 * Unlike the OUTER `ReplayConfigResponse` (still `.strict()` below — an
 * unrelated top-level key must keep fail-closing the whole parse), this
 * NESTED block uses `.strip()`: a future server-added field INSIDE
 * `networkBodies` is dropped rather than fail-closing the whole config parse
 * (which would also take down replay + breadcrumbs config, unrelated blocks).
 * This is the same nested-leniency hazard the native SDKs already guard
 * against with a lenient surrogate decoder for their nested blocks
 * (ReplayConfigProvider.kt's `NetworkBodiesConfigWireSerializer` /
 * `BreadcrumbsConfigWireSerializer`) — `.strip()` here is sdk-core's
 * equivalent: keep the validated known fields, silently drop unknown ones,
 * never fail the parse over them.
 */
export const NetworkBodiesServerConfig = z
  .object({
    captureBodies: z.boolean(),
    bodyByteCap: z.number().int().min(1).max(65_536).optional(),
    bodyContentTypes: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
    bodyTotalBudget: z.number().int().min(1).max(1_048_576).optional(),
  })
  .strip();

export type NetworkBodiesServerConfig = z.infer<typeof NetworkBodiesServerConfig>;

/**
 * F21 (round-2 review) failure posture: an out-of-ceiling `networkBodies`
 * block (e.g. `bodyByteCap: 999999999`) must NOT take down the whole
 * `GET /api/config` parse — replay + breadcrumbs are unrelated blocks and
 * must keep working — but it also must never enable capture with an
 * out-of-contract value. `.catch(undefined)` degrades ONLY this field to
 * absent on any validation failure (mirrors iOS's `NetworkBodiesConfigWire`
 * decode degrading the whole block to `nil` via its lenient `try?`, 826e5f76
 * F10): `getNetworkBodiesConfig` then falls back to
 * `NETWORK_BODIES_CONFIG_DEFAULT`, whose `captureBodies` is `false` — fail
 * closed, never fail-the-whole-parse.
 */
const NetworkBodiesServerConfigLenient = NetworkBodiesServerConfig.optional().catch(undefined);

/**
 * Companion name-badge dashboard override (plan 2026-08-25). Emitted only
 * when this SDK declared `companionbadge` in X-Everframe-SDK-Features. Nested
 * `.strip()` + `.catch(undefined)` — same posture as networkBodies: a
 * malformed BLOCK (e.g. `enabled: 'yes'`) degrades to absent (the SDK keeps
 * its inline/default badge), never fails the whole config parse.
 *
 * `position` additionally carries its OWN field-level
 * `.optional().catch(undefined)` (final-review fix, plan 2026-08-25): unlike
 * Android/iOS, which keep `position` a raw string and resolve recognition at
 * the badge, web enforces the enum at the schema. Without a per-field catch,
 * an unrecognized value (e.g. a future 5th position the server ships before
 * this SDK does) would fail the INNER object parse and degrade the WHOLE
 * block to undefined via the block-level catch below — silently dropping the
 * `enabled: false` kill-switch override along with the bad position. The
 * per-field catch confines degradation to `position` alone; `enabled` still
 * comes through.
 */
export const CompanionBadgeServerConfig = z
  .object({
    enabled: z.boolean(),
    position: z
      .enum(['bottom-right', 'bottom-left', 'top-right', 'top-left'])
      .optional()
      .catch(undefined),
  })
  .strip();
export type CompanionBadgeServerConfig = z.infer<typeof CompanionBadgeServerConfig>;

const CompanionBadgeServerConfigLenient = CompanionBadgeServerConfig.optional().catch(undefined);

/**
 * Reporter branding block (watermark + theme, spec 2026-08-25). Emitted only
 * when this SDK declared `branding` in X-Everframe-SDK-Features. Nested `.strip()` +
 * `.catch(undefined)` — same posture as companionBadge: a malformed BLOCK
 * degrades to absent (the SDK fails closed to watermarked + default-themed),
 * never fails the whole config parse.
 *
 * Every color field carries its OWN `.optional().catch(undefined)` (the
 * CompanionBadgeServerConfig `position` doctrine): a single bad hex must
 * degrade that field alone, NOT drop the whole theme — and a bad theme
 * sub-object must never take `watermark: false` (the entitlement signal)
 * down with it. 6-digit hex only, mirroring the server's emit validation:
 * these values are interpolated into a <style> element on the customer's
 * page, so the format gate is a security boundary, not a style preference.
 */
const BrandingHexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const BrandingThemeServerConfig = z
  .object({
    background: BrandingHexColor.optional().catch(undefined),
    surface: BrandingHexColor.optional().catch(undefined),
    border: BrandingHexColor.optional().catch(undefined),
    text: BrandingHexColor.optional().catch(undefined),
    textMuted: BrandingHexColor.optional().catch(undefined),
    accent: BrandingHexColor.optional().catch(undefined),
    accentForeground: BrandingHexColor.optional().catch(undefined),
    destructive: BrandingHexColor.optional().catch(undefined),
  })
  .strip();
export type BrandingThemeServerConfig = z.infer<typeof BrandingThemeServerConfig>;

export const BrandingServerConfig = z
  .object({
    watermark: z.boolean(),
    theme: BrandingThemeServerConfig.optional().catch(undefined),
  })
  .strip();
export type BrandingServerConfig = z.infer<typeof BrandingServerConfig>;

const BrandingServerConfigLenient = BrandingServerConfig.optional().catch(undefined);

/**
 * Report Resource Window (spec 2026-09-05). Emitted only when this SDK
 * declared `resources` in X-Everframe-SDK-Features — same capability-negotiation
 * doctrine as `companionBadge`/`branding` above, and for the same reason:
 * the server only emits the block to a caller that advertised the token, so
 * an SDK that forgets to declare it gets `resources.enabled` undefined
 * forever with nothing in the logs to explain why (see
 * `createWebPlatformAdapter`'s `sdkFeatures` array).
 *
 * Nested `.strip()` + `.catch(undefined)` — same posture as companionBadge/
 * branding: a malformed BLOCK (e.g. `enabled: 'yes'`) degrades to absent,
 * i.e. the feature stays OFF, never fails the whole `GET /api/config` parse
 * (replay/breadcrumbs/etc. are unrelated blocks and must keep working).
 *
 * `windowSec` carries its OWN field-level `.optional().catch(undefined)` —
 * same doctrine as `CompanionBadgeServerConfig`'s `position` — so a
 * malformed window length alone degrades only that field; `enabled` still
 * comes through and the caller falls back to `DEFAULT_RESOURCE_WINDOW_SEC`
 * (protocol) rather than losing the whole block over one bad number.
 */
export const ResourcesServerConfig = z
  .object({
    enabled: z.boolean(),
    windowSec: z.number().positive().optional().catch(undefined),
  })
  .strip();
export type ResourcesServerConfig = z.infer<typeof ResourcesServerConfig>;

const ResourcesServerConfigLenient = ResourcesServerConfig.optional().catch(undefined);

/**
 * Server-driven two-way replies config, delivered inside the existing
 * `GET /api/config` response. Emitted only when an app has `replies_enabled`
 * set server-side (default false); older/unaware SDKs must still parse the
 * rest of the response when this block is absent. This schema exists solely
 * so the unknown `replies` key does not fail-close the whole response parse
 * (CONFIG-02) — nothing in sdk-core consumes this value yet.
 */
export const RepliesConfig = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type RepliesConfig = z.infer<typeof RepliesConfig>;

/**
 * Reporter identity recognition (spec 2026-08-06), delivered inside the
 * existing `GET /api/config` response. Emitted only when the caller declared
 * `identity` in `X-Everframe-SDK-Features` (server: the ingest API/src/ingest/config-
 * route.ts `IdentityBlockSchema`) — same capability-negotiation doctrine as
 * `RepliesConfig` above, and the same reason this schema exists at all: an
 * unrecognized top-level key must never fail-close the whole response parse.
 *
 * Unlike `replies`, there is no separate per-app toggle: `enabled` means
 * exactly "this app's project has a signing secret configured". `false` (or
 * the block being absent) tells the SDK never to call the host's
 * `setIdentityToken` provider at all — a project with no secret pays nothing.
 */
export const IdentityConfig = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export type IdentityConfig = z.infer<typeof IdentityConfig>;

export interface NetworkBodiesConfig {
  captureBodies: boolean;
  bodyByteCap: number;
  bodyContentTypes: string[];
  bodyTotalBudget: number;
}

/** SDK fallback defaults — used when the server omits a field (spec §4.1). */
export const NETWORK_BODIES_CONFIG_DEFAULT: NetworkBodiesConfig = Object.freeze({
  captureBodies: false,
  bodyByteCap: 8192,
  bodyContentTypes: ['application/json', 'text/*'],
  bodyTotalBudget: 262144,
});

/**
 * Zod schema for the `GET /api/config` response. All three fields are required.
 * `samplingRate` is bounded to [0,1] to match the server's enforced contract
 * (config-route.ts `ReplayConfigResponseSchema`) — an out-of-range value fails
 * the existing `safeParse` below and the cache stays at its current value (fail
 * closed), so a drifted/hostile rate can never feed the `random() < samplingRate`
 * gate (CONFIG-02 / CR-04-C).
 */
export const ReplayConfigResponse = z.object({
  replayEnabled: z.boolean(),
  replayDurationSec: z.number(),
  samplingRate: z.number().min(0).max(1),
  breadcrumbs: BreadcrumbsConfig.optional(),
  networkBodies: NetworkBodiesServerConfigLenient,
  replies: RepliesConfig.optional(),
  identity: IdentityConfig.optional(),
  companionBadge: CompanionBadgeServerConfigLenient,
  branding: BrandingServerConfigLenient,
  // Session Vitals (spec 2026-09-01). Flat top-level fields, matching
  // replayEnabled/samplingRate's shape rather than a nested block — the
  // server (Task 11, the server configuration contract) emits both
  // unconditionally, no capability negotiation. Declared here (Task 8) AHEAD
  // of Task 11's server emission so the two land in either order: the web
  // adapter's `applyLiveConfig` (adapter.ts) is per-field lenient on absence
  // regardless, but a `.strict()` schema that did NOT know these keys would
  // fail-parse the ENTIRE response the day the server starts sending them —
  // taking replay/breadcrumbs/etc. down with it, not just vitals. `.catch(
  // undefined)` on each, independently, so a malformed value degrades only
  // that field rather than the whole response (same doctrine as
  // BrandingHexColor above).
  vitalsEnabled: z.boolean().optional().catch(undefined),
  vitalsSampleRate: z.number().min(0).max(1).optional().catch(undefined),
  // Report Resource Window (spec 2026-09-05). Nested block (unlike vitals'
  // flat fields above) — negotiated via `resources` in X-Everframe-SDK-Features,
  // see ResourcesServerConfig's own header for the degrade-to-absent
  // posture this field shares with companionBadge/branding.
  resources: ResourcesServerConfigLenient,
  reportHotkey: z
    .object({ binding: z.string().trim().min(1).max(100) })
    .strict()
    .optional()
    .catch(undefined),
}).strict();

export type ReplayConfig = z.infer<typeof ReplayConfigResponse>;

/**
 * The canonical OFF default. This is the value `get()` returns until the first
 * fully Zod-validated 200 resolves — and it is never weakened by any error path.
 */
export const REPLAY_CONFIG_OFF: ReplayConfig = Object.freeze({
  replayEnabled: false,
  replayDurationSec: 30,
  samplingRate: 1.0,
});

/** Dashboard default used until the first config response resolves. */
export const DEFAULT_REPORT_HOTKEY_BINDING = 'Mod+Shift+B';

/** 5-minute TTL (RESEARCH). */
export const DEFAULT_CONFIG_TTL_MS = 300_000;
export const SDK_FEATURES_HEADER = 'X-Everframe-SDK-Features';

export interface ConfigProviderDeps {
  /** Injectable `fetch` so specs drive every error path deterministically (no real network). */
  fetchImpl: typeof fetch;
  /** Fully-qualified `GET /api/config` URL. */
  configUrl: string;
  /** Per-app SDK key — sent as `Authorization: Bearer <apiKey>` like the ingest path. */
  apiKey: string;
  /** Cache TTL in ms. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Injectable clock (ms). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Feature tokens for the X-Everframe-SDK-Features header (server sdk-features.ts).
   * The server emits feature-gated config blocks (e.g. `replies`,
   * `networkbodies` — spec 2026-08-01 §4.3) only when the request advertises
   * support — absence of a token must never error. Multiple tokens are sent
   * as a single comma-separated header value (server's `parseSdkFeatures`
   * lowercases and splits on commas), so a caller that wants BOTH blocks
   * passes both tokens here — see WebPlatformAdapter's
   * `createConfigProvider({ sdkFeatures: [...] })` call.
   */
  sdkFeatures?: readonly string[];
  /**
   * MAI meter (spec 2026-08-27, Counting architecture). Resolved on EVERY
   * fetch and appended as `?installId=<value>` when it yields one.
   *
   * Per-fetch, not per-provider, on purpose: Plan 2a baked the identifier into
   * `configUrl` at adapter construction, so the same value rode every
   * five-minute refetch for the adapter's whole lifetime and no per-day gate
   * could exist behind it. Returning `null` means "send the URL unchanged" and
   * is never an error; a throw is swallowed for the same reason. This read is
   * the SDK's remote kill switch — an uncounted install is cosmetic, a config
   * fetch that never fires is not.
   */
  installIdProvider?: () => string | null;
}

export interface ConfigProviderRefreshOptions {
  /**
   * Bypass the TTL gate for this call (finding 1 — a deliberate wake/new-thread
   * signal must be able to re-resolve the gate rather than idling on a stale
   * cached value for up to the full TTL window). Default behavior (omitted /
   * false) is byte-identical to the pre-existing TTL-gated refresh().
   */
  force?: boolean;
}

export interface ConfigProvider {
  /** Returns the in-memory cache. OFF until the first validated success — never throws. */
  get(): ReplayConfig;
  /**
   * Fetches `GET /api/config`, Zod-parses, and overwrites the cache ONLY on full
   * validation. Any error path keeps the cache at its current value and resolves
   * silently (fail closed). A no-op within the TTL window, UNLESS `opts.force`
   * is set.
   *
   * F18 (round-4 review) — `opts.force` bypasses the TTL gate entirely, so a
   * periodic re-read loop that already sleeps exactly one TTL between calls
   * (mirroring iOS's `ReplaySession.refreshConfigNow()`, `ac39a9c9` F4) gets a
   * real fetch on every tick instead of racing its own TTL and silently
   * halving the effective poll rate. The same `force` flag is also what the
   * two-way-replies thread client's `refreshGate` uses to re-resolve this
   * SAME provider instance on a deliberate wake() rather than idling on a
   * stale cache for up to the full TTL window.
   *
   * Returns whether THIS call's fetch was attempted and fully validated
   * (`true`) or hit any failure path — network error, non-200, malformed
   * body, Zod-fail, timeout (`false`). A non-forced call that short-circuits
   * on the TTL no-op also returns `true` (the cache is still considered
   * fresh — no read was needed). Callers that must fail additional state
   * closed on a failed READ specifically (not merely "cache still OFF") —
   * e.g. the web adapter's periodic network-body gate, mirroring iOS's
   * `refreshConfigNow()` failing the body gate closed on a failed fetch
   * rather than blindly continuing off a stale last-good cache — read this
   * return value; `get()`'s cache itself keeps its ordinary last-good
   * semantics regardless (breadcrumb/replay config are unaffected by a
   * failed read here, same as before this flag existed).
   *
   * F32 (round-7 review) — TWO calls can legitimately be in flight at once
   * (the periodic loop's `setInterval` does not await the previous tick, and
   * its per-fetch timeout equals the interval). Only the LATEST-STARTED
   * call may ever commit to the cache; an older-started call that resolves
   * later returns `false` here even on a fully-validated 200, so it is never
   * mistaken for a fresh success by a caller like the body-gate flag above.
   */
  refresh(opts?: ConfigProviderRefreshOptions): Promise<boolean>;
}

/**
 * `configUrl` plus `?installId=<value>` when the supplier yields one. Any
 * failure — absent supplier, null, empty, a throw, or a URL that will not
 * parse — yields the unmodified `configUrl`. Built through `URL` rather than
 * string concatenation so a value needing encoding cannot produce a malformed
 * request, and so an already-parameterised `configUrl` keeps its parameters.
 */
function withInstallId(configUrl: string, provider?: () => string | null): string {
  if (!provider) return configUrl;
  try {
    const id = provider();
    if (!id) return configUrl;
    const url = new URL(configUrl);
    url.searchParams.set('installId', id);
    return url.toString();
  } catch {
    return configUrl;
  }
}

/**
 * Create a fail-closed session-replay config provider.
 *
 * Failure semantics (Pitfall 7): a never-succeeded provider stays OFF; a transient
 * error after a good resolution retains the last-good value (an error never flips
 * ON→OFF mid-session — only a validated response can change state).
 */
export function createConfigProvider(deps: ConfigProviderDeps): ConfigProvider {
  const { fetchImpl, configUrl, apiKey } = deps;
  const ttlMs = deps.ttlMs ?? DEFAULT_CONFIG_TTL_MS;
  const now = deps.now ?? Date.now;

  // Start OFF. Clone so callers can never mutate the frozen default.
  let cache: ReplayConfig = { ...REPLAY_CONFIG_OFF };
  let lastFetchedAt: number | null = null;

  // Finding 3 (round 6, PR review) — sdk-react's wake() issues a FORCED
  // refresh() on every visibility return, so two calls can now overlap
  // in-flight (e.g. two quick tab-switches; also the two-way-replies thread
  // client's own force:true refreshGate racing the periodic body-config
  // loop below). Without a guard, whichever response *completes* last wins
  // the cache write, even if it was the *older* request — an
  // out-of-order-completing stale response could silently undo a newer
  // config gate flip.
  //
  // F32 (round-7 review, P1) — the periodic re-read loop (adapter.ts) fires
  // `setInterval` ticks without awaiting the previous tick's `refresh()`, and
  // each tick's fetch is bounded by an `AbortSignal.timeout(ttlMs)` equal to
  // the interval itself — so a new tick can start before the previous tick's
  // request has aborted, putting two `refresh()` calls in flight at once.
  // Without ordering, the cache used to commit in COMPLETION order: an OLDER
  // request (e.g. the last-good `captureBodies:true`) resolving AFTER a
  // NEWER request (e.g. a just-flipped `captureBodies:false` kill switch)
  // would silently overwrite the newer, correct result — undoing a remote
  // privacy kill switch.
  //
  // Fixed with a monotonically increasing request-sequence number assigned
  // synchronously when a real fetch attempt BEGINS (not on a TTL no-op,
  // which never touches the network). `latestStartedSeq` always holds the
  // highest sequence number among all attempts started so far. A response
  // may commit to the cache ONLY if no newer request has begun since this
  // one started — i.e. only the LATEST-STARTED request can ever win,
  // regardless of completion order. A superseded response returns `false`
  // rather than `true`, so it is never reported as a fresh success that
  // could re-arm anything (e.g. the web adapter's `bodyGateFailedClosed`).
  let requestSeq = 0;
  let latestStartedSeq = 0;

  return {
    get(): ReplayConfig {
      return cache;
    },

    async refresh(opts?: ConfigProviderRefreshOptions): Promise<boolean> {
      // No-op within the TTL window once we have fetched at least once —
      // UNLESS force bypasses it (F18: the periodic loop always forces; the
      // two-way-replies thread client's refreshGate also always forces).
      if (!opts?.force && lastFetchedAt !== null && now() - lastFetchedAt < ttlMs) {
        __traceReplay('config.refresh', { ok: true, reason: 'ttl_fresh' });
        return true; // cache still fresh; no read was needed, not a failure.
      }
      // F32: stamp this attempt with the next sequence number BEFORE the
      // first await below, so "which request started last" is determined by
      // call order, not by however the fetch happens to interleave/resolve.
      const mySeq = ++requestSeq;
      latestStartedSeq = mySeq;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        };
        if (deps.sdkFeatures && deps.sdkFeatures.length > 0) {
          headers[SDK_FEATURES_HEADER] = deps.sdkFeatures.join(', ');
        }
        // Bound the fetch so a hung request cannot wedge the provider.
        // timeoutSignal, NOT bare AbortSignal.timeout — the static is
        // Chrome 103+ and its absence on Smart-TV webviews threw here
        // synchronously, fail-closing every refresh before the network.
        // boundWait backstops engines with NO abort primitive at all
        // (timeoutSignal null): the wait is bounded even when the request
        // itself cannot be cancelled.
        const res = await boundWait(
          fetchImpl(withInstallId(configUrl, deps.installIdProvider), {
            method: 'GET',
            headers,
            signal: timeoutSignal(ttlMs),
          }),
          ttlMs,
        );
        // Non-200 ⇒ fail closed (keep current cache).
        if (!res.ok) {
          __traceReplay('config.refresh', { ok: false, reason: 'http_error', status: res.status });
          return false;
        }
        // Malformed JSON throws here ⇒ caught below ⇒ fail closed. Bounded
        // like the fetch itself (codex round-3 finding 3): fetch settles at
        // response HEADERS, so a stalled body would otherwise hang here on
        // engines whose signal cannot abort the read.
        const body: unknown = await boundWait(res.json(), ttlMs);
        const parsed = ReplayConfigResponse.safeParse(body);
        // Missing/wrong-typed field ⇒ Zod fail ⇒ fail closed.
        if (!parsed.success) {
          // Thunked: a malformed response can carry a great many issues, and
          // the map would otherwise run on every failed read in a shipped
          // build. Field PATHS only — an issue's `received` echoes response
          // content — and capped, since the first few identify the drift.
          __traceReplay('config.refresh', () => ({
            ok: false,
            reason: 'invalid',
            issues: parsed.error.issues.length,
            paths: parsed.error.issues.slice(0, 10).map((i) => i.path.join('.')),
          }));
          return false;
        }
        // F32: an older-started request must never overwrite a newer one,
        // even if it resolves after the newer one already started (or even
        // already committed). Discard silently — this is exactly the same
        // "fail closed on THIS read" posture as any other failure path
        // below, from the caller's point of view.
        if (mySeq !== latestStartedSeq) {
          __traceReplay('config.refresh', { ok: false, reason: 'superseded' });
          return false;
        }
        // The ONLY path that mutates the cache: a fully validated 200 from
        // the MOST RECENTLY STARTED refresh (the mySeq/latestStartedSeq
        // check above already guarantees that).
        cache = parsed.data;
        __traceReplay('config.refresh', {
          ok: true,
          reason: 'ok',
          replayEnabled: cache.replayEnabled,
          samplingRate: cache.samplingRate,
        });
        return true;
      } catch (err) {
        // network rejection / timeout (AbortError) / malformed body ⇒ fail closed silently.
        // cache stays at its current value (last-good or OFF). Never re-throw.
        // Error NAME only — a message can carry the URL, and with it the key.
        __traceReplay('config.refresh', {
          ok: false,
          reason: 'threw',
          error: err instanceof Error ? err.name : typeof err,
        });
        return false;
      } finally {
        // Mark the attempt so TTL/backoff windowing advances even on failure.
        lastFetchedAt = now();
      }
    },
  };
}

/** Effective breadcrumbs config: the server block when present, else defaults. */
export function getBreadcrumbsConfig(cfg: ReplayConfig): BreadcrumbsConfig {
  return cfg.breadcrumbs ?? BREADCRUMBS_CONFIG_DEFAULT;
}

/**
 * Replies gate. The server omits the block entirely when the app has replies
 * off OR the request did not advertise the feature — absence means OFF.
 */
export function isRepliesEnabled(config: ReplayConfig): boolean {
  return config.replies?.enabled === true;
}

/**
 * Identity gate. Absence of the block (old server, feature not negotiated, or
 * the project has no signing secret configured) means OFF — the caller must
 * never invoke the host's `setIdentityToken` provider in that case (spec
 * 2026-08-06's "an SDK in a project with no secret never calls the host's
 * provider").
 */
export function isIdentityEnabled(config: ReplayConfig): boolean {
  return config.identity?.enabled === true;
}

/** Effective body config: server fields when present, else SDK defaults. */
export function getNetworkBodiesConfig(cfg: ReplayConfig): NetworkBodiesConfig {
  const s = cfg.networkBodies;
  if (!s) return NETWORK_BODIES_CONFIG_DEFAULT;
  return {
    captureBodies: s.captureBodies,
    bodyByteCap: s.bodyByteCap ?? NETWORK_BODIES_CONFIG_DEFAULT.bodyByteCap,
    bodyContentTypes: s.bodyContentTypes ?? NETWORK_BODIES_CONFIG_DEFAULT.bodyContentTypes,
    bodyTotalBudget: s.bodyTotalBudget ?? NETWORK_BODIES_CONFIG_DEFAULT.bodyTotalBudget,
  };
}

/**
 * The raw server badge block, or undefined when unset/malformed/not
 * negotiated. Deliberately NOT overlaid with defaults here — precedence is
 * per-field at the badge (server field → inline option → default), so the
 * caller must be able to tell "absent" from "explicitly configured".
 */
export function getCompanionBadgeServerConfig(
  cfg: ReplayConfig,
): CompanionBadgeServerConfig | undefined {
  return cfg.companionBadge;
}

/**
 * The raw server branding block, or undefined when unset/malformed/not
 * negotiated. NOT overlaid with defaults — absence is itself the signal
 * (fail closed to watermarked, no theme). Precedence for theme values is
 * per-field at the widget (server → inline option → default), so the caller
 * must be able to tell "absent" from "explicitly configured".
 */
export function getBrandingServerConfig(cfg: ReplayConfig): BrandingServerConfig | undefined {
  return cfg.branding;
}

/**
 * The raw server resources block, or undefined when unset/malformed/not
 * negotiated. NOT overlaid with a `windowSec` default here — absence of the
 * whole block IS "feature off" (fail closed), and the caller (adapter.ts)
 * is the one that knows `DEFAULT_RESOURCE_WINDOW_SEC` (protocol) to fall
 * back to when `enabled` is true but `windowSec` itself degraded.
 */
export function getResourcesServerConfig(cfg: ReplayConfig): ResourcesServerConfig | undefined {
  return cfg.resources;
}

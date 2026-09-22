// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Singleton wrapper around createCompanion + createRelayWSClient that
// mirrors the RN SDK surface (packages/sdk-react-native/src/companion.ts):
//
//   • companion.start(opts?)   — open the relay WS (idempotent).
//   • companion.stop()         — close the WS; state retained.
//
// Framework-free on purpose: this module is reachable from
// `@traceitx/web`'s always-loaded entry, so nothing here may import react.
// The matching `companion.useCompanion()` React hook lives in
// `@traceitx/react` (src/companion/use-companion.ts) and reads this
// module's singleton through the `__getCompanionApi()` seam below.
//
// Hosts that need multiple companion instances or custom capture wiring
// keep using `createCompanion()` + `createRelayWSClient(...)` directly.
'use client';

import { createCompanion, type CompanionAPI } from './state.js';
import {
  createRelayWSClient,
  type RelayWSClient,
  type ReportSubmit,
} from './ws-client.js';
import {
  handleReportRequest,
  handleCompanionReportRequest,
  handleCompanionSubmitText,
  handleCompanionSubmitBinary,
  handleCompanionReportCancelled,
  type ReportCounts,
} from './capture-bridge.js';
import { __companionSeamTicket, __getCompanionHost } from './host-seam.js';
import { resolveCompanionDeviceId } from './device-id.js';
import { deriveDeviceFacts } from './device-facts.js';
import type { AnnounceDeviceBlock } from './announce.js';
import { __getCompanionBadgeServerConfig } from './server-config.js';

/**
 * Controls how a live attach-PIN challenge (spec 2026-08-19) is surfaced:
 *
 * - `'builtin'` (default) — the SDK's own `CompanionPinCard` renders the
 *   code unconditionally (mounted by `TraceItXProvider`). A host with no
 *   builtin surface declares that through
 *   `__setBuiltinPinSurfaceAvailable(false)` — `@traceitx/web`'s `init()`
 *   does, since the vanilla mount does not render `CompanionPinCard` — and
 *   `start()` then resolves `'builtin'` down to `'off'` and warns once
 *   instead of announcing a capability nothing can honour. See
 *   `__setBuiltinPinSurfaceAvailable` for the residual gap.
 * - `'custom'` — the SDK announces PIN support to the relay (so the
 *   dashboard offers the attach flow) but renders nothing itself; the host
 *   is expected to read `useCompanion().attachChallenge` and build its own
 *   surface.
 * - `'off'` — the device does not announce PIN support at all; the relay's
 *   dashboard falls back to legacy one-click attach for this device.
 *
 * FAIL-CLOSED WARNING: choosing `'custom'` without actually rendering a UI
 * off `attachChallenge` is strictly worse than `'off'` — the relay believes
 * this device can show a PIN, a dashboard member requests attach, and the
 * challenge simply expires with nothing ever shown, wasting the attempt
 * budget and the member's TTL window. If a host can't commit to rendering
 * the challenge, leave this at `'off'`, not `'custom'`.
 */
export type AttachPinUiMode = 'builtin' | 'custom' | 'off';

export type BadgePosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/**
 * On-device name badge shown while a companion session is attached (naming
 * spec 2026-08-24 §4). Default ON — zero-setup recognition is the point; a
 * production host that finds it intrusive disables it in one line.
 * IDENTIFICATION ONLY: this is NOT the removed fail-closed sharing indicator
 * (2026-08-13) and must never be cited as a privacy mitigation.
 * First-start()-wins, same contract as `attachPinUi`.
 *
 * NOT AVAILABLE ON `@traceitx/web` (codex round-2 finding 5). The badge is an
 * AMBIENT surface — it has to be on screen while the reporter is CLOSED — and
 * the vanilla mount's only ambient element is the FAB (plain DOM, so React
 * stays out of the always-loaded bundle). `CompanionBadge` is a React
 * component behind the lazy island, which by construction is not mounted at
 * the time this badge would need to show. `init()` therefore declares no badge
 * surface (`__setBuiltinBadgeSurfaceAvailable(false)`) and this option
 * resolves to OFF there, exactly as `attachPinUi: 'builtin'` resolves to
 * `'off'` on the same host — announcing a surface nothing can render is the
 * failure mode both of these exist to avoid. See the README.
 */
export interface CompanionBadgeOptions {
  enabled?: boolean;
  position?: BadgePosition;
}

export interface CompanionStartOptions {
  /** @internal Test/dev override; production omits and uses the build-baked URL. */
  endpoint?: string;
  /**
   * SDK key to announce this device to `/api/companion/announce` (spec
   * 2026-08-07) before each connect attempt, so it appears in the
   * dashboard's Companion device list with `useCompanion().code` shown
   * beside the QR. Omit to skip announce entirely — the device connects to
   * plain `/relay/tv` exactly as it did before this feature existed; QR
   * pairing and reporting are wholly unaffected either way.
   */
  sdkKey?: string;
  /** Optional human label sent with the announce (e.g. "Lobby TV"); length-capped server-side. */
  deviceLabel?: string;
  /**
   * How a live attach-PIN challenge is surfaced. Defaults to `'builtin'` —
   * see `AttachPinUiMode` for the full contract and its fail-closed warning.
   */
  attachPinUi?: AttachPinUiMode;
  /**
   * Counts the SDK ships in the assembled frame. Defaults to zeros — hosts
   * that have a real log/network buffer can pass live counts.
   */
  counts?: ReportCounts;
  /**
   * Full override for the `report.request` handler. When supplied, replaces
   * the default `handleReportRequest(...)` call entirely. The active WS
   * client is passed so the host can `send` / `sendBinary` directly.
   */
  onReportRequest?: (correlationId: string, ws: RelayWSClient) => void;
  /**
   * Full override for the `report.submit` handler. Defaults to the SDK's
   * passive observer (`handleReportSubmit`).
   */
  onReportSubmit?: (msg: ReportSubmit) => void;
  /**
   * Stable device identity override (naming spec 2026-08-24 §1). A host with
   * its own device identity (MDM id, provisioning serial, Vidaa/STB API)
   * passes it here; otherwise the SDK derives one (Tizen DUID → webOS LGUDID
   * → persisted localStorage UUID). Hashed on-device before it leaves.
   * The id is resolved once per page load (first-call-wins memo), so a
   * later `stop()`/`start()` with a different `companionDeviceId` does NOT
   * re-resolve — only a page reload does.
   */
  companionDeviceId?: string | (() => string | Promise<string>);
  companionBadge?: CompanionBadgeOptions;
}

let _api: CompanionAPI | null = null;
let _ws: RelayWSClient | null = null;
let _attachPinUiMode: AttachPinUiMode = 'builtin';
let _badgeConfig: { enabled: boolean; position: BadgePosition } = {
  enabled: true, position: 'bottom-right',
};

/**
 * Does the host WANT a session right now? Distinct from `CompanionState`,
 * which reports what the relay is doing. The two were conflated before, and
 * `useCompanion`'s docstring had to warn that "a stopped session must be
 * rendered from your own flag" — so every host wrote this, and the SDK's own
 * sample taught them to. It belongs here.
 */
let _running = false;
const _runningHandlers = new Set<(running: boolean) => void>();

function setRunning(next: boolean): void {
  if (_running === next) return;
  _running = next;
  for (const h of _runningHandlers) h(next);
}

export function __getCompanionRunning(): boolean {
  return _running;
}

export function __onCompanionRunning(handler: (running: boolean) => void): () => void {
  _runningHandlers.add(handler);
  return () => {
    _runningHandlers.delete(handler);
  };
}

function ensureApi(): CompanionAPI {
  if (_api === null) _api = createCompanion();
  return _api;
}

/** Test/CompanionPinCard seam — `ensureApi` itself stays private. */
export function __getCompanionApi(): CompanionAPI {
  return ensureApi();
}

/** `CompanionPinCard` seam — see `AttachPinUiMode`. */
export function __getAttachPinUiMode(): AttachPinUiMode {
  return _attachPinUiMode;
}

/**
 * Whether THIS host can render the builtin `CompanionPinCard`.
 *
 * Defaults to `true` so `@traceitx/react` is untouched: `TraceItXProvider`
 * mounts the card unconditionally, so `'builtin'` is an honest promise there
 * and must keep announcing. `@traceitx/web`'s `init()` sets it `false` — the
 * vanilla mount renders the FAB, the reporter dialog, the inbox and a toast,
 * and nothing else — and restores it on `destroy()`.
 */
let _builtinPinSurface = true;

/**
 * Declare whether this host renders the builtin `CompanionPinCard`.
 *
 * RESIDUAL GAP, deliberately not closed here: a page that calls
 * `companion.start()` without EITHER mounting `TraceItXProvider` or calling
 * `init()` — a companion-only smart-TV build, say — still defaults to `true`
 * and still announces. Closing that needs a POSITIVE signal from the React
 * side, which means either editing `@traceitx/react` or registering from
 * `CompanionPinCard`'s render (ordering-fragile: a host child's `useEffect`
 * runs before a sibling card's, so a `start()` from host code would race the
 * registration). Flipping this default to `false` instead would reach the
 * Provider, which is exactly what must not happen. That host should pass
 * `attachPinUi: 'off'` explicitly.
 */
export function __setBuiltinPinSurfaceAvailable(available: boolean): void {
  _builtinPinSurface = available;
}

/**
 * Whether THIS host can render the builtin `CompanionBadge` — the exact
 * counterpart of `_builtinPinSurface` above, for the ambient name badge
 * (codex round-2 finding 5).
 *
 * Defaults to `true` so `@traceitx/react` is untouched: `TraceItXProvider`
 * renders `CompanionBadge` unconditionally. `@traceitx/web`'s `init()` sets it
 * `false` and restores it on `destroy()`.
 *
 * A SECOND flag rather than one shared "no builtin companion surfaces" switch:
 * the two answers are independent in principle (a host may well render one and
 * not the other), and collapsing them would make a future host's honest
 * declaration impossible to express.
 */
let _builtinBadgeSurface = true;

/** Declare whether this host renders the builtin `CompanionBadge`. */
export function __setBuiltinBadgeSurfaceAvailable(available: boolean): void {
  _builtinBadgeSurface = available;
}

/**
 * Start-option defaults registered by a host that already declared them once.
 * `@traceitx/react`'s provider registers `apiKey` / `appName` here on mount,
 * so `companion.start()` matches the RN SDK's zero-argument call instead of
 * making the host repeat a key the provider is already holding.
 *
 * Framework-free hosts using `@traceitx/web` directly register nothing and
 * are wholly unaffected — there is no provider to read, which is exactly why
 * `start()` required the argument in the first place.
 */
let _companionDefaults: { sdkKey?: string; deviceLabel?: string } | null = null;

export function __setCompanionDefaults(
  defaults: { sdkKey?: string; deviceLabel?: string } | null,
): void {
  _companionDefaults = defaults;
}

/**
 * Explicit option → registered default → absent, resolved per field so a host
 * can override one without discarding the other.
 */
function resolveStartOptions(opts: CompanionStartOptions): CompanionStartOptions {
  if (_companionDefaults === null) return opts;
  const resolved: CompanionStartOptions = { ...opts };
  if (resolved.sdkKey === undefined && _companionDefaults.sdkKey !== undefined) {
    resolved.sdkKey = _companionDefaults.sdkKey;
  }
  if (resolved.deviceLabel === undefined && _companionDefaults.deviceLabel !== undefined) {
    resolved.deviceLabel = _companionDefaults.deviceLabel;
  }
  return resolved;
}

/** @internal Test seam for the resolution table above. */
export function __resolveCompanionStartOptionsForTests(
  opts: CompanionStartOptions,
): CompanionStartOptions {
  return resolveStartOptions(opts);
}

/** One warning per page load, not one per `start()`. */
let _warnedNoPinSurface = false;
/** Same, for the badge. */
let _warnedNoBadgeSurface = false;

/**
 * Test seam — module state outlives a spec file, so a suite that asserts the
 * warning fires ONCE needs the counter back. Same shape and purpose as
 * `__resetDeviceIdForTests`; not exported from the package barrel.
 */
export function __resetPinSurfaceStateForTests(): void {
  _builtinPinSurface = true;
  _warnedNoPinSurface = false;
  _builtinBadgeSurface = true;
  _warnedNoBadgeSurface = false;
}

/**
 * `CompanionBadge` seam — the EFFECTIVE config: dashboard value when the
 * server block is set (per-field) → the inline option captured at start()
 * → default. See companion/server-config.ts for how the server block
 * arrives (plan 2026-08-25).
 */
export function __getCompanionBadgeConfig(): { enabled: boolean; position: BadgePosition } {
  const server = __getCompanionBadgeServerConfig();
  return {
    // Codex round-2 finding 5 — resolved to OFF on a host that declared no
    // badge surface, and resolved HERE rather than in `start()` so the
    // DASHBOARD override is covered too: a server block that turns the badge
    // on cannot conjure a renderer into a vanilla mount either, and this is
    // the single point every consumer of the effective config reads.
    enabled: _builtinBadgeSurface ? (server?.enabled ?? _badgeConfig.enabled) : false,
    position: server?.position ?? _badgeConfig.position,
  };
}

/**
 * Open the relay WS. Idempotent — calling `start()` while already started
 * is a no-op (matches RN's "one client per process" semantics).
 *
 * `attachPinUi` is only applied by a call that actually creates the client —
 * a repeat `start()` on an already-live socket is a pure no-op, INCLUDING
 * the mode: `supportsAttachPin` was already announced for the session under
 * the mode chosen at the FIRST `start()`, so re-assigning `_attachPinUiMode`
 * here would silently diverge local UI mode from what the relay believes
 * this device supports. To change the mode, call `stop()` then `start()`
 * again with the new `attachPinUi`.
 */
export function start(opts: CompanionStartOptions = {}): void {
  setRunning(true);
  if (_ws !== null) return;
  const resolved = resolveStartOptions(opts);
  const requestedPinUi = resolved.attachPinUi ?? 'builtin';
  // FAIL CLOSED. Announcing `supportsAttachPin` with nothing able to render
  // the code is strictly worse than never announcing: the dashboard offers
  // attach, a member spends an attempt from the budget, and the challenge
  // expires having shown nobody anything. Only the DEFAULT is downgraded — an
  // explicit `'custom'` means the host took responsibility for rendering, and
  // an explicit `'off'` promised nothing in the first place, so neither is
  // touched and neither is lectured.
  const noSurfaceForBuiltin = requestedPinUi === 'builtin' && !_builtinPinSurface;
  if (noSurfaceForBuiltin && !_warnedNoPinSurface) {
    _warnedNoPinSurface = true;
    console.warn(
      '[TraceItX] companion.start(): attachPinUi is "builtin", but this host has no ' +
        'built-in PIN surface (CompanionPinCard is mounted only by @traceitx/react\'s ' +
        'TraceItXProvider). Attach-PIN support will NOT be announced, so the dashboard ' +
        'falls back to one-click attach. To support it, pass attachPinUi: \'custom\' and ' +
        'render the challenge yourself from __getCompanionApi().onAttachChallenge() ' +
        '(import it as a top-level export from \'@traceitx/web\'), ' +
        'or pass attachPinUi: \'off\' to silence this.',
    );
  }
  _attachPinUiMode = noSurfaceForBuiltin ? 'off' : requestedPinUi;
  _badgeConfig = {
    enabled: resolved.companionBadge?.enabled ?? true,
    position: resolved.companionBadge?.position ?? 'bottom-right',
  };
  // Codex round-2 finding 5 — same honesty as the attach-PIN downgrade above,
  // with one deliberate difference: this warns only when the host EXPLICITLY
  // passed `companionBadge`, not on the default. The PIN default is loud
  // because `'builtin'` ANNOUNCES a capability to the relay and costs a real
  // dashboard member a real attach attempt; the badge is local decoration with
  // no off-device consequence, so lecturing every vanilla `companion.start()`
  // about a surface they never asked for would be noise. A host that did
  // configure it is told, once, that the setting has no effect here.
  if (resolved.companionBadge !== undefined && !_builtinBadgeSurface && !_warnedNoBadgeSurface) {
    _warnedNoBadgeSurface = true;
    console.warn(
      '[TraceItX] companion.start(): companionBadge was configured, but this host has no ' +
        'built-in badge surface (CompanionBadge is rendered only by @traceitx/react\'s ' +
        'TraceItXProvider — it is an ambient surface, and the vanilla mount\'s only ambient ' +
        'element is the FAB). The badge will NOT be shown. Render your own from ' +
        '__getCompanionApi().onAttachedUserName() + .onResolvedName() if you need it.',
    );
  }
  const api = ensureApi();
  const counts: ReportCounts = resolved.counts ?? { logs: 0, network: 0, uiTreeNodes: 0 };
  // Codex round-5 finding 3 (P2) — WHEN this session opened, as the seam saw
  // it. The standalone `report.request` fallback is judged against this, so
  // "my host was torn down out from under me" (round 4 — still refused) is
  // told apart from "I was started AFTER that teardown", which is a deliberate
  // companion-only session and the supported use of this very function. A
  // page-global teardown flag could not tell those apart and left
  // `stop()`/`start()` refusing every report until reload — on the published
  // React package too, which re-exports this singleton.
  //
  // Taken per `start()`, not per message: a repeat `start()` on a live socket
  // is a no-op (see the doc above), so a session cannot launder its own
  // teardown by re-calling it.
  const sessionTicket = __companionSeamTicket();

  // `onReportRequest` is invoked with just the correlationId, but the
  // default handler needs the WS client to send frames. We capture it via
  // the outer binding — assigned immediately after construction below.
  const userOnRequest = resolved.onReportRequest;
  // When the host wires its own submit handler we leave the full submit flow
  // (and its baked-binary pairing) to them; otherwise the SDK owns the
  // request→submit→ingest→completed handshake via the companion host seam.
  const useDefaultSubmit = resolved.onReportSubmit === undefined;
  const client: RelayWSClient = createRelayWSClient({
    companion: api,
    ...(resolved.endpoint !== undefined ? { endpoint: resolved.endpoint } : {}),
    ...(resolved.sdkKey !== undefined ? { sdkKey: resolved.sdkKey } : {}),
    ...(resolved.deviceLabel !== undefined ? { deviceLabel: resolved.deviceLabel } : {}),
    // 'builtin' and 'custom' both promise a rendered PIN somewhere; 'off'
    // reverts the device to legacy one-click attach. See `AttachPinUiMode`.
    supportsAttachPin: _attachPinUiMode !== 'off',
    onReportRequest: (correlationId) => {
      if (userOnRequest) {
        userOnRequest(correlationId, client);
        return;
      }
      // Prefer SDK-owned full capture (so the matching submit can build a real
      // envelope). Falls back to screenshot-only when no Provider is mounted.
      const host = __getCompanionHost();
      if (host) {
        void handleCompanionReportRequest(correlationId, client, host);
      } else {
        void handleReportRequest(correlationId, client, counts, sessionTicket);
      }
    },
    onReportSubmit:
      resolved.onReportSubmit ??
      ((msg) => handleCompanionSubmitText(msg, client, __getCompanionHost(), api)),
    onReportCancelled: (correlationId) =>
      handleCompanionReportCancelled(__getCompanionHost(), correlationId),
    deviceProvider: async (): Promise<AnnounceDeviceBlock | null> => {
      const id = await resolveCompanionDeviceId(
        resolved.companionDeviceId !== undefined ? { explicit: resolved.companionDeviceId } : {},
      );
      if (id === null) return null;
      return { id, ...deriveDeviceFacts(navigator.userAgent) };
    },
    ...(useDefaultSubmit
      ? {
          onBinary: (bytes: ArrayBuffer) =>
            handleCompanionSubmitBinary(bytes, client, __getCompanionHost(), api),
        }
      : {}),
  });
  _ws = client;
  _ws.start();
}

/**
 * Close the relay WS. The observable state retains its last value so hosts
 * can still render a paused indicator from `useCompanion()` afterwards.
 */
export function stop(): void {
  setRunning(false);
  if (_ws === null) return;
  _ws.stop();
  _ws = null;
  // A stopped client has no live attach — the badge must not survive a
  // manual stop(). Other companion state (resolvedName, code, pairUrl) is
  // deliberately retained per this function's doc above.
  ensureApi().__setAttachedUserName(null);
}

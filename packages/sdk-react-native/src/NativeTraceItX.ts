// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TurboModule codegen spec — D-05 locked surface (Phase 06 / RESEARCH §1.1).
//
// RULES OF THE BRIDGE (Phase 6, do NOT relax without a new D-decision):
// - Only flat, primitive-typed objects can be expressed here.
// - `T | null` is forbidden — use `?` optional (RESEARCH §1.4).
// - Recursive nested shapes (UITree, Envelope) MUST be typed as `UnsafeObject`;
//   the JS facade in `./index.ts` re-asserts richer types via `as` casts.
//   This is the documented escape hatch for facebook/react-native#36467 + #47113.
//   (Bare `object` keyword is rejected by RN codegen as TSObjectKeyword —
//   `UnsafeObject` is the opaque-object name React Native codegen recognizes.
//   It is imported from our structural compatibility alias because React
//   Native 0.87 hides the old deep-import declaration by default.)
// - The 4 report methods below (configure/openReporter/registerSensitiveRect/
//   setExtra) plus the Plan 06.2-11 companion methods were the
//   COMPLETE surface — adding another report method requires a phase
//   D-decision (Plan 02/03 native impls inherit codegen headers).
//   `addBreadcrumb` (Plan 4 / Task 14) IS that new D-decision: a manual
//   breadcrumb escape hatch forwarding to the native singleton's coercion
//   path (Tasks 5/9) — see its doc comment below.
//   `recordScreen` (spec 2026-07-14) is the next one — the navigation screen marker.
//   `reportCrash` (spec 2026-07-18) is the next D-decision after that — the
//   ONLY sync method on this spec (non-void return forces sync codegen): the
//   default-on ErrorUtils handler in `./errors.ts` must complete the fatal
//   path before RN's own fatal handling kills the process.
//   `setUser` (spec 2026-08-12) is the next D-decision after that — the
//   self-declared identity surface. The bridge PARAMETER is `UnsafeObject`,
//   NOT the named `TXUserSpec` alias, even though `TXUserSpec` is flat like
//   ConfigOpts/Rect: codegen's ObjC generator only honours a parameter's `?`
//   optionality for `GenericObjectTypeAnnotation` (what `UnsafeObject`
//   resolves to). A named `TypeAliasTypeAnnotation` — what a struct alias
//   like `ConfigOpts`/`Rect`/`TXUserSpec` resolves to — always emits a
//   REQUIRED `StructName &` reference regardless of `?`
//   (`GenerateModuleObjCpp/serializeMethod.js`, `TypeAliasTypeAnnotation`
//   branch, ~:190-197 — there's a literal `TODO(T73943261): Support
//   nullable object literals and aliases?` acknowledging the gap). Verified
//   by running this repo's installed `@react-native/codegen@0.85.2` against
//   a reduced spec: `setUser(user?: TXUserSpec)` generates
//   `- (void)setUser:(JS::NativeTraceItX::TXUserSpec &)user;` (required,
//   non-nullable — silently breaks "no argument = clear"), while
//   `setUser(user?: UnsafeObject)` generates
//   `- (void)setUser:(NSDictionary *)user;` (nullable, matching
//   `addBreadcrumb`'s `data?: UnsafeObject` above). This was harmless for
//   `configure(opts: ConfigOpts)` only because that parameter is REQUIRED,
//   never optional, so the alias-vs-UnsafeObject distinction never mattered
//   there. `TXUserSpec` stays exported as the JS-FACING type (runtime.ts /
//   contextSeam.ts / index.ts) — only the bridge parameter itself widens to
//   `UnsafeObject`, same split `addBreadcrumb`'s `data` already uses.
//   `T | null` stays forbidden; CLEARING is expressed by calling with no
//   argument.
//   `ConfigOpts.attachPinUi` (spec 2026-08-19) is the next D-decision after
//   that — a flat optional STRING, not `'builtin' | 'custom' | 'off'`: RN
//   codegen cannot express a string-literal union in a struct field any more
//   than `setUser`'s D-decision above could express one as a bridge method
//   parameter type — same codegen ceiling, different call site (a
//   `ConfigOpts` field here, rather than a whole method's parameter there).
//   Unlike `setUser`'s escape hatch, this one needs no `UnsafeObject`
//   widening: it's a plain `string`, which codegen already handles natively
//   in a struct field — the union is only lost at the TYPE level, not the
//   VALUE level. Each native side re-parses the string into its own
//   `AttachPinUi` enum (`enum AttachPinUi: String` on iOS, `enum class
//   AttachPinUi` on Android) and coerces anything unrecognised — including
//   an absent field, which decodes as `undefined` and never reaches native
//   at all — to `.builtin`/`BUILTIN`. This rides `configure()`, not a new
//   bridge method: the flag is a startup-time preference, not a per-call
//   argument, so it belongs beside `apiKey`/`networkBodiesDisabled` on
//   `ConfigOpts` — see `companion.ts`'s `traceitx.companion.attachChallenge`
//   event, the JS-facing half of this same D-decision.
//   Session Vitals (spec 2026-09-06) is the next D-decision after that —
//   FIVE methods (trackPlayer/detachPlayer/recordPlayerEvent/
//   updatePlayerStats/trackVitals) and three flat ConfigOpts fields
//   (vitalsEnabled/vitalsSampleRate/vitalsCaptureSourceQuery). All void.
//   `recordPlayerEvent.t` is a REQUIRED number rather than `t?: number`:
//   codegen's ObjC generator renders an optional number as `NSNumber *`
//   while Kotlin gets `Double?` — a required `double` is the one shape both
//   sides agree on, and JS always has the timestamp anyway.
//   `trackVitals.dataJson` is a string, not UnsafeObject, because custom
//   entry data may be a scalar or an array.
//   `setExtraResolverActive`/`signalExtraResolverReady` (spec 2026-09-17
//   setExtra-resolver) is the next D-decision after that — RN parity for
//   the resolver form of `setExtra` core/web already have. Native asks JS
//   for a fresh value right before draining pending attachments (mirrors
//   the companion `reportRequested`/`signalCompanionReportRequestReady`
//   handshake below exactly), bounded and fail-open; see both methods' own
//   doc comments.
import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";
import type { UnsafeObject } from "./codegen-types";

/**
 * Geometry rect crossing the bridge. Flat-object only; codegen cannot express
 * the richer UI-tree `Rect` from @traceitx/sdk-core in a spec position.
 */
export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Configure-time options for the native TraceItX runtime. Flat-object only.
 * Rich variants (e.g., callbacks, function refs) MUST stay on the JS side.
 */
export type ConfigOpts = {
  apiKey?: string;
  sdkVersion?: string;
  /**
   * If true, the native side captures a UIWindow/SurfaceFlinger screenshot
   * on every `captureNow()`. Defaults to true.
   */
  captureScreenshot?: boolean;
  /**
   * Client veto for network body capture. `true` disables bodies regardless
   * of server config; the server's `captureBodies` gate must still say ON for
   * capture to happen at all. Flat because RN codegen rejects nested objects —
   * the host-facing nested `networkBodies: { disabled }` is flattened here by
   * `extractBridgeConfig`.
   */
  networkBodiesDisabled?: boolean;
  /**
   * Client veto for the install identifier (MAI meter spec 2026-08-27).
   * `true` stops this app sending one; it can never force it on. Flat because
   * RN codegen rejects nested objects — the host-facing nested
   * `installIdentifier: { disabled }` is flattened here by
   * `extractBridgeConfig`, the same constraint `networkBodiesDisabled` above
   * documents. Absent defaults to `false` (identifier sent) on both natives,
   * matching `TraceItXConfig.installIdentifierEnabled`'s own `true` default
   * once polarity is flipped.
   */
  installIdentifierDisabled?: boolean;
  /**
   * Built-in attach-PIN surface mode (spec 2026-08-19): 'builtin' (default —
   * the native SDK presents the code itself), 'custom' (host renders it from
   * onAttachChallenge; the device still announces the capability), 'off'
   * (legacy one-click dashboard attach, no PIN). Flat string, not a union —
   * codegen cannot express string-literal unions; the natives coerce unknown
   * values to 'builtin'.
   */
  attachPinUi?: string;
  /**
   * Explicit companion device-identity override (naming spec 2026-08-24) —
   * an MDM id or provisioning serial the host already trusts. Hashed
   * (SHA-256 → UUID shape) natively before it ever reaches the announce
   * `device` block — see `CompanionDeviceId.resolve` (iOS) /
   * `CompanionDeviceId.resolve` (Android). Flat optional string, same
   * codegen shape as `attachPinUi` above. `undefined`/absent falls through
   * to each native side's own Keychain/SSAID-then-stored-UUID chain.
   */
  companionDeviceId?: string;
  /**
   * Companion on-screen name-badge visibility (naming spec 2026-08-24,
   * controller ruling / Task 6b) — "a production app that finds it
   * intrusive turns it off in one line". `undefined`/absent defaults to
   * `true` (badge shown) on both natives, matching
   * `CompanionBadgeOptions.enabled`'s own default. Flat because RN codegen
   * rejects nested objects, same constraint `networkBodiesDisabled` above
   * documents — the host-facing nested `companionBadge: { enabled }` is
   * flattened here by `extractBridgeConfig`.
   */
  companionBadgeEnabled?: boolean;
  /** Local veto for native mobile shake-to-report. Absent defaults to enabled. */
  shakeToReportEnabled?: boolean;
  /**
   * Companion on-screen name-badge corner (naming spec 2026-08-24,
   * controller ruling / Task 6b). Flat optional STRING, not a literal
   * union — same codegen ceiling as `attachPinUi` above (RN codegen cannot
   * express a string-literal union in a struct field): the host-facing
   * `RuntimeConfig.companionBadge.position` narrows to the real
   * `'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'` union and
   * `extractBridgeConfig` passes it through unchanged onto this wire field.
   * Each native side re-parses the string into its own
   * `CompanionBadgePosition` enum, coercing `undefined`/an unrecognised
   * value to `.bottomRight`/`BOTTOM_RIGHT` — the same default
   * `CompanionBadgeOptions.position` already uses.
   */
  companionBadgePosition?: string;
  /**
   * Inline reporter theme (reporter branding spec 2026-08-25, RN slice) —
   * 8 optional `#rrggbb` role strings, flattened from the host-facing nested
   * `RuntimeConfig.theme` by `extractBridgeConfig` (RN codegen cannot express
   * a nested object in a struct field — the `companionBadge` constraint
   * above). Pure passthrough: NO hex validation happens on the RN side; each
   * native ThemeResolver revalidates per-field and ignores invalid values.
   * The theme only ever renders once the server entitles it (server
   * `watermark: false`) — the entitlement gate lives natively and cannot be
   * bypassed from here; free plan keeps the watermark (fail closed).
   */
  themeBackground?: string;
  themeSurface?: string;
  themeBorder?: string;
  themeText?: string;
  themeTextMuted?: string;
  themeAccent?: string;
  themeAccentForeground?: string;
  themeDestructive?: string;
  /**
   * Session Vitals local config (spec 2026-09-06, RN). Three FLAT fields
   * flattened from the host-facing nested `RuntimeConfig.vitals` by
   * `extractBridgeConfig` — same codegen reason as `companionBadge*`.
   * `vitalsEnabled`: absent = follow the dashboard toggle; `false` = opt out
   * locally; `true` never forces it on. `vitalsSampleRate`: [0, 1], min()'d
   * with the server rate, clamped natively; absent = server rate.
   * `vitalsCaptureSourceQuery`: keep query strings on `source_change.src`
   * (default false — signed CDN URLs carry tokens). Each native maps present
   * fields onto its own `VitalsConfig` and leaves SDK defaults alone.
   */
  vitalsEnabled?: boolean;
  vitalsSampleRate?: number;
  vitalsCaptureSourceQuery?: boolean;
};

/**
 * Host-declared user for self-declared recognition (spec 2026-08-12). Flat by
 * design — RN codegen rejects recursive shapes, and this needs none.
 *
 * JS-FACING TYPE ONLY — this is what `runtime.ts`/`contextSeam.ts`/
 * `index.ts` type their `setUser` as. It is NOT the type of `Spec.setUser`'s
 * bridge parameter below: codegen only honours `?` optionality for
 * `UnsafeObject`-typed params, not named aliases like this one (see the file
 * header's `setUser` D-decision note for the verified codegen output), so
 * the bridge method itself is typed `UnsafeObject` and this shape is
 * re-asserted at the JS boundary instead.
 */
export type TXUserSpec = {
  id?: string;
  email?: string;
  displayName?: string;
};

export interface Spec extends TurboModule {
  configure(opts: ConfigOpts): void;
  /**
   * Synchronous startup entry used by the current JS runtime. The legacy
   * void configure method remains for already-compiled native callers, but
   * React Native dispatches void TurboModule methods asynchronously.
   */
  configureSync(opts: ConfigOpts): boolean;
  /**
   * Opens the native reporter modal (TXReporterPresenter on iOS / Android).
   * Captures screenshot+uiTree+metadata, lets the user annotate/redact/fill
   * out the form, and resolves when they submit or cancel.
   *
   * Resolves with `{ status: 'submitted' | 'queued' | 'cancelled', reportId? }`.
   * Typed `UnsafeObject` at codegen boundary; facade casts to `ReporterResult`.
   */
  openReporter(): Promise<UnsafeObject>;
  registerSensitiveRect(viewTag: number, rect: Rect): void;
  /**
   * Set host-supplied free-form metadata for the next report. Single opaque
   * string — callers JSON.stringify any structured payload themselves. The
   * native side truncates at 2000 chars. Each call REPLACES the previous
   * value. Auto-cleared after the next openReporter() resolves. Pass empty
   * string to detach.
   */
  setExtra(value: string): void;
  /**
   * Extra-resolver presence flag (spec 2026-09-17 setExtra-resolver — RN
   * parity with the resolver form core/web already have). JS calls this
   * from EVERY `setExtra` call: `true` the instant the RESOLVER form
   * registers, `false` the instant the string/object form pushes a plain
   * value (which also supersedes any previously-registered resolver).
   * Carries NO extra CONTENT, only a presence bit — this is not the "push
   * the resolver's value eagerly" mistake the resolver's own doc comment
   * warns against (see `contextSeam.ts`/`runtime.ts`). It exists purely so
   * the native pre-capture wait (`signalExtraResolverReady` below) can be
   * skipped ENTIRELY — no event emitted, no wait, zero added latency — for
   * a string/object-only host, which is the common case and must see no
   * behaviour change from this feature at all.
   */
  setExtraResolverActive(active: boolean): void;
  /**
   * Companion-precedent-shaped ack (mirrors `signalCompanionReportRequestReady`
   * below exactly): called by the JS-side `traceitx.extra.resolveRequested`
   * listener once it has — IF a resolver is currently registered — invoked
   * it, budgeted the result exactly like `@traceitx/sdk-core`'s
   * `resolveClientExtra`, and pushed it through the existing `setExtra`
   * method above. Releases the native bridge's bounded wait right before
   * `consumePendingAttachments`/`__consumePendingAttachments` drains.
   * Bounded on the native side: if JS never calls back (old JS bundle,
   * frozen thread, or the correlation id simply times out), native
   * proceeds with whatever `extra` was last pushed — fail open, always; a
   * report that never arrives is worse than one with stale `extra`.
   */
  signalExtraResolverReady(correlationId: string): void;
  /**
   * Manual escape hatch (Plan 4 / Task 14): drop a host-supplied marker into
   * the native action-timeline chain. RN apps already inherit ALL native
   * auto-capture (lifecycle/error/console/network-opt-in/tap/nav — Tasks
   * 7-8/11-12) underneath RN; JS-side auto-capture (fetch/react-navigation/
   * touch patches) is an explicit non-goal of this plan. `addBreadcrumb` and
   * `recordScreen` (spec 2026-07-14) are the only JS-initiated crumb paths.
   *
   * Fire-and-forget, positional, fail-soft. NO validation/coercion happens
   * on the bridge — it forwards straight to the platform singleton
   * (`TraceItX.shared.addBreadcrumb` on iOS / `TraceItX.addBreadcrumb` on
   * Android), which owns ALL coercion (unknown `kind` → `custom`, invalid
   * `level` dropped rather than defaulted, `data` JSON-coerced) and gating
   * (no-op pre-start / while killed). `data` is typed `UnsafeObject` — the
   * documented codegen escape hatch for freeform objects (see file header).
   */
  addBreadcrumb(
    message: string,
    kind?: string,
    level?: string,
    data?: UnsafeObject,
  ): void;

  /**
   * Navigation screen marker (spec 2026-07-14 — the D-decision for this
   * method). Records "this screen is now visible"; the NATIVE side derives
   * the `from → to` transition from its global previous-screen state — the
   * same chain the Activity/ViewController auto-capture feeds — and owns
   * all gating/coercion. Fire-and-forget, positional, fail-soft, exactly
   * like `addBreadcrumb` above. `data` is the codegen `UnsafeObject`
   * freeform-object escape hatch; `from`/`to` win over its keys.
   */
  recordScreen(name: string, data?: UnsafeObject): void;

  /**
   * Crash/error reporting (spec 2026-07-18). SYNCHRONOUS by design (non-void
   * return forces a sync TurboModule method): the fatal path must complete
   * before RN's default fatal handling kills the process. Input is the
   * crash-facts JSON: { exceptionType, message, framesRaw[], mechanism,
   * fatal, occurredAt }. Native builds/redacts/persists the envelope with
   * state it already owns (crumb ring, device metadata, outbox).
   * Returns true when the report was persisted.
   */
  reportCrash(crashJson: string): boolean;

  // ---------------- Session Vitals (spec 2026-09-06) ----------------
  //
  // The D-decision for FIVE methods at once: the library-agnostic player
  // bridge plus the custom log line. All void, fire-and-forget, positional
  // (required args first), like `addBreadcrumb`. JS mints `token` from a
  // per-process counter; it is bridge-internal and never reaches the wire —
  // the native PlayerRegistry mints the wire `playerId`. Native wraps each
  // token in a `RemotePlayerIntegration` behind the existing
  // `trackPlayer(PlayerIntegration)` seam, so budgets, kill() gating,
  // rotation reseed and bounds are the natives' — nothing library-specific
  // crosses here. Unknown/duplicate/detached tokens are silent no-ops.

  /** Register a remote player. A token already live is ignored. */
  trackPlayer(
    token: string,
    library: string,
    name?: string,
    libraryVersion?: string,
  ): void;
  /** `handle.detach()` + drop the token. Native emits `player_detach`. */
  detachPlayer(token: string): void;
  /**
   * Forward one phase-4 player event. `t` is REQUIRED — epoch ms stamped by
   * JS when the library fired (bridge delivery is async; same clock as
   * breadcrumbs). `type` is a plain string (codegen cannot express the
   * enum); the native context's `emit` refuses anything outside
   * `VitalsPlayerEventType`. `data` is the `UnsafeObject` escape hatch.
   */
  recordPlayerEvent(
    token: string,
    type: string,
    t: number,
    data?: UnsafeObject,
  ): void;
  /**
   * Refresh the native snapshot cache: `{ bufferAheadMs, bandwidthEstimate?,
   * bitrate?, width?, height?, droppedFrames? }`. `droppedFrames` is
   * CUMULATIVE; native derives the delta. Adapters throttle to ~1/s.
   */
  updatePlayerStats(token: string, stats: UnsafeObject): void;
  /**
   * Custom log line on the session timeline. `dataJson` is a JSON STRING
   * (the `reportCrash` precedent) because a custom entry legitimately carries
   * scalars/arrays that `UnsafeObject` cannot express. Player-scoped when
   * `token` resolves to a live player, else session-scoped.
   */
  trackVitals(name: string, dataJson?: string, token?: string): void;
  /** Explicit handled capture; native enforces handled=true, fatal=false. */
  captureHandledException(crashJson: string): boolean;

  // ---------------- Phone-companion (Plan 06.2-11) ----------------
  //
  // Opens a TV-side RelayWSClient against the build-time-baked ingest URL
  // (IngestEndpoint.url on each native SDK) and forwards
  // `TraceItX.shared.companion` state + pairUrl signals to JS via the
  // platform's RN event-emitter (RCTDeviceEventEmitter on Android, a
  // dedicated RCTEventEmitter subclass on iOS). The bridge owns at most ONE
  // RelayWSClient per process.
  //
  // Emitted events (both platforms — see `src/companion.ts`):
  //   • `traceitx.companion.state`            → 'unpaired' | 'paired' | 'report_in_progress' | 'phone_disconnected'
  //   • `traceitx.companion.pairUrl`          → string | null
  //   • `traceitx.companion.code`             → string | null
  //   • `traceitx.companion.attachedUserName` → string | null
  //   • `traceitx.companion.resolvedName`     → string | null (naming spec 2026-08-24)
  //   • `traceitx.companion.attachChallenge`  → { code, requestedByName, ttlMs } | null (spec 2026-08-19)
  startCompanion(): void;
  stopCompanion(): void;
  /**
   * Companion handshake: called by the JS-side `onReportRequested` listener
   * once it is ready for native capture to proceed. (It used to walk the
   * React fiber tree and attach it via `attachReactTree` first; both are
   * gone — spec 2026-08-29.) Releases the native bridge's bounded wait.
   *
   * Bounded: if JS never calls back, the native side times out after
   * ~250ms and captures anyway.
   */
  signalCompanionReportRequestReady(correlationId: string): void;
  /**
   * RN's `NativeEventEmitter` contract requires `addListener` /
   * `removeListeners` to exist on the underlying native module — RN warns
   * loudly otherwise. Both are intentional no-ops at the spec level: the
   * native event-emitter subscriptions are installed by `startCompanion`.
   */
  addListener(eventName: string): void;
  removeListeners(count: number): void;

  /**
   * Set or clear the active user. Forwards to the native singleton's
   * `setUser`, which owns storage and gating. Call with NO argument to clear
   * (the bridge forbids `T | null`).
   *
   * Typed `UnsafeObject`, NOT `TXUserSpec` — a named struct alias like
   * `TXUserSpec` always generates as a REQUIRED ObjC reference regardless of
   * its `?`, which would silently break "no argument = clear" (see the file
   * header's D-decision note for the verified codegen output).
   * `TXUserSpec` is the richer type the JS facade (`runtime.ts` /
   * `contextSeam.ts` / `index.ts`) casts through at this boundary — same
   * split `addBreadcrumb`'s `data` uses.
   *
   * Unverified by construction: this is a label the app asserts, never a
   * credential. It groups reports in the dashboard and does nothing else.
   */
  setUser(user?: UnsafeObject): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>("TraceItX");

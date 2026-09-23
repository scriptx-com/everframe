// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Pure orchestration runtime for the RN bridge. After the D-05/D-07 flip
// (2026-05-11) the report UI is owned entirely by native; this module's
// responsibilities collapse to:
//
//   - Configure-on-mount call to the TurboModule.
//   - Sensitive-rect registry: in-memory Map + forward to native.
//   - Single-line `open()` that delegates to NativeEverframe.openReporter.
//   - Module-level current-context publish/clear via contextSeam.
//
// Does NOT own:
//   - Any React rendering (handled by `EverframeProvider.tsx`).
//   - Any reporter-UI state machine — there is no JS reporter UI any more.
//   - Native shake detection (owned by sdk-android/sdk-ios); other triggers stay host-owned.
// Local copy of the RN fiber walker (was imported from @everframe/react).
// Inlining avoids pulling sdk-react's web-only deps (react-konva, html-to-image)
// into the RN bundle. Dedupe to sdk-core post-v0.1.0.
import NativeEverframe from "./NativeEverframe.js";
import type { ConfigOpts, Rect } from "./NativeEverframe.js";
import { budgetExtra, EXTRA_MAX_CHARS } from "@everframe/sdk-core";
import type { ExtraResolver } from "@everframe/sdk-core";
import { getEmitter } from "./events.js";
import type { JsBundleConfig } from "./js-bundle.js";
import { createCaptureController, type CaptureController } from "./errors.js";
import {
  __setCurrentContext,
  __getCurrentContext,
  EverframeNotMountedError,
  type EverframeContextValue,
} from "./contextSeam.js";
import type { ReporterResult } from "./reporter/types.js";
import { projectUserSpec } from "./user-projection.js";
import type { EverframeIntegration } from "./integrations/types.js";

/**
 * Runtime configuration — the host-facing `EverframeProvider config` shape.
 *
 * Extends the bridge ConfigOpts but OMITS `sdkVersion`: the SDK version is not
 * host-defined, it's owned by the SDK and stamped per release on the native
 * side (`Everframe.SDK_VERSION`). See extractBridgeConfig.
 *
 * External review, finding NN4 — also OMITS `companionBadgeEnabled` /
 * `companionBadgePosition`, the FLAT wire-shaped fields `ConfigOpts` declares
 * for codegen (RN codegen cannot express the nested `{ enabled, position }`
 * object at all — see `companionBadge` below). Without this, `RuntimeConfig`
 * structurally inherited BOTH the flat wire fields AND the nested
 * `companionBadge` declared below, so `{ companionBadgeEnabled: false }`
 * type-checked as a valid host config and silently no-opped: `extractBridge
 * Config` only ever reads the nested `companionBadge` object, never the flat
 * keys, so a host reaching for the (also-valid-looking) flat shape got no
 * error and no effect. Omitting them here makes `companionBadge` the ONLY
 * public surface for this option — passing the flat form is now a
 * compile-time error, matching the runtime's actual (nested-only) behavior.
 * Deliberately NOT applied to `networkBodiesDisabled`, even though the same
 * shape of gap arguably exists there too (`RuntimeConfig` also declares its
 * own nested `networkBodies?: { disabled? }` below, alongside the inherited
 * flat `networkBodiesDisabled?`): out of scope for this fix by explicit
 * review instruction, left as pre-existing behavior rather than folded in
 * here.
 */
export interface RuntimeConfig
  // companion-bridge-wiring.spec.ts pins this Omit clause while allowing the
  // formatter to wrap its generic arguments (NN4 lock).
  extends Omit<
    ConfigOpts,
    | "sdkVersion"
    | "installIdentifierDisabled"
    | "companionBadgeEnabled"
    | "companionBadgePosition"
    | "shakeToReportEnabled"
    // The 8 flat theme wire fields (reporter branding spec 2026-08-25, RN
    // slice) — same NN4 rationale as the companionBadge pair above: the
    // nested `theme` below is the ONLY public surface; without these Omits a
    // host passing `{ themeAccent: … }` would type-check and silently no-op.
    | "themeBackground"
    | "themeSurface"
    | "themeBorder"
    | "themeText"
    | "themeTextMuted"
    | "themeAccent"
    | "themeAccentForeground"
    | "themeDestructive"
    // Session Vitals (spec 2026-09-06) — same NN4 rationale: the nested
    // `vitals` below is the ONLY public surface.
    | "vitalsEnabled"
    | "vitalsSampleRate"
    | "vitalsCaptureSourceQuery"
  > {
  /**
   * Per-app SDK key (publishable, not secret). Required on the host-facing
   * config — narrows the bridge `ConfigOpts.apiKey?` to required so a missing
   * key is a compile-time error, matching the React SDK. The bridge type stays
   * optional (extractBridgeConfig builds `{}`); only this host surface requires it.
   */
  apiKey: string;
  appName?: string;
  appVersion?: string;
  appBuild?: string;
  /** Exact loaded Hermes bundle identity, independent of the native app build. */
  jsBundle?: JsBundleConfig;
  /**
   * Opt-in JS-side capture integrations (spec 2026-07-14 RN-iOS parity).
   * Import from '@everframe/react-native/integrations/*'; nothing
   * auto-installs. Setups run after configure-on-mount, teardowns on unmount.
   */
  integrations?: EverframeIntegration[];
  /**
   * Crash/error reporting (spec 2026-07-18). Installs a default-on global
   * ErrorUtils handler on mount — deliberately NOT gated behind
   * `integrations` (deviation from the RN integrations doctrine, recorded in
   * the spec): crash capture is a safety net, not an opt-in enrichment. Set
   * `disabled: true` to veto it entirely.
   */
  crashReporting?: {
    disabled?: boolean;
  };
  /**
   * Network request/response body capture (spec 2026-08-12). CLIENT VETO
   * only: `disabled: true` turns bodies off locally; it can never force them
   * on — the server's per-app `captureBodies` gate is authoritative.
   *
   * NOTE: RN does not currently attach Everframe network capture to its own
   * HTTP clients, so this option is correct but inert until that lands.
   */
  networkBodies?: {
    disabled?: boolean;
  };
  /**
   * Install identifier (MAI meter spec 2026-08-27). ON by default: the SDK
   * sends a value derived from a locally-minted, non-secret per-install seed
   * at most once a day, so distinct installs can be counted toward your
   * plan. Nothing about the person using the app is derived or stored, and
   * the seed never leaves the device.
   *
   * CLIENT VETO only: `disabled: true` stops this app sending one from that
   * point on; it can never force it on. Nested host-facing shape flattened
   * onto `ConfigOpts.installIdentifierDisabled` by `extractBridgeConfig` —
   * same idiom, and the same codegen reason, as `networkBodies` above.
   *
   * NOT retroactive and NOT org-wide: installs already recorded earlier this
   * calendar month stay counted, and the number shown is per ORGANIZATION.
   */
  installIdentifier?: {
    disabled?: boolean;
  };
  /**
   * Built-in attach-PIN surface mode (spec 2026-08-19). Narrows the bridge
   * `ConfigOpts.attachPinUi?: string` to a literal union here — the flat
   * `string` on `ConfigOpts` is a codegen constraint on the WIRE type only
   * (RN codegen can't express a string-literal union in a struct field, see
   * `NativeEverframe.ts`'s D-decision header note); this host-facing surface
   * doesn't cross codegen and gets normal DX. `extractBridgeConfig` passes
   * it through unchanged — the union is a subtype of `string`, so no
   * conversion is needed, same as `captureScreenshot` above.
   */
  attachPinUi?: "builtin" | "custom" | "off";
  /**
   * Companion on-screen name-badge visibility/position (naming spec
   * 2026-08-24, controller ruling / Task 6b) — lets a host that finds the
   * badge intrusive turn it off in one line: `companionBadge: { enabled:
   * false }`. Nested host-facing shape, unlike `attachPinUi` above: RN
   * codegen cannot express a nested object in a struct field at all (not
   * even a flat one with a narrowed literal-union member), so
   * `extractBridgeConfig` flattens both fields onto the wire `ConfigOpts`
   * (`companionBadgeEnabled`/`companionBadgePosition`) — the same
   * flattening idiom `networkBodies.disabled` → `networkBodiesDisabled`
   * above already uses for the same reason.
   */
  companionBadge?: {
    enabled?: boolean;
    position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  };
  /**
   * Native mobile shake gesture. Enabled by default; the dashboard remains
   * authoritative. React Native/Expo development builds should normally use
   * `{ enabled: !__DEV__ }` to avoid overlapping with the development menu.
   */
  shakeToReport?: {
    enabled?: boolean;
  };
  /**
   * Inline reporter theme (reporter branding spec 2026-08-25, RN slice) —
   * 8 optional `#rrggbb` role strings for the NATIVE report dialogs the RN
   * SDK presents (`open()`); RN itself renders no reporter UI. Nested
   * host-facing shape, flattened onto the 8 flat `ConfigOpts.theme*` wire
   * fields by `extractBridgeConfig` — the same idiom (and codegen reason) as
   * `companionBadge` above.
   *
   * Rendering is entitlement-gated NATIVELY per the branding contract
   * (precedence server → inline → default): the theme applies only when the
   * server says `watermark: false` (paid plan); a free plan ignores it and
   * keeps the watermark — fail closed, never bypassable from RN. Invalid hex
   * values are ignored per-field by each native ThemeResolver; the RN side
   * is pure passthrough by design.
   */
  theme?: {
    background?: string;
    surface?: string;
    border?: string;
    text?: string;
    textMuted?: string;
    accent?: string;
    accentForeground?: string;
    destructive?: string;
  };
  /**
   * Session Vitals local config (spec 2026-09-06). `enabled`: absent =
   * follow the dashboard toggle, `false` = opt out locally, `true` never
   * forces it on. `sampleRate`: [0, 1], min()'d with the server rate.
   * `captureSourceQuery`: keep query strings on `source_change.src`
   * (default false — signed CDN URLs carry tokens). Flattened onto three
   * flat `ConfigOpts.vitals*` wire fields by `extractBridgeConfig`.
   */
  vitals?: {
    enabled?: boolean;
    sampleRate?: number;
    captureSourceQuery?: boolean;
  };
}

export interface Runtime extends EverframeContextValue {
  mount(): void;
  unmount(): void;
}

// ---------------- Extra-resolver ask-and-wait (spec 2026-09-17) ----------------
//
// Mirrors `companion.ts`'s `installReportRequestedHandler` shape exactly:
// native fires an event BEFORE it drains pending attachments for a report
// and waits a short bounded time for JS to answer via
// `signalExtraResolverReady`. Module-scoped (not per-runtime) because
// single-instance enforcement (T-06-05-04) guarantees at most one mounted
// runtime at a time, matching how `companion.ts` keeps its own module-scope
// state. Installed LAZILY — only the first time a host actually calls
// `setExtra(resolver)` — so a string/object-only host (today's entire
// installed base) never constructs a `NativeEventEmitter` at all. This is
// NOT just an optimization: `NativeEventEmitter` isn't mocked in most of
// this package's unit tests (only files that need it, e.g.
// `companion-code.spec.ts`, override the package-wide `react-native` mock to
// add it), so an unconditional install here would break every other test
// that mounts a runtime.
const EXTRA_RESOLVE_REQUESTED_EVENT = "everframe.extra.resolveRequested";

let _currentExtraResolver: ExtraResolver | null = null;
let _extraResolveSub: { remove: () => void } | null = null;

/**
 * Budgets a resolver's return value exactly like `@everframe/sdk-core`'s
 * `resolveClientExtra` does after calling `extra.resolve()` — same
 * string-length check, same `budgetExtra` call for an object result, same
 * "omit, never truncate" contract on overflow. Deliberately NOT wrapped in
 * try/catch here: the caller wraps the whole resolve-and-push sequence so a
 * throwing resolver still reaches the fail-open path.
 */
function resolveExtraForBridge(resolver: ExtraResolver): string {
  const result = resolver();
  if (typeof result === "string") {
    if (result.length > EXTRA_MAX_CHARS) {
      console.warn(
        `[everframe] setExtra (resolver): ${result.length} chars exceeds the ${EXTRA_MAX_CHARS} limit; ` +
          "extra will be omitted from this report.",
      );
      return "";
    }
    return result;
  }
  const budgeted = budgetExtra(result);
  if (budgeted === null) {
    console.warn(
      `[everframe] setExtra (resolver): serialized value exceeds the ${EXTRA_MAX_CHARS}-char limit; ` +
        "extra will be omitted.",
    );
    return "";
  }
  return budgeted;
}

/**
 * Native asked for a fresh value ahead of draining pending attachments for a
 * report. If a resolver is currently registered, invoke + budget it and push
 * the result through the EXISTING `setExtra` bridge method (no new
 * value-carrying method needed) — then ALWAYS ack via
 * `signalExtraResolverReady`, even when there is nothing to push or the
 * resolver threw, so native's bounded wait releases immediately instead of
 * idling out its full timeout. Fail open (TESTS requirement): a throwing
 * resolver is caught, warned, and pushes `""` (extra omitted for this
 * report) — mirrors `resolveClientExtra`'s own throw handling exactly — and
 * the report still proceeds.
 */
async function handleExtraResolveRequested(correlationId: string): Promise<void> {
  try {
    if (_currentExtraResolver) {
      NativeEverframe.setExtra(resolveExtraForBridge(_currentExtraResolver));
    }
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e);
    console.warn(
      "[everframe] setExtra: the resolver function threw while building a report; " +
        "extra will be omitted from this report.",
      msg,
    );
    try {
      NativeEverframe.setExtra("");
    } catch {
      // Bridge unavailable — nothing more we can do; still ack below so
      // native's wait releases instead of idling out its full timeout.
    }
  } finally {
    try {
      NativeEverframe.signalExtraResolverReady(correlationId);
    } catch {
      // Older native SDK without this method — its own bounded wait times
      // out on its own; no harm, the report still ships.
    }
  }
}

let _extraResolveHandlerInstallWarned = false;

/**
 * Install (idempotent) the listener that answers native's ask-and-wait.
 * Never torn down — mirrors `installReportRequestedHandler`'s "survives
 * unmount" lifetime.
 *
 * NEVER THROWS (fix for a review finding): `getEmitter()` constructs a
 * `NativeEventEmitter`, and on iOS RN's own constructor `invariant`-throws
 * when the backing native module is missing (unlinked pod / codegen not
 * run) — exactly the situation `getEmitter()`'s own doc comment already
 * warns about. Before this fix, that throw propagated straight out of
 * `setExtra(resolver)` into host render code — a diagnostics API must never
 * throw at its own registration. Returns whether the listener is (now, or
 * already) installed so the caller can degrade instead of registering a
 * resolver nothing will ever ask.
 */
function installExtraResolveHandler(): boolean {
  if (_extraResolveSub !== null) return true;
  try {
    _extraResolveSub = getEmitter().addListener(
      EXTRA_RESOLVE_REQUESTED_EVENT,
      (correlationId: string) => {
        void handleExtraResolveRequested(correlationId);
      },
    );
    return true;
  } catch (e) {
    if (!_extraResolveHandlerInstallWarned) {
      _extraResolveHandlerInstallWarned = true;
      const msg = (e as { message?: string })?.message ?? String(e);
      console.warn(
        '[everframe] setExtra: could not install the native resolver listener ' +
          '(is the native module linked? did the host run `pod install`?); ' +
          'falling back to resolving the value once now instead of at report time.',
        msg,
      );
    }
    return false;
  }
}

export function createRuntime(config: RuntimeConfig): Runtime {
  const sensitiveRegistry = new Map<number, Rect>();
  type Mount = {
    teardowns: Array<{ name: string; teardown: () => void }>;
    controller?: CaptureController;
  };
  let mounted: Mount | undefined;

  function open(): Promise<ReporterResult> {
    // Native promise returns NSDictionary / WritableMap with the discriminated
    // status field. The TurboModule spec types it `UnsafeObject`; the cast
    // here is the documented codegen-recursion-shape escape hatch.
    return NativeEverframe.openReporter() as unknown as Promise<ReporterResult>;
  }

  const runtime: Runtime = {
    open,
    captureException(error, options) {
      if (__getCurrentContext() === runtime)
        mounted?.controller?.captureException(error, options);
    },
    sensitive: {
      register(tag, rect) {
        sensitiveRegistry.set(tag, rect);
        NativeEverframe.registerSensitiveRect(tag, rect);
      },
      unregister(tag) {
        sensitiveRegistry.delete(tag);
      },
    },
    setExtra(value: string | Record<string, unknown> | ExtraResolver) {
      if (typeof value === "function") {
        // KEY DESIGN POINT (mirrors @everframe/sdk-core's client.ts): do NOT
        // call `value()` here. Store it; native asks for it (bounded round
        // trip via installExtraResolveHandler) at report-assembly time.
        //
        // ...UNLESS the listener can't be installed at all (fix for a
        // review finding): `installExtraResolveHandler()` returns false
        // when the native event emitter can't be constructed (unlinked
        // module on iOS — see its own doc comment). Registering the
        // resolver anyway would mean native's ask-and-wait sends an event
        // nobody is listening for, times out every report, and — worse —
        // JS never resolves a value at all, so `extra` silently goes
        // missing from every report forever. Degrade to the EAGER path
        // instead: resolve the value once, right now, and push it exactly
        // like the plain string/object overload below would. Not as fresh
        // as the resolver contract promises, but strictly better than
        // "reporting works, extra silently vanishes" or "setExtra throws
        // into host render code" (a diagnostics API must never throw at
        // its own registration).
        if (!installExtraResolveHandler()) {
          _currentExtraResolver = null;
          try {
            NativeEverframe.setExtra(resolveExtraForBridge(value));
          } catch (e) {
            // Resolver threw, or the bridge itself is unavailable — fail
            // open exactly like `handleExtraResolveRequested`'s own catch.
            const msg = (e as { message?: string })?.message ?? String(e);
            console.warn(
              "[everframe] setExtra: the resolver function threw while building a report; " +
                "extra will be omitted from this report.",
              msg,
            );
            try {
              NativeEverframe.setExtra("");
            } catch {
              // Bridge unavailable — nothing more we can do.
            }
          }
          return;
        }
        _currentExtraResolver = value;
        try {
          NativeEverframe.setExtraResolverActive(true);
        } catch {
          // Older native SDK without this method — the round trip simply
          // never fires; setExtra(resolver) behaves like a no-op until the
          // host upgrades native, same fail-open posture as elsewhere here.
        }
        return;
      }
      // A plain value supersedes any previously-registered resolver —
      // matches @everframe/sdk-core's client.ts REPLACE semantics exactly.
      // Only bridge the "false" flip when a resolver was ACTUALLY active:
      // a host that never calls setExtra(resolver) must never see a single
      // extra bridge call from this feature — requirement 3, "no behaviour
      // change whatsoever" for the string/object-only host.
      if (_currentExtraResolver !== null) {
        _currentExtraResolver = null;
        try {
          NativeEverframe.setExtraResolverActive(false);
        } catch {
          // See above.
        }
      }
      if (typeof value === "string") {
        if (value.length > EXTRA_MAX_CHARS) {
          // Warn HERE, at the call site, where the host can still act — the
          // native side truncates at EXTRA_MAX_CHARS with a raw character
          // cut (not JSON-aware), same failure mode object-form budgeting
          // exists to avoid. Mirrors @everframe/sdk-core's client.ts.
          console.warn(
            `[everframe] setExtra: ${value.length} chars exceeds the ${EXTRA_MAX_CHARS} limit. ` +
              "It will be truncated by the native side and may not parse. Pass an object " +
              "instead so the SDK can budget it before it crosses the bridge.",
          );
        }
        NativeEverframe.setExtra(value);
        return;
      }
      const budgeted = budgetExtra(value);
      if (budgeted === null) {
        console.warn(
          `[everframe] setExtra: serialized value exceeds the ${EXTRA_MAX_CHARS}-char limit; ` +
            "extra will be omitted.",
        );
        NativeEverframe.setExtra("");
        return;
      }
      NativeEverframe.setExtra(budgeted);
    },
    setUser(user) {
      // External review, finding 2 (Serious) — PROJECT before the bridge, do
      // not hand the host's object across raw. `EverframeUserSpec` is a TypeScript
      // type and the bridge parameter is `UnsafeObject`, so ANY value crossed:
      // on Android `getString()` threw on a non-string, `txGuardVoid` swallowed
      // it BEFORE `Everframe.setUser()` was reached, and the PREVIOUS account
      // stayed installed — `setUser({ id: 12345 })` silently kept attributing
      // reports to whoever was set before. Projecting here means native never
      // receives a bad type in the first place, and a call that declares a new
      // user always replaces the old one (with a partial user, or an empty
      // one) instead of being dropped.
      //
      // `projectUserSpec` returns `undefined` for a nullish/non-object input,
      // so `setUser()` — the documented clear, since the bridge forbids
      // `T | null` — still crosses as "no argument" and still clears. Mirrors
      // web's `projectUserMetadata` (sdk-core); see user-projection.ts.
      NativeEverframe.setUser(projectUserSpec(user));
    },
    addBreadcrumb(input) {
      // Object-form (web-matching) JS API → positional TurboModule spec call.
      // This is the ONLY place the object→positional conversion happens; no
      // validation/coercion is added here — the native singleton (Tasks 5/9)
      // owns that.
      NativeEverframe.addBreadcrumb(
        input.message,
        input.kind,
        input.level,
        input.data,
      );
    },
    recordScreen(name, data) {
      // Positional forward; the native singleton owns from→to derivation,
      // gating, and coercion (same contract as addBreadcrumb).
      NativeEverframe.recordScreen(name, data);
    },
    mount() {
      if (__getCurrentContext()) {
        throw new EverframeNotMountedError(
          "EverframeProvider already mounted — single-instance enforcement (T-06-05-04)",
        );
      }
      try {
        const bridgeConfig = extractBridgeConfig(config);
        const configureSync = NativeEverframe.configureSync;
        if (typeof configureSync === "function") {
          // Current bridges acknowledge configuration synchronously before the
          // mounted facade becomes visible. A false result or thrown failure
          // stays on this path: falling back would configure the same native
          // runtime twice and would falsely turn a refusal into readiness.
          Reflect.apply(configureSync, NativeEverframe, [bridgeConfig]);
        } else {
          // Older handled-capable bridges predate configureSync. Their retained
          // void configure entry is asynchronous best-effort admission. Mount
          // ownership can be published after this call, but an early handled
          // capture may still be refused until native processes configuration.
          NativeEverframe.configure(bridgeConfig);
        }
      } catch (e) {
        // configureSync is a sequencing boundary. Native keeps its existing
        // guarded configuration error handling; bridge marshaling or a missing
        // TurboModule can still throw synchronously, so surface that loudly.
        const msg = (e as { message?: string })?.message ?? String(e);
        console.warn(`[everframe] configure threw: ${msg}`);
      }
      const owner: Mount = { teardowns: [] };
      mounted = owner;
      __setCurrentContext(runtime);
      if (config.crashReporting?.disabled !== true) {
        owner.controller = createCaptureController({
          jsBundle: config.jsBundle,
          isActive: () =>
            mounted === owner && __getCurrentContext() === runtime,
        });
        if (mounted !== owner) {
          owner.controller.dispose();
          return;
        }
      }
      for (const integration of config.integrations ?? []) {
        if (mounted !== owner) break;
        try {
          const teardown = integration.setup();
          if (teardown) {
            if (mounted === owner)
              owner.teardowns.push({ name: integration.name, teardown });
            else teardown();
          }
        } catch (e) {
          const msg = (e as { message?: string })?.message ?? String(e);
          console.warn(
            `[everframe] integration '${integration.name}' setup threw: ${msg}`,
          );
        }
      }
    },
    unmount() {
      const owner = mounted;
      if (!owner) return;
      // Detach every old-mount field before invoking ANY host callback. A
      // teardown can remount even this runtime object; old cleanup must not
      // clear its new controller, context, registry or integration list.
      mounted = undefined;
      if (__getCurrentContext() === runtime) __setCurrentContext(null);
      sensitiveRegistry.clear();
      // A torn-down provider can never answer native's ask-and-wait — clear
      // the resolver and tell native so a subsequent report doesn't pay for
      // a round trip nothing will ever answer. Native's own bound already
      // makes this a hygiene fix, not a correctness one (fail-open holds
      // either way).
      if (_currentExtraResolver !== null) {
        _currentExtraResolver = null;
        try {
          NativeEverframe.setExtraResolverActive(false);
        } catch {
          // Older native SDK without this method — harmless.
        }
      }
      owner.controller?.dispose();
      for (const { name, teardown } of owner.teardowns) {
        try {
          teardown();
        } catch (e) {
          const msg = (e as { message?: string })?.message ?? String(e);
          console.warn(
            `[everframe] integration '${name}' teardown threw: ${msg}`,
          );
        }
      }
    },
  };

  return runtime;
}

function extractBridgeConfig(config: RuntimeConfig): ConfigOpts {
  const bridge: ConfigOpts = {};
  if (config.apiKey !== undefined) bridge.apiKey = config.apiKey;
  // `sdkVersion` is NOT forwarded — the SDK version is owned by the SDK itself
  // (the native side stamps its own `Everframe.SDK_VERSION`), never the host.
  if (config.captureScreenshot !== undefined)
    bridge.captureScreenshot = config.captureScreenshot;
  // Flatten the nested host-facing veto for the codegen boundary. Polarity is
  // preserved here and flipped exactly once, natively: JS names the veto
  // (`disabled`), native names the permission (`networkBodies`).
  if (config.networkBodies?.disabled !== undefined) {
    bridge.networkBodiesDisabled = config.networkBodies.disabled;
  }
  // Install identifier (MAI meter spec 2026-08-27). Same flattening idiom as
  // networkBodies above; polarity is preserved here and flipped exactly once,
  // natively: JS names the veto (`disabled`), native names the permission
  // (`installIdentifierEnabled`).
  if (config.installIdentifier?.disabled !== undefined) {
    bridge.installIdentifierDisabled = config.installIdentifier.disabled;
  }
  // Attach-PIN UI mode (spec 2026-08-19). `RuntimeConfig` inherits
  // `attachPinUi?` structurally from `ConfigOpts` (it isn't `Omit`ted like
  // `sdkVersion` is) — same name on both sides, no flattening/renaming
  // needed, straight passthrough like `captureScreenshot` above.
  if (config.attachPinUi !== undefined) bridge.attachPinUi = config.attachPinUi;
  // Companion device-identity override (naming spec 2026-08-24).
  // `RuntimeConfig` inherits `companionDeviceId?` structurally from
  // `ConfigOpts` (it isn't `Omit`ted like `sdkVersion` is) — same name on
  // both sides, no flattening/renaming needed, straight passthrough like
  // `attachPinUi` above.
  if (config.companionDeviceId !== undefined) {
    bridge.companionDeviceId = config.companionDeviceId;
  }
  // Companion on-screen name badge (naming spec 2026-08-24, controller
  // ruling / Task 6b). Flatten the nested host-facing option for the
  // codegen boundary, same idiom `networkBodies.disabled` above uses:
  // JS names the nested shape (`companionBadge.enabled`/`.position`),
  // native takes the two flat fields.
  if (config.companionBadge?.enabled !== undefined) {
    bridge.companionBadgeEnabled = config.companionBadge?.enabled;
  }
  if (config.companionBadge?.position !== undefined) {
    bridge.companionBadgePosition = config.companionBadge?.position;
  }
  if (config.shakeToReport?.enabled !== undefined) {
    bridge.shakeToReportEnabled = config.shakeToReport.enabled;
  }
  // Inline reporter theme (reporter branding spec 2026-08-25, RN slice).
  // Flatten the nested host-facing shape onto the 8 flat wire fields, same
  // idiom as `companionBadge` above. Only supplied roles cross the wire —
  // an absent role must stay absent so native sees "host did nothing" for
  // that role. No hex validation here: both native ThemeResolvers
  // revalidate per-field and ignore invalid values.
  const theme = config.theme;
  if (theme !== undefined) {
    if (theme.background !== undefined)
      bridge.themeBackground = theme.background;
    if (theme.surface !== undefined) bridge.themeSurface = theme.surface;
    if (theme.border !== undefined) bridge.themeBorder = theme.border;
    if (theme.text !== undefined) bridge.themeText = theme.text;
    if (theme.textMuted !== undefined) bridge.themeTextMuted = theme.textMuted;
    if (theme.accent !== undefined) bridge.themeAccent = theme.accent;
    if (theme.accentForeground !== undefined) {
      bridge.themeAccentForeground = theme.accentForeground;
    }
    if (theme.destructive !== undefined)
      bridge.themeDestructive = theme.destructive;
  }
  // Session Vitals (spec 2026-09-06): nested → flat, present fields only.
  if (config.vitals?.enabled !== undefined)
    bridge.vitalsEnabled = config.vitals.enabled;
  // An out-of-range sampleRate is dropped rather than forwarded: the natives
  // treat it as a hard config error and refuse to start, so a typo'd `50`
  // (meant as a percentage) would take Session Vitals down for the whole app.
  // Omitting it falls back to the server-configured rate.
  const sampleRate = config.vitals?.sampleRate;
  if (sampleRate !== undefined) {
    if (
      typeof sampleRate === "number" &&
      Number.isFinite(sampleRate) &&
      sampleRate >= 0 &&
      sampleRate <= 1
    ) {
      bridge.vitalsSampleRate = sampleRate;
    } else if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn(
        `[everframe] vitals.sampleRate must be within 0..1; ignoring ${sampleRate}`,
      );
    }
  }
  if (config.vitals?.captureSourceQuery !== undefined) {
    bridge.vitalsCaptureSourceQuery = config.vitals.captureSourceQuery;
  }
  return bridge;
}

/** Test seam — the flattening rule is the one place JS and native shapes meet. */
export const __extractBridgeConfigForTesting = extractBridgeConfig;

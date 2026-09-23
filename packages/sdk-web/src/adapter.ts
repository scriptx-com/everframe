// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import type {
  PlatformAdapter,
  LogEntry,
  NetworkEntry,
  DeviceMetadata,
  ReportDraft,
  Rect,
  ReplayCapture,
  ReplayLifecycle,
  ReplayConfig,
  BreadcrumbsConfig,
  BreadcrumbBuffer,
  NetworkBodyBuffer,
  ThreadClient,
  IdentityTokenReader,
  UserMetadata,
} from '@everframe/sdk-core';
import {
  createConfigProvider,
  createReplayLifecycle,
  REPLAY_CONFIG_OFF,
  getBreadcrumbsConfig,
  BREADCRUMBS_CONFIG_DEFAULT,
  getNetworkBodiesConfig,
  getCompanionBadgeServerConfig,
  getBrandingServerConfig,
  getResourcesServerConfig,
  buildCrashEnvelope,
  extractCrashFacts,
  extractCrashCauseChain,
  redactStringContent,
  computeCrashFingerprint,
  createCrashThrottle,
  DEFAULT_CONFIG_TTL_MS,
  DEFAULT_REPORT_HOTKEY_BINDING,
  createReporterApi,
  createThreadClient,
  isRepliesEnabled,
  isIdentityEnabled,
  decodeSub,
} from '@everframe/sdk-core';
import type { OutboxItem } from '@everframe/sdk-core';
import type { CaptureExceptionOptions } from '@everframe/sdk-core';
import { __setCompanionBadgeServerConfig } from './companion/server-config.js';
import { __setBrandingServerConfig } from './branding/server-config.js';
import { __setVitalsServerConfig } from './vitals/server-config.js';
import { stampActiveVitals } from './vitals/stamp-active-vitals.js';
import {
  createResourceRing,
  startResourceSampler,
  stampResources,
  __setActiveResources,
  type ResourceRing,
} from './resources/index.js';
import type { FocusedNode } from '@everframe/protocol';
import { DEFAULT_RESOURCE_WINDOW_SEC } from '@everframe/protocol';
import type { WebEverframeConfig } from './internal/types.js';
import type { ReporterResult } from './reporter-types.js';
import { sensitiveRegistry } from './sensitive/registry.js';
import { createReplayRecorder, type ReplayRecorder } from './capture/replay/index.js';
import {
  adoptReplayDebugSeam,
  installReplayDebugSeam,
  type ReplayDebugSources,
} from './debug/seam.js';
import { INGEST_URL } from './constants.js';
import { captureScreenshot, applyMaskRectsToBlob } from './capture/screenshot.js';
import type { DegradedReason } from './internal/degraded-reasons.js';
import { installConsolePatcher } from './capture/logs.js';
import {
  installFetchPatcher,
  installXHRPatcher,
  __bindBodyCaptureHooks,
  forwardingBodyCaptureHooks,
  type BodyCaptureHooks,
} from './capture/network.js';
import {
  installNavigationCrumbs,
  installLifecycleCrumbs,
  installTapCrumbs,
  __bindCrumbHooks,
  __bindCrashSink,
  forwardingCrumbSink,
  forwardingCrumbGate,
  forwardingCrashSink,
  applyBreadcrumbsConfigToBuffer,
  type CrumbSink,
  type KindGate,
} from './capture/breadcrumbs.js';
import {
  getLogsSnapshot,
  getNetworkSnapshot,
  __claimCaptureBuffers,
  __setCaptureAccepting,
} from './capture/buffers.js';
import { captureFocusedNode as captureFocusedNodeImpl } from './capture/focus.js';
import { getDeviceMetadata as getDeviceMetadataImpl } from './capture/metadata.js';
import { createOutbox } from './outbox/index.js';
import {
  discardEnqueuedReport,
  drainOutboxWhileOwned,
  recordEnqueuedIdentitySubject,
} from './transport/submit.js';
import {
  createLocalStorageCredentialStore,
  makeWebInstallIdSupplier,
} from './reporter/credential-store.js';
import { inferFormFactor, generateReportId } from './transport/draft-to-envelope.js';
import {
  VANILLA_SDK_NAME,
  type HostSdkIdentity,
  type HostSdkName,
} from './internal/sdk-identity.js';
import { PKG_VERSION } from './internal/version.js';
import { captureUserSnapshot } from './internal/user-snapshot.js';

/**
 * The structural slice of sdk-core's `IdentityTokenHolder` that this adapter
 * consumes — `get()` (async, may invoke the host's provider) and `peek()`
 * (cache-only, synchronous). Nothing here reaches for the holder's internals.
 *
 * Declared STRUCTURALLY rather than importing the concrete class, and that is
 * load-bearing for publishing, not a style choice. The published `.d.ts` has
 * to be self-contained — `@everframe/sdk-core` and `@everframe/protocol` are
 * `private: true` and will never exist on npm — which means tsup's
 * `dts.resolve` inlines their declarations into `dist/index.d.ts` and
 * `dist/ui.d.ts`. `IdentityTokenHolder` is a class with `private` members, so
 * it is NOMINALLY typed: an inlined copy and the original stop being mutually
 * assignable, and `@everframe/react`'s provider.tsx — which imports the holder
 * from sdk-core directly and hands it to `__setIdentityTokenHolder` below —
 * fails to typecheck (`Types have separate declarations of a private property
 * 'source'`). It was the ONLY nominal type anywhere in the inlined graph.
 *
 * Naming the narrow shape the seam actually needs removes it from that graph
 * entirely: a real `IdentityTokenHolder` still satisfies this interface
 * structurally, so every existing call site is unchanged, and the emitted
 * declarations contain nothing that can fail to unify across copies.
 */
export interface IdentityTokenHolderLike {
  /** Resolve the token to present, awaiting the host's provider if needed. */
  get(now: number): Promise<string | null>;
  /** Cache-only, synchronous read — never invokes the host's provider. */
  peek(now: number): string | null;
  /**
   * "An identity token source is configured and there is no usable token right
   * now" — see `IdentityTokenHolder.hasUnresolvedSource`, which takes `now`
   * because it is re-derived from `peek()` on every call and keeps no state of
   * its own. OPTIONAL here, unlike the two above, so a stand-in holder in a
   * host or a test that predates it still satisfies this interface; absent
   * reads as "nothing pending", the same conservative answer as no holder
   * being bound at all.
   */
  hasUnresolvedSource?(now: number): boolean;
}

/**
 * WebPlatformAdapter — Phase 3 plan 01 ships the skeleton; capture methods are filled
 * by plans 02 (logs+network), 03 (screenshot), 04 (ui-tree+focus+metadata), 05 (sensitive
 * registry + outbox), 06 (showReporterUI), 07 (final integration).
 */
export interface WebPlatformAdapter extends PlatformAdapter {
  /**
   * Imperative open() invoked by `useEverframe().open()` / top-level `open()`.
   * Returns a Promise that resolves with the user-facing outcome of the report:
   *   - 'submitted' once submit succeeds,
   *   - 'queued' once the envelope is persisted to the outbox for retry,
   *   - 'cancelled' if the user dismisses the modal without submitting,
   *     or, with `reason: 'killed'`, immediately and WITHOUT opening anything
   *     once `client.kill()` has run and no live host mount has since
   *     re-claimed this adapter — the kill switch means no new capture. See
   *     `reportingKilled` in the factory below for what "re-claimed" covers.
   * Matches the RN bridge shape so cross-platform callers can `await open()`
   * and branch on `result.status` identically.
   */
  __openReporter(): Promise<ReporterResult>;
  /**
   * Provider-only seam — settle the pending `__openReporter()` Promise with the
   * final user-facing outcome. Called from `onComplete` after `submitReportFromDraft`
   * resolves (success → `submitted`, retryable → `queued`, fatal → `cancelled`
   * with reason='error') and from `onCancel` (`cancelled`). Distinct from
   * `__resolveReporterUI` which resolves the *core* showReporterUI promise
   * (the modal-closed signal) — that one still fires at modal close time so
   * sdk-core's internal report() flow unblocks immediately.
   */
  __resolveOpen(result: ReporterResult): void;
  /**
   * Provider-only seam — register the React state setter that flips the
   * ReporterDialog to `open`. Adapter's `__openReporter` invokes this callback
   * after staging the pending-promise so a single source owns the modal-open
   * trigger (sdk-core's showReporterUI flow + the public `open()` both route
   * through __openReporter). Default is a no-op so adapter-only tests don't
   * need to wire a DOM provider.
   */
  __registerShowModal(cb: () => void): void;
  /**
   * Subscribe to the dashboard-owned report hotkey. The listener is called
   * immediately with the canonical default, then whenever a successful
   * remote-config refresh changes the binding.
   */
  __subscribeReportHotkey(listener: (binding: string) => void): () => void;
  /**
   * Last DegradedReason surfaced by a capture (set by plan 03-03 captureScreenshot when
   * modern-screenshot fails). Plan 03-07 envelope-builder reads this to populate
   * envelope.captureControl.degradedReason. Non-enumerable getter — never iterated.
   */
  readonly __lastDegradedReason?: DegradedReason;
  /**
   * Test-only cleanup hook (plan 03-02) — calls every capture-patcher uninstaller so
   * specs can guarantee teardown without leaving global console/fetch/XHR mutated. NOT
   * exposed to consumers; non-enumerable.
   */
  readonly __testCleanup: () => void;
  /**
   * Plan 03-05 seam — register a callback invoked on every drain trigger (init, post-submit,
   * window 'online' event). Plan 03-07 transport glue calls this to wire the outbox drain
   * loop to the actual submitReport path. Default is a no-op until registered.
   */
  __registerOutboxDrainTrigger(cb: () => void | Promise<void>): void;
  /**
   * Plan 03-06 seam — resolve the in-flight `showReporterUI` Promise. The Provider's
   * ReporterDialog calls this with the user-completed draft on submit, or `null` on
   * discard-confirm. sdk-core's report() flow awaits the Promise returned by
   * showReporterUI; this seam decouples the Promise resolution from the React render
   * lifecycle so the modal can resolve cleanly across re-renders.
   */
  __resolveReporterUI(draft: ReportDraft | null): void;
  /**
   * REPLAY-02 — the session-replay lifecycle state machine (sdk-core) bound to
   * the web rrweb recorder + the fail-closed config provider. The Provider drives
   * it off the reporter hook points: `freeze()` at the top of open (before mount),
   * `cancel()` on cancel, `complete()` on submit (yields the ReplayCapture). The
   * lifecycle is a guarded no-op when replay is OFF / sampled-out, so this is safe
   * to call unconditionally. `undefined` only if replay wiring was skipped.
   */
  readonly __replayLifecycle?: ReplayLifecycle;
  /**
   * Best-effort refresh of the remote replay config, then attempt to open the
   * rolling buffer (gated on replayEnabled + sampling). Called once by the
   * Provider after init. Resolves silently; never throws (fail-closed).
   */
  __initReplay(): Promise<void>;
  /**
   * Test seam (like `__testCleanup`) — drives the SAME forced-refresh path
   * `refreshGate` runs on wake, so a spec can exercise it without standing up
   * a thread client. Not product API; nothing in the SDK calls it.
   */
  __testRefreshConfigNow(): Promise<void>;
  /**
   * Breadcrumbs (spec §5/§6) — late-bind the crumb sink to the sdk-core
   * client's buffer. The adapter installs its capture listeners at creation
   * (so pre-open activity is captured); events are dropped until the Provider
   * binds the buffer right after createClient. Same buffer addBreadcrumb uses:
   * one chain, one redaction pass, one freeze lifecycle.
   */
  __setBreadcrumbBuffer(get: () => BreadcrumbBuffer | undefined): void;
  /** Companion seam: read access to the buffer registered by the provider. */
  __getBreadcrumbBuffer(): BreadcrumbBuffer | undefined;
  /**
   * Network bodies (spec 2026-07-18 §7) — late-bind the body sink to the
   * sdk-core client's dedicated body buffer, the SAME seam breadcrumbs use.
   * The adapter installs the fetch/XHR patchers at creation; captured bodies
   * are dropped until the Provider binds the buffer right after createClient.
   * One buffer, one freeze/clear lifecycle shared with the crumb chain.
   */
  __setNetworkBodiesBuffer(get: () => NetworkBodyBuffer | undefined): void;
  /** Companion/report seam: read access to the body buffer registered by the provider. */
  __getNetworkBodiesBuffer(): NetworkBodyBuffer | undefined;
  /**
   * Reporter identity recognition (spec 2026-08-06) — late-bind the identity
   * token holder, the SAME seam breadcrumbs/networkBodies use above: the
   * holder lives in sdk-core client state, which doesn't exist yet when this
   * adapter is constructed, so the Provider binds it right after
   * `createClient`. Consumed internally by the thread-client's reporterApi
   * (below) and, via `__identityTokenReader`, by provider.tsx's own
   * submit/drain call sites.
   */
  __setIdentityTokenHolder(get: () => IdentityTokenHolderLike | undefined): void;
  /**
   * Self-declared recognition (spec 2026-08-12) — the SAME late-bind seam
   * breadcrumbs/networkBodies/identity use above, for the host's `setUser`
   * value. The report and phone-companion paths reach `state.user` through
   * their own React/host-seam call sites; the CRASH sink cannot — it fires
   * from a window error handler with no React context — so it reads the user
   * through this getter instead. Without it a web crash from a signed-in user
   * ships anonymous while iOS and Android both attribute theirs.
   *
   * A GETTER, not a snapshot, for the same reason the companion seam's
   * `getUser` is one: the host's user changes over the session, and a captured
   * value would pin whoever was signed in when the Provider mounted onto every
   * later crash. Read defensively at crash time — a crash sink must never
   * block or throw.
   */
  __setUserGetter(get: () => UserMetadata | null): void;
  /**
   * Resolves the token to present on THIS submit/reporter call, if any —
   * gated on the LIVE `identity.enabled` config value read from the same
   * hoisted config provider replay/breadcrumbs/replies share, so a project
   * with no signing secret never invokes the host's `setIdentityToken`
   * provider at all. Always present (never `undefined`) so every call site —
   * this adapter's own thread-client polling, provider.tsx's submit/drain
   * calls, and the companion capture bridge — can pass it straight into
   * `submitReport`/`createReporterApi` unconditionally; it resolves `null`
   * on its own whenever there's nothing to present (SDK disabled, no holder
   * bound yet, feature disabled, or the holder itself resolves null).
   */
  readonly __identityTokenReader: IdentityTokenReader;
  /**
   * PR review, round 4 (Serious) — capture the identity token to pin for a
   * submit, AT THE SUBMIT BOUNDARY: the moment the user's report is handed
   * to the SDK (`onComplete` in provider.tsx, `runCompanionSubmit` in
   * capture-bridge.ts), before ANY asynchronous preparation (replay
   * hashing, attachment reads, multipart construction, credential access)
   * runs. Rounds 2/3 closed this same class of bug at the drain, the
   * enqueue, and the live request in turn — each fix was correct for the
   * window it addressed, and the leak simply moved earlier each time. This
   * closes the EARLIEST window: preparation before a report ships can span
   * hundreds of milliseconds to seconds (a screenshot, a replay buffer), and
   * an account switch during THAT window must not get pinned to someone
   * else's report.
   *
   * Tries the cache-only, synchronous `IdentityTokenHolder.peek()` first —
   * gated the same way as `__identityTokenReader`, zero added latency, exactly
   * "whatever was live the instant Submit was pressed". Falls back to a
   * single BOUNDED `__identityTokenReader.get()` call only when the cache is
   * cold; that call is itself capped at `IDENTITY_PROVIDER_TIMEOUT_MS` (the
   * same constant everywhere else in this feature — no second knob) and
   * never throws, so a submit is never blocked or failed over identity work.
   * Callers thread the resolved value straight into
   * `submitReportFromDraft`'s `capturedIdentityToken` — see that option's doc
   * for why it must NOT be re-resolved once captured here.
   */
  __captureIdentityAtSubmitBoundary(): Promise<string | null>;
  /**
   * External review, finding 1 (Serious) — the self-declared user's
   * counterpart to `__captureIdentityAtSubmitBoundary()` above: snapshot the
   * host's live `setUser` value at the moment the report is handed to the SDK,
   * before ANY asynchronous preparation runs. Same failure this feature's
   * token capture closes (an account switch during a prep window that can span
   * seconds), same submit boundaries, different value.
   *
   * A SIBLING function, not an extra return value on the identity capture, and
   * SYNCHRONOUS rather than async — see `internal/user-snapshot.ts`'s header
   * for both reasons (the token's capture is fail-closed gated on
   * `identity.enabled`; this must never acquire that gate, and being sync lets
   * it run BEFORE the token's await at every call site).
   *
   * Returns a CLONE, never the host's own object. Never throws.
   */
  __captureUserAtSubmitBoundary(): UserMetadata | null;
  /**
   * Task 11 (spec 2026-09-10 — playback session identity) — the CACHE-ONLY,
   * SYNCHRONOUS identity-token read, gated exactly like
   * `__identityTokenReader` (live `identity.enabled` + a bound holder) but
   * built on `IdentityTokenHolder.peek()`: it never invokes the host's
   * `setIdentityToken` provider and never awaits anything.
   *
   * Exposed for the vitals collector, whose `sendSummary` is synchronous and
   * also runs from the pagehide/unload path — there is no moment at which it
   * could await `__identityTokenReader.get()` or the bounded
   * `__captureIdentityAtSubmitBoundary()`. Controller ruling R7.
   *
   * `null` whenever there is nothing cached (feature disabled, no holder
   * bound, nothing set, or the cached token has expired). A cold cache means
   * that one summary carries no token; a later one picks it up.
   */
  __peekIdentityToken(): string | null;
  /**
   * Task 11 (round-2 finding 3) — true while a VERIFIED identity token may
   * still be on its way: identity is enabled for the project, a token source
   * is configured, nothing is cached to present right now, and that source has
   * not answered "nobody is signed in". Asked afresh on every call (round-3
   * finding 2: a latched answer went on saying "settled" while a warm cache
   * aged into its own refresh, which is precisely when a twin gets minted).
   *
   * Gated identically to `__peekIdentityToken()` above (live `identity.enabled`
   * + a bound holder), because the same gate decides whether a token can ever
   * arrive at all: with identity off for the project nothing is pending, no
   * matter what the host set.
   *
   * Read by the vitals wiring only, and only to decide whether to WITHHOLD the
   * self-declared `user` block for one summary — never to decide what is
   * presented.
   */
  __identityTokenPending(): boolean;
  /**
   * Re-point the module-level forwarding crumb hooks (and, F37 round-8
   * review, the crash sink and body-capture hooks) at THIS adapter's
   * sink/gate. The creation-time bind is not enough: StrictMode double-invokes
   * the Provider's useMemo factory, so a discarded adapter can be the one
   * bound last while React commits the other — the Provider must re-bind from
   * a mount effect (which only runs for the committed pair). This is also
   * what production teardown relies on to recover from: `onKill()` never
   * uninstalls the page-global fetch/XHR/console patchers, so a FRESH
   * Provider mount after an old one's unmount must re-bind here (called from
   * the same mount effect) or capture stays silently dead forever.
   */
  __rebindCrumbHooks(): void;
  /** Apply server-driven maxCount to the live buffer (called after config refresh). Never throws. */
  __applyBreadcrumbsConfig(): void;
  /**
   * PRODUCTION teardown for the listeners this adapter owns outright — today
   * the window 'online' outbox-drain listener. Distinct from `__testCleanup`
   * (which also uninstalls the page-global capture patchers, and must not run
   * in production: they are shared, install-once, and re-claimed by the next
   * instance's `__rebindCrumbHooks()`), and from `onKill` (which leaves DOM
   * listeners in place, matching what the React Provider has always done).
   *
   * `init()`'s `destroy()` calls this because repeated init/destroy is that
   * API's advertised flow: without it, one reconnect after N cycles fires N
   * concurrent `drainOutbox` runs over a single origin-wide outbox with no
   * lock — a duplicate-submit path for the same queued report — and every
   * dead adapter stays reachable from the listener. Idempotent.
   */
  __uninstallWindowListeners(): void;
  /** Current trim options for the envelope build (server config or spec defaults). */
  __breadcrumbTrimOptions(): { byteBudget: number; consoleEntryCap: number };
}

/**
 * Effective body-capture gate (spec §3): server ON && !client-veto &&
 * sampled-in && breadcrumbs support the `network` kind.
 *
 * Round-6 review Finding F28: a body is meaningless without its correlating
 * SHIPPED network breadcrumb — the envelope builder drops any
 * `payload.networkBodies[]` entry whose `ref` has no matching network crumb
 * (spec §7/§11.8's every-ref-matches-one-crumb invariant). Before this fix
 * `networkBodiesConfig.captureBodies` was independently toggleable from
 * `breadcrumbsConfig` — an operator could turn bodies ON while breadcrumbs
 * were OFF (or `kinds` omitted `network`), and every captured body was then
 * silently dropped at encode time with no diagnostic anywhere.
 * `crumbsExcludeNetwork` lets the CAPTURE gate itself (not just the
 * encode-time filter) stay off in that case, which also saves the
 * memory/CPU of capturing bodies that can never ship. Defaults to `false`
 * (matches `BREADCRUMBS_CONFIG_DEFAULT`'s own enabled+all-kinds default) so
 * existing call sites that don't yet compute it are unaffected.
 */
export function computeBodyCaptureEnabled(
  serverEnabled: boolean,
  clientVetoed: boolean,
  sampledIn: boolean,
  crumbsExcludeNetwork: boolean = false,
): boolean {
  return (
    serverEnabled === true &&
    clientVetoed !== true &&
    sampledIn === true &&
    crumbsExcludeNetwork !== true
  );
}

/**
 * Per-session body-capture sampler. Draws the sampling decision AT MOST ONCE,
 * and only after capture is server-enabled — so the draw uses the resolved
 * samplingRate, never the fail-closed default. Memoized thereafter.
 */
export function createSessionSampler(
  rng: () => number = Math.random,
): (samplingRate: number, serverEnabled: boolean) => boolean {
  let decided: boolean | undefined;
  return (samplingRate, serverEnabled) => {
    if (!serverEnabled) return false;
    if (decided === undefined) decided = rng() < samplingRate;
    return decided;
  };
}

export function createWebPlatformAdapter(
  _config: WebEverframeConfig,
  /**
   * Who is hosting this adapter — see internal/sdk-identity.ts. Passed in
   * rather than read from this package's own constants, because the two
   * envelope paths this adapter owns (the crash envelope and the crash-report
   * outbox drain) are the only ones with no caller to hand them the values,
   * and this package is shared by two differently-named, independently
   * versioned SDKs. Taken as a CONSTRUCTOR argument so the identity is fixed
   * before the crash handlers below are installed: a mutable seam written
   * afterwards leaves a window in which a crash is stamped with the wrong SDK.
   */
  hostSdk: HostSdkIdentity = {},
): WebPlatformAdapter {
  // Codex round-2 finding 2 (P1, attribution). This pair used to default to
  // `everframe-react` + THIS package's PKG_VERSION — a combination that cannot
  // legitimately occur: `@everframe/react` is independently versioned and its
  // Provider passes BOTH values explicitly (provider.tsx's `useMemo`), so the
  // React name never travels with the web package's version except by way of
  // this default. `createWebPlatformAdapter` is a public export of
  // `@everframe/web`, so any non-React host constructing an adapter directly
  // had its crash stream billed to the React SDK under a version that SDK has
  // never published.
  //
  // Defaulting to the VANILLA pair instead makes the fallback internally
  // coherent — the name and the version now describe the same package, the one
  // that owns this module — and cannot regress `@everframe/react`, which never
  // reaches either default. See internal/sdk-identity.ts.
  const sdkName: HostSdkName = hostSdk.sdkName ?? VANILLA_SDK_NAME;
  const sdkVersion: string = hostSdk.sdkVersion ?? PKG_VERSION;
  const NOT_YET = (m: string, plan: string) => () => {
    throw new Error(`WebPlatformAdapter.${m} not implemented in 03-01 — filled by plan ${plan}`);
  };
  let lastDegradedReason: DegradedReason | undefined;

  // F17/F18 (round-4 review) — set once by onKill() (called from sdk-core's
  // client.kill(), see PlatformAdapter.onKill's doc comment), never reset.
  // Consulted by bodyCapture.enabled() (F17: the gate must stop returning
  // true once the client is killed, not just rely on the buffer clearing
  // once) and by the periodic config-refresh loop (F18: a tick already
  // in-flight when kill() lands must not re-arm anything on completion).
  let killed = false;

  // Codex round-1 findings 1 and 2 (and round-2 finding 3) — a SECOND,
  // narrower kill flag, for the three paths that PRODUCE OR SHIP A REPORT:
  // opening the reporter, the crash sink, and the 'online' outbox drain.
  // Deliberately not `killed` above, which F17/F18 define as set once and never
  // reset, because `onKill()` does not actually mean "the host pulled the
  // consent switch" in `@everframe/react`:
  //
  //   React StrictMode (the Next.js dev default) simulates an unmount by
  //   running every effect CLEANUP and then every effect again, against the
  //   SAME `ctxValue` — and provider.tsx's teardown cleanup calls
  //   `client.kill()`, which lands here. So in dev, every live React Provider
  //   has already been "killed" before the user can click anything. Gating
  //   `__openReporter`/`crashSink` on `killed` therefore breaks the reporter
  //   for every StrictMode host (proven by sdk-react's
  //   __tests__/integration/breadcrumbs-strictmode.spec.tsx, which goes red on
  //   exactly that). The underlying bug is provider.tsx killing a live client
  //   from an effect cleanup; fixing THAT is a change to `@everframe/react`'s
  //   own lifecycle and is tracked separately.
  //
  // So this flag is cleared again by `__rebindCrumbHooks()` — the seam a host
  // calls to declare "a live mount owns this adapter", already the documented
  // StrictMode / Fast-Refresh recovery hook, invoked from provider.tsx's mount
  // effect and from `init()`. A genuine `client.kill()` is never followed by
  // one, so the switch holds; a StrictMode remount always is, so dev works.
  // `killed` itself keeps its never-reset semantics for the paths that only
  // CAPTURE or re-arm timers — `bodyCapture.enabled()`, the periodic config
  // refresh, `applyLiveConfig` — where a permanently-off gate costs a
  // StrictMode dev host nothing a remount does not immediately re-establish.
  // The 'online' drain listener used to sit in that group and did NOT belong
  // there; see `onOnline` below (round-2 finding 3). Nor did the replay-window
  // arm: `attemptReplayStart()` is reached only from the mount effect's
  // `__initReplay()` and the config refreshes, so a permanently-off gate there
  // is NOT re-established by a remount — it is what stops one. See round-4
  // finding 2 at that function and at `ReplayRecorder.revive`.
  let reportingKilled = false;
  // Changes whenever a host releases or reclaims this adapter. Async crash
  // work must belong to the same ownership epoch from extraction through send.
  let reportingOwnership = 0;

  // Adapter-OWNED window listeners (today: the 'online' outbox-drain
  // listener). Distinct from `uninstallers`, which is dominated by the
  // page-global capture patchers — those are install-once behind Symbol
  // markers, shared with anything else on the page, and must survive a
  // teardown so a later re-init can re-claim their forwarding slots. These
  // have no such guard: one per adapter, accumulating on every init().
  const ownWindowListenerUninstallers: Array<() => void> = [];

  // PIPE-02 — localStorage primary, in-memory fallback; surfaced when not disabled (DEFE-03).
  // Hoisted (spec 2026-07-18 crash-reporting task) so the crash reporter built below and
  // the adapter object surfaced to the Provider share ONE outbox instance.
  const outbox = _config.disabled !== true ? createOutbox() : undefined;

  // Two-way replies (Task 3) — one reporter device credential store per adapter
  // instance, shared by the reporter submit path and the crash-report outbox
  // drain below. `null` when localStorage/crypto are unavailable (SSR) — every
  // consumer treats that as "present no token" (server mints, pre-existing
  // behaviour).
  //
  // PR review Finding 2: `config.replies.disabled` is documented as a hard
  // local veto — "no polling, no UI, no token presented on submit" — but was
  // only wired into the thread-client gate below. This is the single choke
  // point for the credential seam: submit (provider.tsx reads
  // `adapter.reporterCredentials`) and the crash-report outbox drain (the
  // `reporterCredentials` closure var used directly a few lines down) both
  // key off this ONE value, so gating its creation here covers both — a
  // vetoed client never mints, presents, or persists a device token. Vetoing
  // does NOT clear an already-stored token (the veto may be temporary; a
  // later un-veto should resume the same thread identity).
  const reporterCredentials =
    _config.disabled !== true && _config.replies?.disabled !== true
      ? createLocalStorageCredentialStore(_config.apiKey)
      : null;

  // Plan 03-02 — uninstallers for every capture patcher installed below (console,
  // fetch, XHR, breadcrumbs), torn down together by __testCleanup.
  const uninstallers: Array<() => void> = [];

  // Plan 03-06 — Promise resolution seam for the reporter modal. The ReporterDialog
  // (mounted by the Provider) calls __resolveReporterUI(draft|null) when the user
  // submits or discards; that resolves the showReporterUI promise sdk-core awaits.
  let pendingResolve: ((d: ReportDraft | null) => void) | undefined;

  // Separate seam for the public `open()` promise — settled by the Provider AFTER
  // submit completes (or on cancel). Decoupled from `pendingResolve` (modal-close
  // signal) so `await open()` reflects the network outcome the user cares about.
  let pendingOpenResolve: ((r: ReporterResult) => void) | undefined;

  // Show-modal callback registered by the Provider on mount. Default no-op so
  // adapter-only tests don't need a DOM provider mounted.
  let showModal: () => void = () => undefined;

  let reportHotkeyBinding = DEFAULT_REPORT_HOTKEY_BINDING;
  const reportHotkeyListeners = new Set<(binding: string) => void>();
  const publishReportHotkey = (binding: string): void => {
    if (binding === reportHotkeyBinding) return;
    reportHotkeyBinding = binding;
    for (const listener of reportHotkeyListeners) {
      try {
        listener(binding);
      } catch {
        /* swallow — DEFE-02 */
      }
    }
  };

  // Plan 03-05 — outbox drain callback registered later by plan 03-07 transport glue;
  // we install the 'online' listener now (with a no-op default) so the seam is in place.
  let drainCallback: () => void | Promise<void> = () => undefined;
  const onOnline = (): void => {
    // The gate's intent: a torn-down adapter still reachable from a
    // page-global listener must not drain the origin-wide outbox on someone
    // else's reconnect.
    //
    // Codex round-2 finding 3 (P1, REGRESSION) — that intent is expressed by
    // `reportingKilled`, NOT by `killed`. `killed` is set once and never
    // reset, and React StrictMode (the Next.js/CRA dev default) calls
    // `client.kill()` from provider.tsx's simulated unmount — so under every
    // StrictMode host `killed` is permanently true for a LIVE Provider. The
    // remount's `__rebindCrumbHooks()` revived the reporter and the crash sink
    // (round-1 findings 1/2) but not this listener, which stayed gated
    // forever: a report queued while offline never drained on reconnect, in
    // the PUBLISHED `@everframe/react`, for the whole of a dev session.
    //
    // `reportingKilled` is exactly "no live host mount owns this adapter, or
    // the host pulled the consent switch": `onKill()` sets it and ONLY
    // `__rebindCrumbHooks()` clears it, which only a live mount calls. So a
    // genuine `kill()` (never followed by a rebind) still cannot drain, and a
    // Provider unmounted for real — which also never rebinds — still cannot.
    // Same flag `__openReporter` and `crashSink` already consult, for the same
    // reason; the three "produces or ships a report" paths now agree.
    if (reportingKilled) return;
    try {
      void drainCallback();
    } catch {
      /* swallow — DEFE-02 */
    }
  };

  // Breadcrumbs — late-bound sink into the sdk-core client's buffer. The
  // Provider binds it right after createClient; until then events drop
  // silently (DEFE-02: capture must never throw into the host app).
  let breadcrumbBufferGet: (() => BreadcrumbBuffer | undefined) | undefined;
  const crumbSink: CrumbSink = (input) => {
    // Codex round-3, the breadcrumb half of the enumeration. THE crumb
    // admission gate: every web crumb producer (console, uncaught errors,
    // navigation, lifecycle, taps) reaches the sdk-core chain through this one
    // function, via the stable `forwardingCrumbSink`. sdk-core's `kill()`
    // CLEARS the chain once but leaves the buffer willing to accept more
    // (`buffer.clear()`, not `buffer.kill()` — that asymmetry is deliberate
    // there and out of bounds here), so without this the taps and navigations
    // of a user who withdrew consent kept accumulating in memory.
    //
    // `reportingKilled`, not `killed`: a StrictMode remount re-claims the
    // adapter through `__rebindCrumbHooks()` and must get its crumbs back —
    // that is what sdk-react's breadcrumbs-strictmode.spec.tsx asserts.
    if (reportingKilled) return;
    try {
      breadcrumbBufferGet?.()?.add(input);
    } catch {
      /* swallow — DEFE-02 */
    }
  };

  // Network bodies — late-bound the SAME way as breadcrumbs (spec 2026-07-18
  // §7). The dedicated body buffer lives in sdk-core client state next to the
  // crumb chain; the Provider binds this getter right after createClient so the
  // body sink + byte-budget reach the same instance that shares the crumb
  // freeze/clear lifecycle. Until bound, adds drop silently (DEFE-02).
  let networkBodiesBufferGet: (() => NetworkBodyBuffer | undefined) | undefined;

  // Reporter identity recognition (spec 2026-08-06) — late-bound the SAME way
  // as breadcrumbs/networkBodies above: the holder lives in sdk-core client
  // state, which doesn't exist yet when this adapter is constructed. Until
  // the Provider binds it, `__identityTokenReader` below resolves null (same
  // as "no token was ever set").
  let identityTokenHolderGet: (() => IdentityTokenHolderLike | undefined) | undefined;

  // Self-declared recognition (spec 2026-08-12) — bound by the Provider right
  // after createClient, same as the holder above. Undefined until then (and in
  // adapter-only unit tests), which reads as "no user set".
  let userGet: (() => UserMetadata | null) | undefined;
  /**
   * Read the host's live `setUser` value, never throwing. Every consumer is on
   * a path (the crash sink) where an exception would cost the whole report, so
   * the failure mode is "anonymous", exactly like no user having been set.
   */
  const readUser = (): UserMetadata | null => {
    try {
      return userGet?.() ?? null;
    } catch {
      return null;
    }
  };

  // REPLAY-02/04/05/06 — session-replay wiring. The fail-closed config provider
  // (sdk-core) decides ON/OFF; the rrweb recorder (lazy-loads rrweb only when
  // start() runs); the lifecycle state machine binds them. With replay OFF (the
  // default) the recorder never imports rrweb → ~0 KB always-loaded cost.
  let replayLifecycle: ReplayLifecycle | undefined;
  let replayRecorder: ReplayRecorder | undefined;
  let uninstallDebugSeam: (() => void) | undefined;
  let debugSeamSources: ReplayDebugSources | undefined;
  let initReplay: () => Promise<void> = async () => undefined;
  let refreshConfigNow: () => Promise<void> = async () => undefined;
  // Hoisted so breadcrumbs and replay share one instance (and one /api/config fetch).
  let configProvider: ReturnType<typeof createConfigProvider> | undefined;

  // Report Resource Window (spec 2026-09-05, Task 9) — created lazily in
  // applyLiveConfig the first time the server's `resources.enabled` block
  // comes back true, and torn down (both here and in onKill()) the moment it
  // flips false or the adapter is killed. `resourceRing` is what `windowMs()`
  // below reads LIVE (not baked in at construction) so a config refresh that
  // changes `windowSec` mid-session takes effect without a restart — same
  // contract as `replayDurationSec`.
  let resourceRing: ResourceRing | undefined;
  let stopResourceSampler: (() => void) | undefined;

  // Reporter identity recognition (spec 2026-08-06) — the ONE reader every
  // submit/reporter-API call site in this adapter (and, via
  // `__identityTokenReader`, provider.tsx + the companion capture bridge)
  // shares. Reads `configProvider` and `identityTokenHolderGet` LAZILY on
  // every call — not captured at construction time — because both are bound
  // AFTER this point in construction (config provider a few lines down;
  // the holder getter only once the Provider calls `__setIdentityTokenHolder`
  // post-`createClient`). Gated on `identity.enabled` so a project with no
  // signing secret never invokes the host's `setIdentityToken` provider —
  // that gate is enforced HERE, once, rather than at every call site.
  const identityTokenReader: IdentityTokenReader = {
    async get(now: number): Promise<string | null> {
      if (!configProvider || !isIdentityEnabled(configProvider.get())) return null;
      const holder = identityTokenHolderGet?.();
      if (!holder) return null;
      try {
        return await holder.get(now);
      } catch {
        // Belt-and-braces — the holder itself never throws, but this call
        // site must never let identity work fail a submit/reporter call.
        return null;
      }
    },
  };

  // PR review, round 3 (Serious, crash-sink half) — cache-only counterpart to
  // `identityTokenReader` above, gated the SAME way (identity.enabled + a
  // bound holder) but built on `IdentityTokenHolder.peek()` instead of
  // `get()`: synchronous, never invokes the host's provider, never awaits
  // anything.
  function peekIdentityToken(): string | null {
    if (!configProvider || !isIdentityEnabled(configProvider.get())) return null;
    const holder = identityTokenHolderGet?.();
    if (!holder) return null;
    try {
      return holder.peek(Date.now());
    } catch {
      // Belt-and-braces, same as identityTokenReader above.
      return null;
    }
  }

  // Task 11 (round-2 finding 3) — implements `__identityTokenPending` (see its
  // interface doc). Same gate as `peekIdentityToken` above, for the same
  // reason: identity being OFF for the project means the verified tier is not
  // in play at all, so the self-declared block must not be withheld.
  function identityTokenPending(): boolean {
    if (!configProvider || !isIdentityEnabled(configProvider.get())) return false;
    const holder = identityTokenHolderGet?.();
    if (!holder) return false;
    try {
      return holder.hasUnresolvedSource?.(Date.now()) === true;
    } catch {
      // Belt-and-braces, same as the two readers above.
      return false;
    }
  }

  // Used ONLY by the crash sink below to capture "the subject that was live
  // at crash time" with zero added latency and no durability trade-off —
  // see that call site's comment for why reading first (instead of after
  // `outbox.enqueue()`, as this file used to) is now safe.
  function peekIdentitySubject(): string | null {
    const token = peekIdentityToken();
    return token ? decodeSub(token) : null;
  }

  // PR review, round 4 (Serious) — implements
  // `__captureIdentityAtSubmitBoundary` (see its interface doc above): try
  // the free, synchronous `peekIdentityToken()` first; only fall back to a
  // real (bounded, never-throwing) `identityTokenReader.get()` call when the
  // cache is genuinely cold. Exported on the adapter so BOTH entry points
  // into report submission — provider.tsx's `onComplete` and
  // capture-bridge.ts's `runCompanionSubmit` — share the identical
  // gate+peek+bounded-fallback logic instead of each reimplementing it.
  async function captureIdentityAtSubmitBoundary(): Promise<string | null> {
    const cached = peekIdentityToken();
    if (cached !== null) return cached;
    try {
      return await identityTokenReader.get(Date.now());
    } catch {
      return null;
    }
  }

  // External review, finding 1 (Serious) — implements
  // `__captureUserAtSubmitBoundary` (see its interface doc above). Reads the
  // SAME live getter the crash sink uses (`readUser`, bound by the Provider
  // post-`createClient`), snapshots it, and hands back a clone. No config
  // gate: unlike the identity token this is a plain host-supplied label, not a
  // credential the server has to be configured to verify.
  function captureUserAtSubmitBoundary(): UserMetadata | null {
    return captureUserSnapshot(readUser);
  }

  // F18 (round-4 review) — periodic forced re-read so the remote kill-switch
  // (captureBodies:false) can actually reach a live session instead of only
  // ever being read once at __initReplay(). Cadence matches the config TTL
  // (mirrors iOS ReplaySession.refreshLoopInterval / ac39a9c9's periodic
  // loop): every tick forces the fetch (bypassing the provider's own TTL
  // gate) rather than letting it race, which would otherwise halve the
  // effective poll rate.
  const PERIODIC_REFRESH_MS = DEFAULT_CONFIG_TTL_MS;
  let periodicRefreshTimer: ReturnType<typeof setInterval> | undefined;
  // F18 — true whenever the MOST RECENT periodic (forced) refresh attempt
  // failed or came back malformed. Deliberately narrower than "use the
  // cached config": a failed READ must fail the body-capture gate CLOSED
  // even though the last-good cache might still say captureBodies:true —
  // we cannot confirm the server hasn't flipped the kill switch in the
  // interim, so assume the worst for THIS gate specifically. Replay /
  // breadcrumb config are unaffected — they keep the provider's ordinary
  // last-good semantics (mirrors iOS's refreshConfigNow(), ac39a9c9 F5:
  // "fails the network-body gate closed on a failed fetch instead of
  // blindly re-arming off a stale last-good cache, while breadcrumb/replay
  // config keep their existing last-good semantics"). Reset to false the
  // moment a subsequent read DOES succeed.
  let bodyGateFailedClosed = false;

  // F32 (round-7 review) — `setInterval` fires on a fixed cadence regardless
  // of whether the PREVIOUS tick's `refresh()` has resolved yet, and the
  // provider bounds each fetch with a timeout equal to this same interval —
  // so, without this guard, a slow tick can still be in flight when the next
  // one fires. `createConfigProvider`'s own request-sequence guard (F32) is
  // the actual correctness fix — it guarantees an older-started fetch can
  // never overwrite a newer one's result no matter how ticks overlap — but
  // skipping an overlapping tick here too avoids piling up redundant
  // concurrent network calls, which is wasted work with no upside now that
  // an older one could never win anyway.
  let periodicTickInFlight = false;

  function stopPeriodicRefresh(): void {
    if (periodicRefreshTimer !== undefined) {
      clearInterval(periodicRefreshTimer);
      periodicRefreshTimer = undefined;
    }
  }

  // Re-apply server-driven buffer sizing (breadcrumb maxCount + body buffer
  // byte budget). Hoisted like `initReplay` so both `__applyBreadcrumbsConfig`
  // (the existing one-shot call, after __initReplay()) and the periodic
  // refresh tick below (F18, on every SUCCESSFUL re-read) drive the exact
  // same logic — one implementation, not two copies drifting apart.
  let applyLiveConfig: () => void = () => undefined;

  // Codex round-2 fix — the "a fresh, validated read supersedes any earlier
  // failed-closed posture" reset the periodic tick's success branch performs
  // (see bodyGateFailedClosed's own doc comment above), extracted so the
  // `refreshGate` success path (Codex round-1 fix C, threads.wake()) gets
  // the SAME reset instead of leaving bodies disabled for up to
  // PERIODIC_REFRESH_MS after a successful wake refresh already reconfirmed
  // a live, ON config. Closes over `applyLiveConfig`/`bodyGateFailedClosed`
  // by reference, not by value — safe even though `applyLiveConfig` above is
  // still its no-op placeholder at this point in the function, since both
  // call sites only ever invoke this AFTER the replay `if` block below has
  // reassigned it.
  const onSuccessfulRefresh = (): void => {
    bodyGateFailedClosed = false;
    applyLiveConfig();
  };

  /**
   * Re-attempt the replay start against the CURRENT config cache. A guarded
   * no-op once buffering, so every path that resolves config can call it
   * unconditionally — including one whose own refresh returned false, since a
   * concurrent refresh may have committed a newer ON config in the meantime.
   *
   * Field bug 2026-08-27: this used to run only from `__initReplay` and the
   * 5-minute periodic tick, so a boot read that fell closed left replay off
   * for the first five minutes of the session while every report filed in that
   * window shipped without one.
   */
  const attemptReplayStart = (): void => {
    // Codex round-4 finding 2 (P1) — `reportingKilled`, NOT `killed`, for the
    // reason spelled out at that flag's declaration: provider.tsx kills a LIVE
    // client from an effect cleanup, so under React StrictMode `killed` is
    // permanently true for a Provider that is up and running. Gating here on
    // it meant the remount's `__initReplay()` refused to arm the window and
    // every report from the committed mount shipped without a replay — the
    // recorder's own latch (revived by `__rebindCrumbHooks()` below) is only
    // half the path; this is the other half.
    //
    // The consent switch is unaffected: a genuine `client.kill()` is never
    // followed by a rebind, so `reportingKilled` stays true and a config tick
    // still in flight cannot re-arm rrweb.
    if (reportingKilled) return;
    try {
      replayLifecycle?.tryStart();
    } catch {
      /* swallow — DEFE-02 */
    }
  };

  if (_config.disabled !== true) {
    const baseConfigUrl = `${INGEST_URL.replace(/\/$/, '')}/api/config`;
    // Task 6/7 (MAI meter, web SDK), retrofitted by Plan 2b-ii. The identifier
    // is resolved by the provider on EVERY fetch instead of being baked into
    // the URL here: this block used to run once at adapter construction, so a
    // baked value rode every five-minute refetch for the adapter's whole
    // lifetime and the per-UTC-day gate could never take effect.
    //
    // Opt-out (`installIdentifier.disabled`) is honoured by NOT BUILDING a
    // supplier at all, so nothing is derived, stored, or sent — the same
    // "compute nothing" posture the baked version had.
    //
    // `makeWebInstallIdSupplier` never throws and `createConfigProvider`
    // swallows a throw anyway; both belts stay fastened because this URL feeds
    // the SDK's remote kill switch.
    const installIdProvider =
      _config.installIdentifier?.disabled === true
        ? undefined
        : makeWebInstallIdSupplier(_config.apiKey);

    configProvider = createConfigProvider({
      fetchImpl:
        typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (async () => {
          throw new Error('no fetch');
        }),
      configUrl: baseConfigUrl,
      apiKey: _config.apiKey,
      ...(installIdProvider ? { installIdProvider } : {}),
      // Capability negotiation (spec 2026-08-01 §4.3 networkBodies; two-way
      // replies; reporter identity recognition, spec 2026-08-06; dashboard
      // companion badge override, plan 2026-08-25; reporter branding, spec
      // 2026-08-25; session vitals, spec 2026-09-01; report resource window,
      // spec 2026-09-05; dashboard report hotkey): declare ALL EIGHT tokens so
      // the server emits every
      // feature-gated config block on this one shared /api/config fetch.
      // Omitting 'identity' here means the server never sends the `identity`
      // block at all — `identity.enabled` stays undefined forever with
      // nothing in the logs to explain why; the same is true of
      // `companionbadge`, `branding`, `vitals`
      // (`vitalsEnabled`/`vitalsSampleRate` would stay undefined forever),
      // and now `resources` — without this token `resources.enabled` stays
      // undefined forever and the whole feature is silently, permanently
      // off with every test still green.
      sdkFeatures: [
        'replies',
        'networkbodies',
        'identity',
        'companionbadge',
        'branding',
        'vitals',
        'resources',
        'reporthotkey',
      ],
    });
    const provider = configProvider;
    const recorder = createReplayRecorder({
      sensitiveElements: () => sensitiveRegistry.snapshotElements(),
      ...(_config.redaction ? { redaction: _config.redaction } : {}),
    });
    const lifecycle = createReplayLifecycle({
      adapter: { replay: recorder },
      getConfig: (): ReplayConfig => provider.get(),
      locallyDisabled: _config.sessionReplay?.disabled === true,
    });
    replayLifecycle = lifecycle;
    replayRecorder = recorder;

    applyLiveConfig = (): void => {
      // Codex round-1 fix B, finding 2 (partial by ruling — no owner/
      // generation-aware writes) — a killed adapter must never re-apply
      // config: `refreshGate` (Fix C, below) and the periodic tick both call
      // this after an awaited fetch, and `killed` can flip true while that
      // fetch was in flight. Without this guard a dead adapter's stale read
      // could still write the shared companion-badge box (and breadcrumb/
      // body-buffer config) after teardown, outliving the client that owned
      // it.
      if (killed) return;
      try {
        applyBreadcrumbsConfigToBuffer(breadcrumbBufferGet?.(), breadcrumbsConfig());
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        const bodiesCfg = getNetworkBodiesConfig(provider.get());
        networkBodiesBufferGet?.()?.setByteBudget(bodiesCfg.bodyTotalBudget);
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        __setCompanionBadgeServerConfig(getCompanionBadgeServerConfig(provider.get()));
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        __setBrandingServerConfig(getBrandingServerConfig(provider.get()));
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        publishReportHotkey(
          provider.get().reportHotkey?.binding ?? DEFAULT_REPORT_HOTKEY_BINDING,
        );
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        // Session Vitals (spec 2026-09-01, Task 8). Per-field lenient — an
        // old server that omits both fields (or Task 11 not yet deployed)
        // must degrade to disabled, never throw. Unlike branding/companion-
        // badge this box always holds a fully-defaulted pair rather than the
        // raw (possibly-absent) server block; see vitals/server-config.ts's
        // header for why.
        const cfg = provider.get();
        __setVitalsServerConfig({
          vitalsEnabled: cfg.vitalsEnabled ?? false,
          vitalsSampleRate: typeof cfg.vitalsSampleRate === 'number' ? cfg.vitalsSampleRate : 1,
        });
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        // Report Resource Window (spec 2026-09-05, Task 9) — capability-
        // negotiated ('resources' in sdkFeatures above); fail closed to OFF
        // on an absent/malformed block (getResourcesServerConfig already
        // degrades a malformed one to undefined at the schema, see
        // sdk-core's ResourcesServerConfig).
        const enabled = getResourcesServerConfig(provider.get())?.enabled === true;
        if (enabled && !resourceRing) {
          // windowMs() is read LIVE on every ring.snapshot() call, not
          // captured here — a later config refresh that changes windowSec
          // takes effect immediately with no restart, mirroring how
          // replayDurationSec is re-read live off the config provider.
          const ring = createResourceRing({
            windowMs: () =>
              (getResourcesServerConfig(provider.get())?.windowSec ??
                DEFAULT_RESOURCE_WINDOW_SEC) * 1000,
          });
          resourceRing = ring;
          stopResourceSampler = startResourceSampler({ onSample: (s) => ring.push(s) });
          __setActiveResources(ring);
        } else if (!enabled && resourceRing) {
          // Same shape as the kill path (F5, ~line 1850): the stamp box is
          // neutered FIRST and in its OWN try, before anything that can
          // throw, and every throwable call gets a try of its own.
          //
          // These four statements used to share ONE try — the enclosing
          // DEFE-02 catch below — with the THROWABLE call leading:
          // `stopResourceSampler?.()`'s disposer calls `observer?.disconnect()`
          // unguarded (resources/sampler.ts). A throw there skipped all three
          // zeroizations, so `__getActiveResources()` kept pointing at a live
          // ring and reports kept being stamped with resource samples after
          // the server had set `resources.enabled: false` — the feature stayed
          // ON for a customer who had explicitly turned it OFF. Ordering the
          // stamp box first makes the observable state correct even if the
          // teardown below fails outright.
          try {
            __setActiveResources(undefined);
          } catch {
            /* swallow — DEFE-02 */
          }
          try {
            resourceRing?.clear();
          } catch {
            /* swallow — DEFE-02 */
          }
          try {
            stopResourceSampler?.();
          } catch {
            /* swallow — DEFE-02 */
          }
          stopResourceSampler = undefined;
          resourceRing = undefined;
        }
      } catch {
        /* swallow — DEFE-02 */
      }
    };

    const periodicRefreshTick = async (): Promise<void> => {
      if (killed) return;
      // F32 — skip this tick entirely if the previous one is still in
      // flight rather than piling on a second overlapping fetch. This is a
      // cheap improvement on top of the provider's own request-sequence fix
      // (which is what actually guarantees correctness even when overlap
      // does happen, e.g. the initial __initReplay() refresh racing the
      // first periodic tick) — never rely on this flag alone for ordering.
      if (periodicTickInFlight) return;
      periodicTickInFlight = true;
      let success = false;
      try {
        try {
          success = await provider.refresh({ force: true });
        } catch {
          success = false; // provider.refresh() never throws, but never trust it blindly
        }
        // F17/F18 composition: a kill() landing while THIS forced fetch was
        // in flight must not be followed by a stale re-arm — re-check
        // synchronously, before touching any shared state below, mirroring
        // iOS ReplaySession.refreshConfigNow()'s post-await epoch re-check
        // (7a047bdd F13). There is no epoch counter here because web has no
        // "restart after kill" — one boolean is enough once it can never be
        // unset.
        if (killed) return;
        if (success) {
          // A fresh, validated read supersedes any earlier failed-closed
          // posture — this is exactly the "captureBodies flips back on"
          // case the periodic loop exists to pick up.
          onSuccessfulRefresh();
        } else {
          bodyGateFailedClosed = true;
        }
        // Outside the success branch on purpose: a superseded read returns
        // false while the request that superseded it may already have
        // committed an ON config.
        attemptReplayStart();
      } finally {
        periodicTickInFlight = false;
      }
    };

    const startPeriodicRefresh = (): void => {
      if (killed || periodicRefreshTimer !== undefined) return;
      periodicRefreshTimer = setInterval(() => {
        void periodicRefreshTick();
      }, PERIODIC_REFRESH_MS);
    };

    initReplay = async (): Promise<void> => {
      // Runs only for the adapter React actually committed, so this is where
      // the debug seam learns which instance is live (see debug/seam.ts).
      if (debugSeamSources) adoptReplayDebugSeam(debugSeamSources);
      try {
        await provider.refresh();
      } catch {
        /* fail-closed — keep OFF */
      }
      attemptReplayStart();
      startPeriodicRefresh();
    };

    refreshConfigNow = async (): Promise<void> => {
      let success = false;
      try {
        success = await provider.refresh({ force: true });
      } catch {
        success = false;
      }
      if (killed) return;
      if (success) {
        try {
          onSuccessfulRefresh();
        } catch {
          /* swallow — DEFE-02 */
        }
      }
      attemptReplayStart();
    };
  } else {
    // DEFE-03 — replay defaults to OFF when the SDK is disabled. Keep REPLAY_CONFIG_OFF
    // referenced so the fail-closed default is the documented contract.
    void REPLAY_CONFIG_OFF;
  }

  // Two-way replies (Task 8) — the thread client, gated on the SAME hoisted
  // configProvider instance (one /api/config fetch shared with replay +
  // breadcrumbs), a present device-credential store, and the local veto
  // (`replies.disabled`). Absent whenever any of those fail, which leaves
  // `tx.threads` inert per the sdk-core client contract.
  let threadClient: ThreadClient | undefined;
  if (configProvider && reporterCredentials && _config.replies?.disabled !== true) {
    const provider = configProvider;
    const reporterApi = createReporterApi({
      fetchImpl:
        typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (async () => {
          throw new Error('no fetch');
        }),
      baseUrl: INGEST_URL,
      apiKey: _config.apiKey,
      // Reporter identity recognition (spec 2026-08-06) — every /api/reporter/*
      // call (thread polling, replies, read receipts) presents the identity
      // token the same way ingest submits do. Already self-gated on
      // identity.enabled (see identityTokenReader above).
      identityToken: identityTokenReader,
    });
    threadClient = createThreadClient({
      api: reporterApi,
      credentials: reporterCredentials,
      // Same hoisted provider instance as replay/breadcrumbs — one /api/config fetch.
      isEnabled: () => isRepliesEnabled(provider.get()),
      // Finding 1 (round 5, PR review) — a deliberate wake() (visibility
      // return, a submit that provisioned a thread) must be able to
      // re-resolve the SAME hoisted config provider instance rather than
      // idling forever on a stale isEnabled()===false cache: replies turned
      // on server-side mid-session, or a mount-time config fetch that
      // transiently failed, would otherwise never be noticed without a
      // reload. force:true bypasses the provider's own 5-minute TTL gate.
      // provider.refresh() resolves a success boolean (F18/F32); refreshGate's
      // contract is Promise<void> — the thread client only cares that the
      // shared provider re-resolved, not whether THIS call's read won the
      // race, so the boolean is discarded here rather than widening
      // ThreadClientDeps.refreshGate's type.
      //
      // Codex round-1 fix C, finding 3 — a successful refresh here used to
      // leave badge/breadcrumb/body-budget config stale until the periodic
      // tick (≤5 min): a visibility/wake refresh re-resolves the shared
      // provider, but nothing downstream of THIS call site ever re-derived
      // the live config from it. Mirrors the periodic tick's own
      // success-gated `applyLiveConfig()` call above — via `onSuccessfulRefresh`
      // (Codex round-2 fix), which ALSO resets `bodyGateFailedClosed` the same
      // way the periodic branch does, so a wake refresh that lands after a
      // failed periodic refresh recovers immediately instead of leaving
      // bodies disabled until the next periodic tick. `onSuccessfulRefresh`
      // already carries the killed-guard (Fix B, via `applyLiveConfig`) and
      // swallows its own internal errors (DEFE-02); the try/catch here is
      // belt-and-braces in case a future change to it ever throws
      // synchronously.
      // Delegates to the same forced-refresh routine `__testRefreshConfigNow`
      // exposes, so the spec that covers this path covers THIS code, not a
      // parallel copy of it.
      refreshGate: () => refreshConfigNow(),
      // exactOptionalPropertyTypes: only set the key when a value is present —
      // `pollIntervalMs: undefined` is a type error against ThreadClientDeps.
      ...(_config.replies?.pollIntervalMs !== undefined
        ? { pollIntervalMs: _config.replies.pollIntervalMs }
        : {}),
    });
  }

  // Live breadcrumbs config — server block when resolved, spec defaults before
  // (and when the server omits the block: breadcrumbs are default-ON, the
  // deliberate contrast to replay's fail-closed OFF).
  const breadcrumbsConfig = (): BreadcrumbsConfig => {
    try {
      return configProvider ? getBreadcrumbsConfig(configProvider.get()) : BREADCRUMBS_CONFIG_DEFAULT;
    } catch {
      return BREADCRUMBS_CONFIG_DEFAULT;
    }
  };
  const crumbGate: KindGate = (kind) => {
    const cfg = breadcrumbsConfig();
    return cfg.enabled && cfg.kinds.includes(kind);
  };

  // Per-session sampling decision — drawn AT MOST ONCE, and only once capture
  // is server-enabled, so the draw uses the resolved samplingRate rather than
  // the fail-closed default (mirrors replay CONFIG-04 intent, fixed to not
  // draw before configProvider.refresh() has resolved).
  const bodySampler = createSessionSampler();
  let bodyReqId = 0;

  // F34 (round-7 review) — generation token, mirroring the native SDKs'
  // `NetworkBodyCaptureGate`/`NetworkBodyCaptureState` generation counter.
  // `bodyCaptureWasActive` records the LAST computed `enabled()` result so
  // `bodyCaptureSnapshot()` can detect a transition and bump
  // `bodyCaptureGeneration` — a caller (the fetch/XHR patchers in
  // network.ts) captures `(active, generation)` together at decision time,
  // BEFORE the async body read/redaction work, and hands the generation to
  // `networkBodyBuffer.add()`'s `guard`, which re-validates it right before
  // the actual insert. This is what makes a remote `captureBodies: false`
  // config refresh landing between the decision and the insert authoritative
  // at the sink boundary, even though JS's single-threaded execution makes
  // the actual insert itself trivially atomic once reached.
  let bodyCaptureGeneration = 0;
  let bodyCaptureWasActive = false;

  /** The `enabled()` predicate's actual logic, extracted so both `enabled()`
   * and `bodyCaptureSnapshot()` (which additionally tracks generation) share
   * ONE implementation — see those two below. */
  function computeBodyCaptureActiveNow(): boolean {
    // F17 (round-4 review): the client-kill signal is authoritative here,
    // not just a consequence of the buffer clearing once. Without this,
    // a still-installed fetch/XHR patcher keeps calling enabled() (and
    // getting `true` off the last-cached server config) for every request
    // issued after client.kill() — this is the reviewer's repro's OTHER
    // half (the buffer-level `kill()` in network-body-buffer.ts closes the
    // in-flight/already-past-this-check case; THIS closes the
    // straightforward post-kill case where a fresh request's enabled()
    // check runs after kill() already happened).
    if (killed) return false;
    // F18 (round-4 review): a failed/malformed periodic re-read fails
    // ONLY this gate closed — see bodyGateFailedClosed's doc comment for
    // why this is deliberately stricter than "fall back to the cached
    // config".
    if (bodyGateFailedClosed) return false;
    const cfg = configProvider ? getNetworkBodiesConfig(configProvider.get()) : undefined;
    const serverEnabled = cfg?.captureBodies ?? false;
    const rate = configProvider?.get().samplingRate ?? 0;
    const sampledIn = bodySampler(rate, serverEnabled);
    // F28: bodies require the SAME live breadcrumbs config already read by
    // `breadcrumbsConfig()` (server block, or BREADCRUMBS_CONFIG_DEFAULT
    // when unconfigured) to include the `network` kind — see
    // computeBodyCaptureEnabled's doc comment.
    const crumbs = breadcrumbsConfig();
    const crumbsExcludeNetwork = !crumbs.enabled || !crumbs.kinds.includes('network');
    return computeBodyCaptureEnabled(
      serverEnabled,
      _config.networkBodies?.disabled === true,
      sampledIn,
      crumbsExcludeNetwork,
    );
  }

  /** F34 — recompute active state and bump `bodyCaptureGeneration` on any
   * transition (in particular ON→OFF). Every call site (`enabled()`,
   * `generation()`, and the `sink()` re-validation below) goes through this
   * SAME function so `active` and `generation` can never be computed from
   * two different underlying reads. */
  function bodyCaptureSnapshot(): { active: boolean; generation: number } {
    const active = computeBodyCaptureActiveNow();
    if (active !== bodyCaptureWasActive) {
      bodyCaptureGeneration++;
      bodyCaptureWasActive = active;
    }
    return { active, generation: bodyCaptureGeneration };
  }

  // Body-capture hooks (spec 2026-07-18 §3/§6/§7) — read per-request so the
  // patchers react to live server config / sampling without reinstalling.
  const bodyCapture: BodyCaptureHooks = {
    enabled: (): boolean => bodyCaptureSnapshot().active,
    generation: (): number => bodyCaptureSnapshot().generation,
    config: (): { bodyByteCap: number; bodyContentTypes: string[] } => {
      const cfg = configProvider ? getNetworkBodiesConfig(configProvider.get()) : undefined;
      return {
        bodyByteCap: cfg?.bodyByteCap ?? 8192,
        bodyContentTypes: cfg?.bodyContentTypes ?? ['application/json', 'text/*'],
      };
    },
    redaction: () => _config.redaction ?? {},
    nextReqId: (): number => ++bodyReqId,
    sink: (entry, generation) => {
      try {
        // F34 — `generation` is undefined only for hand-rolled test doubles
        // that don't implement `BodyCaptureHooks.generation`; production
        // callers (network.ts's patchers) always pass the decision-time
        // token captured via `bodyCapture.generation()`, so this guard is
        // always installed on the real append path.
        networkBodiesBufferGet?.()?.add(
          entry,
          generation === undefined
            ? undefined
            : () => {
                const snap = bodyCaptureSnapshot();
                return snap.active && snap.generation === generation;
              },
        );
      } catch {
        /* swallow — DEFE-02 */
      }
    },
  };

  // Rebind the module-level forwarding slot (breadcrumbs.ts) to THIS adapter's
  // sink/gate. The install-once patchers below are wired to the stable
  // forwardingCrumbSink/forwardingCrumbGate, never to crumbSink/crumbGate
  // directly, so a Provider remount (StrictMode double-invoke, Fast Refresh)
  // re-points already-installed patchers at the live adapter instead of
  // leaving them wired to a dead one.
  __bindCrumbHooks(crumbSink, crumbGate);
  // F37 (round-8 review) — same doctrine for network-body capture
  // (network.ts). The install-once fetch/XHR patchers below are wired to the
  // stable forwardingBodyCaptureHooks object, never to `bodyCapture` directly,
  // so a Provider remount re-points them at the live adapter's body buffer
  // instead of leaving them permanently wired to a killed/unmounted one — the
  // production teardown path (`onKill()` below) only flips THIS adapter's own
  // `killed` flag; it must never uninstall the page-global patchers, so
  // without this rebind every request after the first remount silently
  // stopped capturing bodies for the rest of the page.
  __bindBodyCaptureHooks(bodyCapture);

  // Crash/error reporting (spec 2026-07-18): on by default, client-veto off.
  // Gated on BOTH the SDK-wide disable and the crashReporting-specific veto —
  // an uncaught error must never become an unattended report when either is set.
  const crashThrottle = createCrashThrottle();
  // Explicit reporting must not exhaust the automatic error safety net.
  const handledThrottle = createCrashThrottle();
  const capturedErrors = new WeakSet<object>();
  let handlingCrash = false; // re-entrancy latch — a crash inside crash capture must not recurse
  const crashSink =
    _config.disabled === true || _config.crashReporting?.disabled === true
      ? undefined
      : (
          error: unknown,
          mechanism: 'onerror' | 'unhandledrejection' | 'captureException',
          captureOptions?: CaptureExceptionOptions,
        ): void => {
          // Codex round-1 finding 2 (P1, kill switch) — a DEAD adapter must not
          // report crashes. The module-level forwarding slot below deliberately
          // survives teardown (see `__bindCrashSink`'s rebind doctrine: the
          // window.onerror patcher is install-once and page-global, so it has
          // to keep pointing at SOMETHING), but "the forwarder survives" is not
          // "the client is alive": after `kill()` — the host's consent / GDPR
          // switch — this sink still built an envelope, wrote it to the
          // origin-wide outbox and POSTed it, which is precisely the pixel a
          // killed client promises never to send. sdk-core's `kill()` has
          // already zeroized crumbs, user and identity by the time `onKill()`
          // flips this flag, so the envelope was going out stripped of exactly
          // the context that would have made it useful anyway.
          //
          // This is the FIRST check on purpose: it must hold even for a crash
          // that arrives before `handlingCrash`/throttle state is consulted.
          if (reportingKilled) return;
          const ownership = reportingOwnership;
          const stillOwned = (): boolean =>
            !reportingKilled && reportingOwnership === ownership;
          const crashRedaction = _config.redaction ?? {};
          // Whenever crashSink is defined (this branch), `_config.disabled !== true`,
          // so `outbox` (created a few lines above under the same guard) is always
          // defined here too. Re-narrow into a local so the .then() closure below
          // doesn't see the outer `OutboxAdapter | undefined` widening.
          if (!outbox) return;
          const ob = outbox;
          if (handlingCrash) return;
          handlingCrash = true;
          try {
            const errorObject = error !== null && (typeof error === 'object' || typeof error === 'function')
              ? error : undefined;
            // A framework handler may report and then rethrow the same object.
            // The first accepted capture determines its classification.
            if (errorObject && capturedErrors.has(errorObject)) return;
            const handled = mechanism === 'captureException';
            const facts = extractCrashFacts(error);
            if (!stillOwned()) return;
            let causeChain;
            try {
              causeChain = extractCrashCauseChain(
                error,
                value => redactStringContent(value, crashRedaction),
                stillOwned,
              );
            } catch {
              // Causes are optional evidence. A hostile link must not discard
              // an otherwise valid outer crash capture.
              causeChain = undefined;
            }
            if (!stillOwned()) return;
            // Same exactOptionalPropertyTypes friction sdk-core's own build.ts
            // hits at this call boundary (CrashFrame's Zod-passthrough optional
            // props vs. computeCrashFingerprint's plain-literal param type) —
            // cast at the boundary rather than reshaping CrashFrame.
            const fingerprint = computeCrashFingerprint(
              facts.exceptionType,
              facts.frames as ReadonlyArray<{ raw: string; function?: string; file?: string }>,
            );
            const device = getDeviceMetadataImpl();
            if (!stillOwned()) return;
            const { envelope } = buildCrashEnvelope({
              facts,
              ...(causeChain ? { causeChain } : {}),
              mechanism,
              source: 'error', // web page survives uncaught errors
              handled,
              fatal: false,
              occurredAt: new Date().toISOString(),
              reportId: generateReportId(),
              submittedAt: new Date().toISOString(),
              sdk: {
                name: sdkName,
                version: sdkVersion,
                platform: 'web',
                formFactor: inferFormFactor(device),
              },
              breadcrumbs: breadcrumbBufferGet?.()?.snapshot() ?? [],
              device,
              app: {
                name: _config.appName ?? 'unknown',
                version: _config.appVersion ?? '0.0.0',
                ...(_config.appBuild !== undefined ? { build: _config.appBuild } : {}),
              },
              ...(typeof window !== 'undefined' ? { route: window.location.pathname } : {}),
              redaction: crashRedaction,
              ...(captureOptions === undefined ? {} : { captureOptions }),
              // Self-declared recognition (spec 2026-08-12). Read HERE, at
              // crash time, from the live getter — the same instant the
              // identity subject is captured a few lines below, and for the
              // same reason: it must be whoever was signed in when the app
              // threw. Never throws; a crash sink that can fail is worse than
              // an anonymous crash report.
              //
              // External review, finding 1 (Serious) — goes through
              // `captureUserSnapshot` (the same helper the report and
              // companion submit boundaries use) rather than `readUser()`
              // directly, so the crash path projects to `{id, email,
              // displayName}` by the same construction they do. `setUser`
              // already projects on the way in, but the getter bound here is
              // an adapter-level seam (`__setUserGetter`) that does not have
              // to be the client's — and a crash envelope is written straight
              // to a durable outbox, so it is the last place to rely on
              // someone else having sanitized.
              user: captureUserSnapshot(readUser),
            });
            if (!stillOwned()) return;
            // Session Vitals (spec 2026-09-01 §8), crash half (Codex round-1
            // finding S2) — `buildCrashEnvelope` never carried the sessionId
            // or the recent-vitals tail draft-to-envelope.ts's report path
            // has stamped since Task 8, so a crash occurring mid-vitals-
            // session shipped with neither, breaking the vitals↔crash
            // correlation the dashboard relies on. Same live-read/cap
            // doctrine as the report path, factored into one shared helper
            // so the two call sites cannot drift on the
            // MAX_ENVELOPE_VITALS_ENTRIES cap.
            stampActiveVitals(envelope);
            if (!stillOwned()) return;
            // Report Resource Window (spec 2026-09-05, Task 9), crash half —
            // same live-read/cap doctrine as the report path's stamp call in
            // draft-to-envelope.ts, factored into the one shared helper so
            // the two call sites cannot drift on the MAX_RESOURCE_SAMPLES
            // cap. A DIFFERENT block from vitals above — Session Vitals is
            // untouched by this call.
            stampResources(envelope);
            if (!stillOwned()) return;
            const item: OutboxItem = {
              reportId: envelope.reportId,
              enqueuedAt: Date.now(),
              attempts: 0,
              payload: new TextEncoder().encode(JSON.stringify(envelope)),
              metadata: {
                url: `${INGEST_URL.replace(/\/$/, '')}/api/ingest`,
                sdkKey: _config.apiKey,
              },
            };
            // PR review, round 3 (Serious, crash-sink half) — capture the
            // subject BEFORE the enqueue, from cache only (`peekIdentitySubject`,
            // never the provider), so it reflects the identity that was live
            // AT CRASH TIME. This used to read AFTER `enqueue()` via the real
            // `identityTokenReader.get()`, reasoning that persisting first
            // matters most for a crash sink ("next launch" may never come for
            // a closed tab) and that reading first would trade durability for
            // a window that doesn't exist here (enqueue and drain are
            // milliseconds apart, not the ~31s retry burst
            // submitReportFromDraft has to survive). That reasoning about the
            // PROVIDER was correct, but the conclusion didn't have to follow:
            // `peek()` never calls the provider and never awaits anything, so
            // reading it first costs nothing and trades away nothing — the
            // enqueue below is still the very next line, still synchronous
            // with respect to everything before it. Capturing from the LIVE
            // holder cache (rather than reading async, moments later, after
            // whatever async work in this handler runs first) is also simply
            // more correct: it's the identity that was actually live when the
            // crash happened, not whatever happens to still be cached a beat
            // afterward.
            const crashTimeSubject = peekIdentitySubject();
            if (!stillOwned()) return;
            if (!(handled ? handledThrottle : crashThrottle).shouldReport(fingerprint)) return;
            if (errorObject) capturedErrors.add(errorObject);
            // Persist first (durable if the tab dies), then ship immediately —
            // "next launch" may never come for a closed tab.
            void (async () => {
              if (!stillOwned()) return;
              await ob.enqueue(item);
              if (!stillOwned()) {
                await discardEnqueuedReport(ob, item.reportId).catch(() => undefined);
                return;
              }
              // PR review Finding 2 (P1, 2026-08-06 identity spec) — this
              // enqueue bypasses submitReportFromDraft entirely, so it must
              // record its own enqueue-time subject the SAME way, or
              // drainOutbox (which drains this item moments later, below)
              // finds no record for it and always sends it anonymously —
              // even when the crash genuinely belongs to the currently
              // signed-in user this whole call site exists to recognize.
              recordEnqueuedIdentitySubject(item.reportId, crashTimeSubject);
              if (!stillOwned()) {
                await discardEnqueuedReport(ob, item.reportId).catch(() => undefined);
                return;
              }
              const result = await drainOutboxWhileOwned(
                {
                  outbox: ob,
                  config: _config,
                  sdkVersion,
                  credentials: reporterCredentials,
                  // Re-review Finding B — this was the fifth live call site
                  // still missing identityToken even though identityTokenReader
                  // is already in scope in this closure: a recognized user's
                  // app throwing shipped its OWN crash report (and every
                  // other queued item this drain happens to flush)
                  // anonymously, on exactly the surface where knowing who
                  // hit the crash matters most.
                  identityToken: identityTokenReader,
                },
                stillOwned,
              );
              if (!stillOwned()) {
                await discardEnqueuedReport(ob, item.reportId).catch(() => undefined);
                return;
              }
              // Round-6 PR-review Finding 2 (HIGH), gap flagged on re-review
              // — same class of bug as the mount/online drain trigger and
              // the post-submit drain in provider.tsx: this crash-sink
              // drain also discarded its result, so a crash report that
              // provisioned a thread never woke an idled poller until an
              // unrelated visibility transition. `threadClient` is the
              // SAME instance surfaced as `adapter.threads` — absent
              // whenever the shutdown/veto guards above (config disabled,
              // no reporterCredentials, local replies veto) apply, in
              // which case there is nothing to wake.
              if (stillOwned() && result.provisionedThreadIds.length > 0) {
                threadClient?.wake();
              }
            })().catch(() => undefined);
          } catch {
            /* swallow — DEFE-02 */
          } finally {
            handlingCrash = false;
          }
        };
  // Rebind the module-level crash-sink slot to THIS adapter (same StrictMode/
  // Fast-Refresh doctrine as __bindCrumbHooks above): installConsolePatcher is
  // install-once, so the patcher holds the stable forwardingCrashSink and this
  // bind re-points it at the live adapter's sink — or clears it (null) when
  // this adapter's config vetoes crash reporting, so a stale sink from an
  // earlier mount can't keep reporting against a dead outbox/throttle/config.
  __bindCrashSink(crashSink ?? null);

  // Plan 03-02 — install console + fetch + XHR patchers so the rolling buffers warm up
  // before the user opens the reporter. CONTEXT lock: "ring buffer initialized at SDK
  // init" — captures must reflect activity from BEFORE the report was triggered.
  // DEFE-03: when config.disabled === true, skip patching entirely.
  if (_config.disabled !== true) {
    // Codex round-3 finding 1 (P1) — CLAIM (not "resize"): this drops whatever
    // the previous instance left in the page-global buffers and re-opens
    // admission for this one. See `__claimCaptureBuffers`.
    __claimCaptureBuffers(
      _config.console?.maxEntries ?? 100,
      _config.network?.maxEntries ?? 100,
    );
    uninstallers.push(
      installConsolePatcher({
        ...(_config.console?.levels ? { levels: _config.console.levels } : {}),
        crumbSink: forwardingCrumbSink,
        crumbGate: forwardingCrumbGate,
        crashSink: forwardingCrashSink,
      }),
    );
    uninstallers.push(
      installFetchPatcher({
        crumbSink: forwardingCrumbSink,
        crumbGate: forwardingCrumbGate,
        bodyCapture: forwardingBodyCaptureHooks,
      }),
    );
    uninstallers.push(
      installXHRPatcher({
        crumbSink: forwardingCrumbSink,
        crumbGate: forwardingCrumbGate,
        bodyCapture: forwardingBodyCaptureHooks,
      }),
    );
    uninstallers.push(installNavigationCrumbs(forwardingCrumbSink, forwardingCrumbGate));
    uninstallers.push(installLifecycleCrumbs(forwardingCrumbSink, forwardingCrumbGate));
    uninstallers.push(
      installTapCrumbs(forwardingCrumbSink, forwardingCrumbGate, () => sensitiveRegistry.snapshotElements()),
    );

    // PIPE-02 — install window 'online' drain listener; plan 03-07 wires the actual drain.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('online', onOnline);
      const off = (): void => window.removeEventListener('online', onOnline);
      uninstallers.push(off);
      // ALSO tracked separately: unlike every other entry in `uninstallers`,
      // this listener is per-adapter rather than an install-once page-global
      // patcher, so it is the one thing a production teardown has to remove.
      // See `__uninstallWindowListeners`.
      ownWindowListenerUninstallers.push(off);
    }
  }

  const adapter = {
    captureException: (error: unknown, options?: CaptureExceptionOptions): void =>
      crashSink?.(error, 'captureException', options),
    // ── The capture primitives ────────────────────────────────────────────
    //
    // Codex round-3 findings 2 and 4. These four are THE choke point for
    // reading the user's device: every in-process caller (sdk-core's report
    // flow, ReporterDialog's initial capture and its add-a-shot re-capture)
    // and every phone-companion caller (`report.request`'s full bundle, the
    // preview loop's 2 fps frames, the shot stash's full-res captures) goes
    // through this object. Gating them here is what makes "after kill(),
    // nothing is captured" true for the companion's async loops as well —
    // a preview loop STARTED before the switch was pulled keeps ticking, and
    // its tick lands here.
    //
    // `reportingKilled` (revivable by a live mount's `__rebindCrumbHooks()`),
    // for the same StrictMode reason `__openReporter` and `crashSink` use it:
    // provider.tsx's simulated unmount calls `client.kill()` on a LIVE
    // Provider, and a never-reset flag would leave the reporter unable to
    // screenshot anything in every Next.js dev app.
    captureScreenshot: () => {
      // REJECTS rather than resolving an empty result: every caller already
      // has a failure path for a screenshot that cannot be taken (the dialog
      // shows its capture error, the companion answers `report.failed` /
      // `shot.failed`, the preview loop stops with `capture_unavailable`), and
      // a synthetic blank image would be indistinguishable from a real capture
      // of a blank page.
      if (reportingKilled) {
        return Promise.reject(
          new Error('Everframe: capture is disabled — kill() was called on this client.'),
        );
      }
      return captureScreenshot({
        root: typeof document !== 'undefined' ? document.body : (undefined as unknown as HTMLElement),
        ...(_config.cspNonce !== undefined ? { cspNonce: _config.cspNonce } : {}),
        // Live-DOM masking (Element-based) — the renderer sees pre-blacked
        // elements in its clone, so masks land at the exact pixel position
        // by construction. Replaces the previous rect-based maskPlan whose
        // viewport→PNG coordinate transform was brittle on phones (subpixel
        // rounding, font-metric drift, modal-open layout shifts).
        maskTargets: sensitiveRegistry.snapshotElements(),
        __setDegradedReason: (r: DegradedReason) => {
          lastDegradedReason = r;
        },
      });
    },
    captureFocusedNode: (): FocusedNode | null =>
      reportingKilled ? null : captureFocusedNodeImpl(),
    // These two read the page-global ring buffers, which `onKill()` has also
    // stopped ADMITTING writes to (`__setCaptureAccepting(false)`). Both gates
    // are load-bearing and neither subsumes the other: the admission gate stops
    // new entries accumulating, this one stops a killed client reading out
    // whatever was captured lawfully BEFORE the switch was pulled.
    captureRecentLogs: (): LogEntry[] => (reportingKilled ? [] : getLogsSnapshot()),
    captureRecentNetwork: (): NetworkEntry[] => (reportingKilled ? [] : getNetworkSnapshot()),
    // DELIBERATELY UNGATED, and the only one of the five that is. This reads
    // `navigator` / `screen` / `Intl` on demand and retains nothing: there is
    // no buffer to stop filling and no stored artifact to withhold. It is also
    // the one primitive with a non-nullable return type whose callers have no
    // "absent" branch. Every path that could ever SHIP it — the in-app submit,
    // the outbox drain, the crash sink, the companion submit — is gated
    // upstream, so a killed client computing a device block that nothing can
    // send costs nothing and keeps this signature honest.
    getDeviceMetadata: (): DeviceMetadata => getDeviceMetadataImpl(),
    registerTrigger: (_handler: () => void) => () => undefined,
    showReporterUI: (_draft: ReportDraft) =>
      new Promise<ReportDraft | null>((resolve) => {
        pendingResolve = resolve;
        // Trigger the modal directly — don't reuse __openReporter() here because
        // that path creates the public-facing Promise<ReporterResult> for
        // `useEverframe().open()`. sdk-core's report() flow is a distinct caller
        // and resolves separately via __resolveReporterUI.
        try {
          showModal();
        } catch {
          /* swallow — DEFE-02 */
        }
      }),
    resolveSensitiveRects: (): Rect[] => sensitiveRegistry.snapshot(),
    applyMaskPlan: (image: Blob, plan: Rect[]): Promise<Blob> =>
      applyMaskRectsToBlob(image, plan),
    ...(outbox ? { outbox } : {}),
    ...(reporterCredentials ? { reporterCredentials } : {}),
    ...(threadClient ? { threads: threadClient } : {}),
    __identityTokenReader: identityTokenReader,
    __captureIdentityAtSubmitBoundary: captureIdentityAtSubmitBoundary,
    __captureUserAtSubmitBoundary: captureUserAtSubmitBoundary,
    __peekIdentityToken: peekIdentityToken,
    __identityTokenPending: identityTokenPending,
    __openReporter: (): Promise<ReporterResult> => {
      // Codex round-1 finding 1 (P1, kill switch) — a killed adapter must not
      // open the reporter. Every other capture path here is gated on `killed`
      // (bodyCapture.enabled, the periodic config refresh, the 'online' drain
      // listener, applyLiveConfig…); this one was not, so after `kill()` —
      // which hosts call for consent withdrawal or a GDPR erasure request —
      // `open()` still mounted the dialog, took a screenshot of the user's
      // screen and could submit it. That is the exact failure the kill switch
      // exists to prevent, and it shipped in `@everframe/react` from the first
      // release of this seam.
      //
      // RESOLVED, never left hanging: a promise that never settles is a host
      // bug generator (`await open()` in a click handler would deadlock the
      // handler's own cleanup forever). `'cancelled'` with a reason is the
      // shape this adapter already uses for every non-open outcome — see the
      // `'superseded'` settle immediately below and `ReporterResult`'s doc —
      // so a caller that already handles `status !== 'submitted'` needs no
      // change to handle a killed client.
      if (reportingKilled) {
        return Promise.resolve({ status: 'cancelled', reason: 'killed' });
      }
      // Settle any stale promise from a prior orphaned call (defensive — provider
      // resolves on modal close + submit complete, but if a caller invokes
      // __openReporter twice before the first resolves we don't want to dangle).
      if (pendingOpenResolve) {
        try {
          pendingOpenResolve({ status: 'cancelled', reason: 'superseded' });
        } catch {
          /* swallow — DEFE-02 */
        }
        pendingOpenResolve = undefined;
      }
      const p = new Promise<ReporterResult>((resolve) => {
        pendingOpenResolve = resolve;
      });
      try {
        showModal();
      } catch {
        /* swallow — DEFE-02 */
      }
      return p;
    },
    __registerShowModal: (cb: () => void): void => {
      showModal = cb;
    },
    __subscribeReportHotkey: (listener: (binding: string) => void): (() => void) => {
      reportHotkeyListeners.add(listener);
      try {
        listener(reportHotkeyBinding);
      } catch {
        /* swallow — DEFE-02 */
      }
      return () => reportHotkeyListeners.delete(listener);
    },
    __registerOutboxDrainTrigger: (cb: () => void | Promise<void>): void => {
      drainCallback = cb;
    },
    __resolveReporterUI: (draft: ReportDraft | null): void => {
      const r = pendingResolve;
      pendingResolve = undefined;
      try {
        r?.(draft);
      } catch {
        /* swallow — DEFE-02 */
      }
    },
    __resolveOpen: (result: ReporterResult): void => {
      const r = pendingOpenResolve;
      pendingOpenResolve = undefined;
      try {
        r?.(result);
      } catch {
        /* swallow — DEFE-02 */
      }
    },
    __initReplay: (): Promise<void> => initReplay(),
    __testRefreshConfigNow: (): Promise<void> => refreshConfigNow(),
    __setBreadcrumbBuffer: (get: () => BreadcrumbBuffer | undefined): void => {
      breadcrumbBufferGet = get;
    },
    __getBreadcrumbBuffer: (): BreadcrumbBuffer | undefined => breadcrumbBufferGet?.(),
    __setNetworkBodiesBuffer: (get: () => NetworkBodyBuffer | undefined): void => {
      networkBodiesBufferGet = get;
    },
    __getNetworkBodiesBuffer: (): NetworkBodyBuffer | undefined => networkBodiesBufferGet?.(),
    __setIdentityTokenHolder: (get: () => IdentityTokenHolderLike | undefined): void => {
      identityTokenHolderGet = get;
    },
    __setUserGetter: (get: () => UserMetadata | null): void => {
      userGet = get;
    },
    __rebindCrumbHooks: (): void => {
      // Codex round-1 findings 1/2 — see `reportingKilled`'s declaration. A
      // caller reaching this seam is declaring that a LIVE host mount owns this
      // adapter, which is the one thing that distinguishes React StrictMode's
      // simulated unmount (kill, then immediately remount and rebind) from a
      // host genuinely pulling the consent switch (kill, and nothing after).
      reportingKilled = false;
      reportingOwnership += 1;
      __bindCrumbHooks(crumbSink, crumbGate);
      // Same StrictMode race for the crash slot: the discarded adapter of a
      // double-invoked factory pair may have bound last at creation time, so
      // the committed adapter must re-claim (or clear) the slot on mount.
      __bindCrashSink(crashSink ?? null);
      // F37 (round-8 review) — same re-claim for the body-capture forwarding
      // slot (network.ts): a Provider mount effect runs only for the
      // committed adapter, so this re-points the already-installed fetch/XHR
      // patchers at THIS adapter's bodyCapture, closing the "remount leaves
      // body capture permanently dead" gap onKill() alone cannot close.
      __bindBodyCaptureHooks(bodyCapture);
      // Codex round-3 finding 1 — and re-open the raw log/network buffers'
      // admission gate, which `onKill()` closed. Same revive doctrine, same
      // reason: a StrictMode remount has to get capture back. NOT a claim
      // (`__claimCaptureBuffers`) — a remount is the SAME tenant, so its
      // buffers must survive; only a fresh `createWebPlatformAdapter()` drops
      // them. Config-disabled clients never open the gate at all.
      __setCaptureAccepting(_config.disabled !== true);
      // Codex round-4 finding 2 (P1) — and give the replay recorder back. Round
      // 3 made `onKill()` stop the rrweb observers with a TERMINAL latch (see
      // `ReplayRecorder.kill`), which is right for consent withdrawal and fatal
      // under StrictMode: the simulated unmount runs that real teardown and
      // then remounts, so replay stayed dead for the life of the page with
      // nothing able to clear it. Same revive doctrine, same seam and same
      // reason as `reportingKilled` and the capture gate above; `revive()`
      // deliberately does NOT clear a self-disable, which is the recorder's own
      // performance verdict rather than a teardown.
      //
      // Codex round-5 finding 2 (P1) — and `revive()` now RESTARTS a window
      // that was running when the kill landed, which is the half round 4
      // missed. `attemptReplayStart()` below cannot cover it: the replay
      // lifecycle lives in sdk-core and was never told about the kill, so it is
      // still in BUFFERING and `tryStart()` refuses anything but IDLE. The
      // remount was left with a lifecycle certain it was recording and a
      // recorder holding no buffer — the next report shipped without a replay,
      // and only completing or cancelling it ever armed the window again.
      try {
        replayRecorder?.revive();
      } catch {
        /* swallow — DEFE-02 */
      }
      // Round-4 latch audit — the `config.debug` seam is the third thing
      // `onKill()` takes away that a live mount has to get back. It is deleted
      // from `globalThis`, so `adoptReplayDebugSeam()` in `__initReplay` (which
      // only re-points the sources) cannot bring it back: a StrictMode dev host
      // lost `window.__everframeDebug` on the remount — precisely the
      // environment the seam exists for. Re-installed only when this adapter
      // owns a debug config AND nothing is currently installed, so a genuine
      // kill (never followed by a rebind) still ends with no seam.
      if (_config.debug === true && debugSeamSources && uninstallDebugSeam === undefined) {
        try {
          uninstallDebugSeam = installReplayDebugSeam(debugSeamSources);
          adoptReplayDebugSeam(debugSeamSources);
        } catch {
          /* swallow — DEFE-02; diagnostics are never worth a throw */
        }
      }
    },
    __applyBreadcrumbsConfig: (): void => applyLiveConfig(),
    __breadcrumbTrimOptions: (): { byteBudget: number; consoleEntryCap: number } => {
      const cfg = breadcrumbsConfig();
      return { byteBudget: cfg.byteBudget, consoleEntryCap: cfg.consoleEntryCap };
    },
    __uninstallWindowListeners: (): void => {
      for (const off of ownWindowListenerUninstallers) {
        try {
          off();
        } catch {
          /* swallow — DEFE-02 */
        }
      }
      ownWindowListenerUninstallers.length = 0;
    },
    onKill: (): void => {
      // F17/F18 (round-4 review) — see PlatformAdapter.onKill's doc comment.
      // Order matters only in that this must be synchronous and idempotent-
      // safe: `killed` flips first so any code below (there is none today)
      // observes the new state, then the periodic timer is cancelled so no
      // further ticks can fire (a tick already in flight is separately
      // guarded by its own post-await `killed` re-check above).
      killed = true;
      // Findings 1/2 — the reporter and the crash sink close too. Separate flag
      // because this one is revivable by `__rebindCrumbHooks()`; see its
      // declaration for why that is required rather than sloppy.
      reportingKilled = true;
      reportingOwnership += 1;
      stopPeriodicRefresh();
      // Codex round-3 finding 1 (P1) — stop the page-global console/fetch/XHR
      // patchers writing into the raw buffers. They stay INSTALLED (they are
      // install-once, shared with the rest of the page, and re-claimed by the
      // next init()), so the gate has to live at the buffers, not at the
      // patchers. See `__setCaptureAccepting`.
      try {
        __setCaptureAccepting(false);
      } catch {
        /* swallow — DEFE-02 */
      }
      // Codex round-3 finding 2 (P1) — and stop the rrweb observers, which
      // are recording the user's screen. `stopPeriodicRefresh()` above shut
      // down the config poller and `attemptReplayStart()` refuses to start a
      // new window, but NOTHING stopped a window already running: with replay
      // enabled, `kill()` left rrweb serializing every mutation for the rest
      // of the page.
      //
      // `kill()`, not `stop()`, and that distinction is the fix. The replay
      // LIFECYCLE restarts the recorder on its own initiative — `complete()`
      // and `cancel()` both end in `beginBuffering()` → `start()` — and
      // init.ts's `destroy()` runs `unwindOpen()` (→ `lifecycle.cancel()` →
      // resume) BEFORE `client.kill()`. A reversible stop here would be undone
      // by any of those; the terminal latch cannot be.
      try {
        replayRecorder?.kill();
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        uninstallDebugSeam?.();
        uninstallDebugSeam = undefined;
      } catch {
        /* swallow — DEFE-02 */
      }
      // Codex round-1 fix B, finding 2 (partial by ruling) — clear the
      // shared companion-badge box so a dead adapter's override never
      // outlives it. A fresh Provider mount (StrictMode double-invoke, Fast
      // Refresh, or a genuine remount) starts from "no server override"
      // rather than inheriting a killed instance's last-read value forever.
      try {
        __setCompanionBadgeServerConfig(undefined);
      } catch {
        /* swallow — DEFE-02 */
      }
      // Same doctrine as the companion-badge box above — clear the shared
      // branding box so a dead adapter's last-read value never outlives it.
      try {
        __setBrandingServerConfig(undefined);
      } catch {
        /* swallow — DEFE-02 */
      }
      // Same doctrine again — the vitals server-config box. Without this a
      // fresh init() on the same page would read a killed adapter's last
      // answer (possibly `vitalsEnabled: true`) until ITS OWN applyLiveConfig
      // completes, letting setupVitals start a session against stale
      // permission. init.ts's own setupVitals().destroy() (called just
      // before client.kill() reaches here) has already torn down any RUNNING
      // session; this only clears the GATE box.
      try {
        __setVitalsServerConfig(undefined);
      } catch {
        /* swallow — DEFE-02 */
      }
      // Report Resource Window (spec 2026-09-05, Task 9) — same doctrine
      // again: stop the sampler, drop the ring, and clear the stamp.ts box
      // so a dead adapter's ring can never outlive it and get stamped onto
      // a report/crash a fresh init() enqueues later.
      //
      // Round-review Finding 5 (2026-09-05) — `__setActiveResources(undefined)`
      // now runs in its OWN try, FIRST, before anything that can throw —
      // matching every sibling zeroization above (companion-badge / branding
      // / vitals boxes, each wrapped as a single call). The four statements
      // used to share ONE try/catch: `stopResourceSampler?.()`'s disposer
      // calls `observer?.disconnect()` unguarded (resources/sampler.ts), and
      // a throw there would have skipped `__setActiveResources(undefined)`
      // entirely, leaving `__getActiveResources()` pointing at a ring this
      // dead adapter no longer owns. `resourceRing.clear()` is new here too
      // — the config-disable branch above (~line 967) already zeroizes the
      // ring on its way out; the kill path hadn't, even though nothing could
      // reach it through the (now-cleared) stamp box afterward — cheap
      // consistency with that branch and with both natives, which zeroize
      // their own ring on kill.
      try {
        __setActiveResources(undefined);
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        resourceRing?.clear();
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        stopResourceSampler?.();
      } catch {
        /* swallow — DEFE-02 */
      }
      stopResourceSampler = undefined;
      resourceRing = undefined;
    },
  } as WebPlatformAdapter;

  // `config.debug` only: the sole path by which an attached debugger can read
  // live replay state off a device (see debug/seam.ts).
  if (_config.debug === true) {
    debugSeamSources = {
      lifecycleState: () => replayLifecycle?.state ?? null,
      recorderDiagnostics: () => replayRecorder?.__diagnostics() ?? null,
      config: () => configProvider?.get() ?? null,
    };
    uninstallDebugSeam = installReplayDebugSeam(debugSeamSources);
    uninstallers.push(() => uninstallDebugSeam?.());
  }

  // Expose the lifecycle via a non-enumerable getter so JSON.stringify never
  // walks into it. The Provider reads adapter.__replayLifecycle off the hook points.
  Object.defineProperty(adapter, '__replayLifecycle', {
    get: () => replayLifecycle,
    enumerable: false,
    configurable: false,
  });

  // Surface degraded-reason via non-enumerable read-only getter so JSON.stringify and
  // structuredClone never trip over it (Plan 04 + Plan 07 read this property directly).
  Object.defineProperty(adapter, '__lastDegradedReason', {
    get: () => lastDegradedReason,
    enumerable: false,
    configurable: false,
  });

  // Test-only cleanup hook — non-enumerable so JSON.stringify never reaches it.
  Object.defineProperty(adapter, '__testCleanup', {
    value: () => {
      for (const u of uninstallers) {
        try {
          u();
        } catch {
          /* swallow — DEFE-02 */
        }
      }
      uninstallers.length = 0;
      // F18 (round-4 review) — belt-and-suspenders: production teardown goes
      // through onKill() (client.kill() → adapter.onKill()), but tests that
      // build an adapter directly (never wiring a client) still need the
      // periodic interval torn down here, or it leaks across tests/remounts
      // (a real, observable failure mode under vitest's shared timer queue).
      stopPeriodicRefresh();
      // Same belt-and-suspenders for the resource sampler's own setInterval.
      // Round-review Finding 5 — same split as onKill above: clear the
      // stamp box first, in its own try, before anything that can throw.
      try {
        __setActiveResources(undefined);
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        resourceRing?.clear();
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        stopResourceSampler?.();
      } catch {
        /* swallow — DEFE-02 */
      }
      stopResourceSampler = undefined;
      resourceRing = undefined;
    },
    enumerable: false,
    configurable: false,
  });

  return adapter;
}

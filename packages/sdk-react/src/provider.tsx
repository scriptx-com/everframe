// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { createContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createClient,
  __internalClientState,
  IDENTITY_PROVIDER_TIMEOUT_MS,
  resolveClientExtra,
  type EverframeClient,
  type ThreadClientState,
  type UserMetadata,
} from '@everframe/sdk-core';
import {
  createWebPlatformAdapter,
  __registerDashboardHotkey,
  injectReporterStyles,
  submitReportFromDraft,
  drainOutbox,
  __setCompanionHost,
  __setCompanionDefaults,
  __setInlineReporterTheme,
  setupVitals,
  INGEST_URL,
  createScreenRecorder,
  type WebPlatformAdapter,
  type WebEverframeConfig,
  type ReporterResult,
} from '@everframe/web';
import { useIdentityProp, type IdentityProp } from './identity-prop.js';
// The reporter UI lives in @everframe/web now (the vanilla SDK has to render
// the same dialog). `/ui` is its React entry, built with react/react-dom
// EXTERNAL — so these components run on the host's React, the one this
// package already takes as a peer dependency, and not a second bundled copy.
import {
  ReporterDialog,
  type ReporterCompletePayload,
  ReporterFab,
  CompanionPinCard,
  CompanionBadge,
  InboxDialog,
  Toast,
  type ToastTone,
} from '@everframe/web/ui';
import { PKG_VERSION } from './internal/version.js';
import { __setCurrentContext } from './contextSeam.js';

export interface InternalContext {
  client: EverframeClient;
  adapter: WebPlatformAdapter;
  config: WebEverframeConfig;
  /** Freeze-then-open helper — freezes the replay buffer before mounting the modal. */
  openModal: () => void;
}

export const EverframeContext = createContext<InternalContext | null>(null);

export interface EverframeProviderProps {
  config: WebEverframeConfig;
  /**
   * Verified recognition via @everframe/identity. Unlike `config` — which is
   * frozen at mount — this prop is LIVE: change `key` on sign-in/switch, drop
   * it on sign-out.
   */
  identity?: IdentityProp;
  children: ReactNode;
}

interface ToastState {
  open: boolean;
  tone: ToastTone;
  message: string;
}

const TOAST_SUCCESS = 'Report sent';
const TOAST_SUCCESS_THREAD = 'Report sent — the team can reply here.';
const TOAST_RETRY = "Saved offline — will retry when you're back online.";
const TOAST_ERROR = "Couldn't send report. Check your SDK key configuration.";

/** SHA-256 hex of raw bytes (Web Crypto) — used for the session-replay attachment ref. */
async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view so the digest input is a plain
  // BufferSource (avoids SharedArrayBuffer-typed slice unions under strict TS).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function EverframeProvider({ config, identity, children }: EverframeProviderProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [toast, setToast] = useState<ToastState>({
    open: false,
    tone: 'success',
    message: '',
  });
  // Two-way replies (Task 9) — FAB gating state, fed from the thread
  // client's subscription (extended into the Task 8 lifecycle effect below;
  // a single subscription, not a second parallel one).
  //
  // Deliberately just `{ unread, count }` — NOT `enabled`/`readOnly` (PR
  // re-review, Minor finding on the two-way-replies-client fix round): the
  // render gate below only needs `count > 0`. Thread rows are populated
  // EXCLUSIVELY by a successful listThreads() inside thread-client.ts's
  // pollOnce(), strictly after its `if (!enabledNow || readOnly) return`
  // early-out — so a non-empty list already proves "this device has
  // conversations worth showing" (enabled now, or enabled once and now
  // read-only-latched by the kill switch, which closes rows in place but
  // never deletes them). shutdown() empties the list outright, so a killed
  // client still drops the FAB through the same `count > 0` check — no
  // separate enabled/readOnly signal was ever pulling its own weight, and
  // both were consumed nowhere but the render condition they fed. An
  // `enabled || readOnly` gate looked equivalent but wasn't: wake()
  // optimistically clears `readOnly` and notifies BEFORE its forced config
  // refetch resolves, so on every visibility return to a kill-switched app
  // there was a beat where `enabled` was still false and `readOnly` had
  // already flipped false too — both prongs false, FAB unmounts, then
  // remounts once the next poll re-latches. Dropping both fields removes
  // that flicker outright instead of special-casing around it.
  const [threadState, setThreadState] = useState<{ unread: number; count: number }>({
    unread: 0,
    count: 0,
  });

  const ctxValue = useMemo<InternalContext>(() => {
    // The adapter's own crash path stamps `envelope.sdk.name` + `.version`.
    // It lives in @everframe/web now — a package with a different name on the
    // wire and an independently versioned PKG_VERSION — so tell it which SDK
    // is actually hosting, as a constructor argument, in the same step that
    // creates the adapter (and therefore installs the crash handlers), so no
    // crash can be observed under the wrong SDK identity.
    const adapter = createWebPlatformAdapter(config, {
      sdkName: 'everframe-react',
      sdkVersion: PKG_VERSION,
    });
    const client = createClient(adapter);
    client.init(config);
    // Bind the crumb sink to the client's buffer (one chain for auto + manual
    // crumbs; addBreadcrumb and the web adapters share redaction + lifecycle).
    adapter.__setBreadcrumbBuffer(() => __internalClientState.get(client)?.breadcrumbs);
    // Same seam for the dedicated network-body buffer (spec 2026-07-18 §7):
    // captured bodies flow into the client-state buffer that shares the crumb
    // chain's freeze/clear lifecycle. Bound here (init-time) exactly like the
    // crumb buffer; the report-lifecycle freeze/takeFrozen calls are Task 8.
    adapter.__setNetworkBodiesBuffer(() => __internalClientState.get(client)?.networkBodies);
    // Reporter identity recognition (spec 2026-08-06) — same late-bind seam:
    // the holder lives in sdk-core client state, bound here right after
    // createClient so adapter.__identityTokenReader (consumed by this
    // Provider's own submit/drain calls below, the thread-client's reporter
    // API, and the companion capture bridge) can reach it.
    adapter.__setIdentityTokenHolder(() => __internalClientState.get(client)?.identityToken);
    // Self-declared recognition (spec 2026-08-12) — same late-bind seam, for
    // the CRASH sink specifically: it fires from a window error handler with
    // no React context, so it cannot reach `state.user` the way the report and
    // companion paths do. A getter, not a snapshot: the host's user changes
    // over the session and a captured value would pin whoever was signed in at
    // mount onto every later crash.
    adapter.__setUserGetter(() => __internalClientState.get(client)?.user ?? null);
    // REPLAY-02 — FREEZE the replay buffer SYNCHRONOUSLY at the top of every
    // open path, BEFORE the reporter modal mounts (Pitfall 2). This seals the
    // rolling buffer + trims `ts > freezeTs` so the reporter UI is never recorded.
    // A guarded no-op when replay is OFF / not BUFFERING. The breadcrumb chain
    // freezes at the same instant for the same reason (reporter taps must not
    // pollute the shipped chain).
    const openModal = (): void => {
      try {
        adapter.__replayLifecycle?.freeze();
      } catch {
        /* swallow — DEFE-02; replay must never block the reporter */
      }
      try {
        __internalClientState.get(client)?.breadcrumbs.freeze();
      } catch {
        /* swallow — DEFE-02 */
      }
      try {
        __internalClientState.get(client)?.networkBodies.freeze();
      } catch {
        /* swallow — DEFE-02 */
      }
      setModalOpen(true);
    };
    // Wire the modal-open trigger via the registered seam (the adapter owns
    // __openReporter's pending-promise lifecycle now; it calls this on every
    // open request).
    adapter.__registerShowModal(openModal);
    return { client, adapter, config, openModal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // single-init by design — config swap requires Provider remount

  // One screen recorder per provider instance: it holds the `previous`-screen
  // state that derives each `from → to` transition in a closure, so a fresh
  // recorder per call (or per render) would break that chain and emit
  // nothing, ever. Keyed off `ctxValue` — the same dependency the
  // `__setCurrentContext` effect below uses — so it is rebuilt exactly when
  // that effect's `addBreadcrumb` binding would be.
  const screenRecorder = useMemo(
    () => createScreenRecorder((input) => ctxValue.client.addBreadcrumb(input)),
    [ctxValue],
  );

  // Register/unregister the module-level seam so the top-level `open()` export
  // can route into this provider. Single-instance enforced inside the seam.
  useEffect(() => {
    __setCurrentContext({
      open: () => ctxValue.adapter.__openReporter(),
      addBreadcrumb: (input) => ctxValue.client.addBreadcrumb(input),
      captureException: (error, options) => ctxValue.client.captureException(error, options),
      setUser: (user) => ctxValue.client.setUser(user),
      // Forward whichever form the host passed straight through to
      // sdk-core's `setExtra`. TS cannot resolve an overloaded call with a
      // union-typed argument, so each branch narrows first — the three
      // calls are otherwise identical; sdk-core is the single place that
      // decides what each form means.
      setExtra: (value) => {
        if (typeof value === 'string') {
          ctxValue.client.setExtra(value);
        } else if (typeof value === 'function') {
          ctxValue.client.setExtra(value);
        } else {
          ctxValue.client.setExtra(value);
        }
      },
      recordScreen: screenRecorder,
    });
    return () => __setCurrentContext(null);
  }, [ctxValue]);

  // Publish the companion host seam so the phone-companion `report.submit`
  // path can reach config (apiKey) + adapter (capture + outbox) from its
  // non-React call site. Cleared on unmount. Without this the companion
  // submit degrades to `report.failed` instead of submitting to ingest.
  useEffect(() => {
    __setCompanionHost({
      config: ctxValue.config,
      adapter: ctxValue.adapter,
      sdkVersion: PKG_VERSION,
      // Getter, not a captured value — read at companion submit time so a
      // sign-in/out between mount and submit is reflected (spec 2026-08-12).
      getUser: () => __internalClientState.get(ctxValue.client)?.user ?? null,
      // Same doctrine for the host's setExtra value — read at submit time so
      // companion reports carry the same payload.extra the in-app path does.
      // Resolved through the single `resolveClientExtra` seam — never
      // `.extra` directly, which would hand back the unresolved
      // `{ kind: 'resolver' }` record for a host using the resolver form.
      getExtra: () => resolveClientExtra(ctxValue.client),
    });
    return () => __setCompanionHost(null);
  }, [ctxValue]);

  // Default companion.start() options from the provider's own config, so
  // `companion.start()` can be called with no arguments — matching the RN
  // SDK's zero-argument call — instead of making the host repeat a key the
  // provider is already holding. Cleared on unmount, same doctrine as the
  // companion host seam above.
  useEffect(() => {
    __setCompanionDefaults({
      ...(ctxValue.config.apiKey ? { sdkKey: ctxValue.config.apiKey } : {}),
      ...(ctxValue.config.appName ? { deviceLabel: ctxValue.config.appName } : {}),
    });
    return () => __setCompanionDefaults(null);
  }, [ctxValue.config.apiKey, ctxValue.config.appName]);

  // Mirror the host's inline theme option into the branding box (spec
  // 2026-08-25) so Modal's useReporterThemeVars sees it without prop
  // drilling. Cleared on unmount — a dead provider's theme must not leak
  // into a fresh mount (the companion-badge Fix B doctrine).
  useEffect(() => {
    __setInlineReporterTheme(config.theme);
    return () => __setInlineReporterTheme(undefined);
  }, [config.theme]);

  // Style injection + dashboard-owned hotkey registration.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      injectReporterStyles(document, config.cspNonce);
    }
    let unregister = (): void => undefined;
    const unsubscribe = ctxValue.adapter.__subscribeReportHotkey((binding) => {
      unregister();
      unregister = __registerDashboardHotkey(() => ctxValue.openModal(), binding);
    });
    return () => {
      unsubscribe();
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Crumb-hook rebind MUST happen in an effect, not only in the useMemo
  // factory above: StrictMode double-invokes the factory, so the module-level
  // forwarding slot ends up bound to whichever adapter was created LAST while
  // React commits the FIRST — capture then feeds a buffer submit never reads
  // (field bug 2026-07-10: StrictMode hosts shipped 0 breadcrumbs). Effects
  // run only for the committed ctxValue, so this re-points the slot (and the
  // buffer getter, idempotently) at the pair that will actually submit.
  useEffect(() => {
    ctxValue.adapter.__setBreadcrumbBuffer(
      () => __internalClientState.get(ctxValue.client)?.breadcrumbs,
    );
    ctxValue.adapter.__setNetworkBodiesBuffer(
      () => __internalClientState.get(ctxValue.client)?.networkBodies,
    );
    ctxValue.adapter.__setIdentityTokenHolder(
      () => __internalClientState.get(ctxValue.client)?.identityToken,
    );
    ctxValue.adapter.__setUserGetter(
      () => __internalClientState.get(ctxValue.client)?.user ?? null,
    );
    ctxValue.adapter.__rebindCrumbHooks();
  }, [ctxValue]);

  // Session Vitals (spec 2026-09-01), react half — Codex round-1 finding S1.
  // `@everframe/web`'s `init.ts` calls `setupVitals()` right after building its
  // client/adapter; this Provider built the SAME adapter (via
  // `createWebPlatformAdapter`, above in the `ctxValue` memo) but never called
  // `setupVitals()` at all, so every React host shipped zero vitals sessions,
  // ever. Wired here exactly parallel to init.ts's usage: one instance per
  // `ctxValue` (created once the client/adapter exist — `ctxValue` is a
  // single-init `useMemo`), `destroy()` in the cleanup. `isKilled` mirrors
  // init.ts's own predicate — sdk-core's permanent `state.killed`, not the
  // adapter's revivable `reportingKilled` — and `sdkName`/`sdkVersion` are
  // this provider's own identity (`'everframe-react'` / this package's
  // `PKG_VERSION`), matching what `ctxValue`'s adapter was constructed with
  // above, not the vanilla SDK's.
  useEffect(() => {
    const vitals = setupVitals({
      config: ctxValue.config,
      apiKey: ctxValue.config.apiKey,
      apiUrl: INGEST_URL,
      isKilled: () => __internalClientState.get(ctxValue.client)?.killed === true,
      sdkVersion: PKG_VERSION,
      // Task 11 (spec 2026-09-10 — playback session identity). Both halves are
      // read fresh on every call: the collector invokes this once per SUMMARY,
      // so a session that starts anonymous and then signs in becomes attributed
      // from its next summary on.
      //
      // `__peekIdentityToken()` — not `__identityTokenReader.get()` /
      // `__captureIdentityAtSubmitBoundary()` — because this must be
      // SYNCHRONOUS (controller ruling R7): the collector's `sendSummary` is
      // synchronous and also fires from the pagehide/unload path, where nothing
      // can be awaited. It is cache-only and never invokes the host's provider,
      // so a COLD CACHE means this summary carries no token and the session
      // stays anonymous until a later summary carries one. Accepted and
      // expected — identity adoption is gradual by design.
      identity: () => {
        const token = ctxValue.adapter.__peekIdentityToken();
        const user = ctxValue.adapter.__captureUserAtSubmitBoundary();
        return {
          ...(token !== null ? { token } : {}),
          // Round-2 finding 3 — the cold-start twin. This summary has no token
          // because the warm below has not landed yet, NOT because the viewer
          // is anonymous; the collector withholds the self-declared `user`
          // block while that is true rather than minting an unverified person
          // the next summary is about to verify. Same wiring as init.ts's.
          ...(ctxValue.adapter.__identityTokenPending() ? { tokenPending: true } : {}),
          ...(user !== null ? { user } : {}),
        };
      },
      // THE OTHER HALF of that ruling, and what makes the cache-only read
      // above able to return anything at all (adversarial review of PR #218,
      // finding 1 — the verified tier was dead on a fresh install).
      //
      // `__peekIdentityToken()` reads a cache that ONLY
      // `IdentityTokenHolder.get()` ever fills, and `setIdentityToken()`
      // DROPS that cache rather than filling it (sdk-core's
      // `reporter/identity-token.ts`). So on a fresh browser where the host
      // sets a valid token and the viewer only watches — never filing a
      // report, which is exactly the viewer this feature exists to recognize
      // — nothing in the SDK ever called `get()`, `peek()` returned null
      // forever, and every summary was anonymous.
      //
      // This warms that cache off the hot path: the collector calls it on the
      // flush cadence and once at startup, NEVER on the unload path. Fire and
      // forget — `void` plus a terminal `.catch` so it can never reject
      // unhandled, never blocks or delays a flush, and never fails a summary.
      // The gate lives inside `__identityTokenReader` (live `identity.enabled`
      // + a bound holder), so a project with no signing secret still never
      // invokes the host's provider.
      warmIdentity: () => {
        void ctxValue.adapter.__identityTokenReader.get(Date.now()).catch(() => undefined);
      },
    });
    return () => vitals.destroy();
  }, [ctxValue]);

  // REPLAY-02/05 — resume the rolling buffer once after init (post first config
  // resolution). Fail-closed: if the config fetch fails or replay is OFF, the
  // lifecycle's tryStart is a guarded no-op and rrweb is never imported.
  //
  // The thread-polling effect below needs this SAME settle signal (config
  // resolution is also what warms the replies `isEnabled()` gate), so the
  // promise is stashed on a ref rather than re-invoked — calling
  // `__initReplay()` a second time would fire a second /api/config request
  // racing the first (and, since both share one `provider.refresh()` TTL
  // guard that only advances in a post-fetch `finally`, an overlapping second
  // call would not be deduped either).
  const initReplayPromiseRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    initReplayPromiseRef.current = ctxValue.adapter.__initReplay().then(() => {
      ctxValue.adapter.__applyBreadcrumbsConfig();
    });
  }, [ctxValue]);

  // Verified recognition (spec 2026-08-13). Placed after the config-settle
  // effect because the warm-up awaits that same promise.
  useIdentityProp(ctxValue, identity, () => initReplayPromiseRef.current);

  // Two-way replies (Task 8) — thread polling lifecycle: arm polling only
  // AFTER config init settles (finding C1, final review 2026-08-01), so the
  // enabled gate is warm; pause while the tab is hidden, wake on return to
  // foreground (spec: foreground poll, idles to zero when no open threads).
  // Task 9 extends this SAME effect with the threadState subscription that
  // gates the FAB render — one subscription, not a second parallel effect.
  //
  // Why not `threads.startPolling()` synchronously at mount (the pre-fix
  // behavior): startPolling() arms a 0ms timer, and that first pollOnce()
  // tick can fire BEFORE the config fetch above has resolved. isEnabled()
  // then reads the fail-closed OFF default, pollOnce() returns
  // nextDelayMs=null, and the poller idles to zero PERMANENTLY — nothing
  // else re-arms it (wake() is a no-op while already active is false only
  // via visibilitychange or a new submit), so the FAB/unread dot never
  // appears on a fresh load without a tab hide/show. Deferring the arm past
  // config resolution closes that race outright: the first real tick always
  // observes the settled config. When replies end up disabled, that same
  // first tick idles immediately (no network call, no armed timer) — same
  // idle-to-zero outcome as before, just decided with the *correct* gate
  // value instead of the fail-closed default.
  useEffect(() => {
    const threads = ctxValue.adapter.threads;
    if (!threads) return;
    let cancelled = false;
    const applyState = (s: ThreadClientState): void => {
      setThreadState({ unread: s.unreadCount, count: s.threads.length });
    };
    applyState(threads.getState());
    const unsubscribe = threads.subscribe(applyState);
    void initReplayPromiseRef.current.then(() => {
      // Guard against a mid-flight unmount: the cleanup below may already
      // have run (and stopped the loop) by the time config settles.
      //
      // Finding 5 (round-4 PR review): also gate the initial arm on the
      // CURRENT visibility state. A Provider mounted while the document is
      // already hidden (tab opened in the background, prerender, restored
      // session) never gets a visibilitychange transition to stop a poller
      // that started unconditionally — the foreground-only contract would
      // be violated in the background until the user happened to switch
      // tabs. A missing/undefined `visibilityState` (non-browser
      // environments) is treated as visible so nothing regresses there. The
      // visibilitychange listener below is untouched: a later hidden->visible
      // transition still calls wake() and starts polling normally.
      const isVisible =
        typeof document === 'undefined' ||
        document.visibilityState === undefined ||
        document.visibilityState === 'visible';
      if (!cancelled && isVisible) threads.startPolling();
    });
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') threads.wake();
      else threads.stopPolling();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      threads.stopPolling();
      unsubscribe();
    };
  }, [ctxValue]);

  // Plan 03-07 — wire outbox drain trigger to the actual submit pipeline. The adapter's
  // 'online' event listener (registered in plan 03-05) calls this on reconnect; we also
  // run a best-effort drain on Provider mount so reports queued in a previous page-load
  // session get re-attempted as soon as the SDK is alive.
  useEffect(() => {
    const adapter = ctxValue.adapter;
    const ob = adapter.outbox;
    if (!ob) return;
    const trigger = (): void => {
      // PR review Finding 2 (P1, 2026-08-06 identity spec), second half — a
      // drain that fires before the config fetch resolves sees
      // `identity.enabled` at its fail-closed OFF default (adapter.ts's
      // `identityTokenReader`), so a queued entry whose enqueue-time subject
      // WOULD match the now-signed-in host instead drains anonymously — and
      // since that submit still succeeds, nothing ever retries it; the
      // recognizable report is gone for good. Most concretely: this Provider
      // remounts (route change, or React StrictMode's dev double-invoke)
      // while `enqueuedSubjects` (submit.ts, module-scoped — NOT React
      // state, so it survives a remount) still holds a real subject from the
      // PREVIOUS mount, but the NEW adapter's config provider hasn't
      // resolved yet.
      //
      // Only worth waiting for when an identity source is ALREADY set at
      // this exact instant — with none set, nothing could be tagged anyway,
      // so there's nothing to protect and no reason to delay delivery. This
      // is commonly true even for the very first mount-time call: a host's
      // own auth-wiring component nested INSIDE this Provider calls
      // `setIdentityToken` from its own mount effect, and child effects
      // commit before their parent's (this effect) in the same React commit.
      //
      // Bounded by `IDENTITY_PROVIDER_TIMEOUT_MS` (reusing the identity
      // provider's own timeout rather than inventing a second knob) so a
      // slow or hung config fetch can never delay a report indefinitely —
      // recognition failing is always preferable to a report failing.
      const holder = __internalClientState.get(ctxValue.client)?.identityToken;
      const waitForConfig = holder?.hasSource()
        ? Promise.race([
            initReplayPromiseRef.current,
            new Promise<void>((resolve) => setTimeout(resolve, IDENTITY_PROVIDER_TIMEOUT_MS)),
          ]).catch(() => undefined)
        : Promise.resolve();
      void waitForConfig.then(() =>
        drainOutbox({
          outbox: ob,
          config: ctxValue.config,
          sdkVersion: PKG_VERSION,
          credentials: adapter.reporterCredentials ?? null,
          identityToken: adapter.__identityTokenReader,
        }).then((result) => {
          // Round-6 PR-review Finding 2 (HIGH) — a retried outbox item that
          // provisions a thread must wake the idle poller immediately, the
          // same way a live submit does via `outcome.threadId` below. Without
          // this, a client that already idled to zero before this drain ran
          // (mount, or the 'online' reconnect trigger) only discovers a
          // freshly-provisioned conversation on an unrelated visibility
          // transition or a reload. `provisionedThreadIds` only reflects
          // items that belong to THIS app (drainOutbox never provisions a
          // thread for a foreign-app item — see submit.ts).
          if (result.provisionedThreadIds.length > 0) {
            adapter.threads?.wake();
          }
        }),
      );
    };
    adapter.__registerOutboxDrainTrigger(trigger);
    // best-effort drain on init
    trigger();
  }, [ctxValue]);

  useEffect(() => {
    return () => {
      // DEFE-03 cleanup on unmount
      try {
        ctxValue.client.kill();
      } catch {
        /* swallow — DEFE-02 */
      }
    };
  }, [ctxValue]);

  const onComplete = (payload: ReporterCompletePayload): void => {
    // Resolve the showReporterUI promise so any sdk-core flow awaiting it unblocks.
    (
      ctxValue.adapter as unknown as { __resolveReporterUI: (d: ReporterCompletePayload | null) => void }
    ).__resolveReporterUI(payload);
    setModalOpen(false);

    // Host free-form metadata set via useEverframe().setExtra() — resolved
    // HERE, at the in-app submit boundary, through the single
    // `resolveClientExtra` seam (a string or object form's value, or a
    // resolver's return value re-invoked fresh on every submit) so it lands
    // in payload.extra.
    const extra = resolveClientExtra(ctxValue.client) || undefined;
    const draft = {
      title: payload.title,
      description: payload.description,
      excludedArtifacts: payload.excludedArtifacts,
      annotations: payload.annotations,
      redactions: payload.redactions,
      ...(extra ? { extra } : {}),
    };

    // Fire-and-forget submit; toast surfaces the outcome. Do NOT await inside the React
    // event handler — the user-facing flow has already closed the modal. The public
    // `open()` Promise is settled at the END of this async block with the final outcome.
    void (async () => {
      let openResult: ReporterResult;
      // PR review, round 4 (Serious) — capture the identity AT THE SUBMIT
      // BOUNDARY: before ANY of the prep below (replay hashing,
      // breadcrumb/network-body snapshotting, multipart build inside
      // submitReportFromDraft) has a chance to run. Those awaits can span
      // hundreds of milliseconds to seconds for a report carrying a
      // screenshot or replay buffer — an account switch during that window
      // must get the identity that was live when the user pressed Submit,
      // not whichever identity happens to be live once prep finally
      // finishes. Threaded through as `capturedIdentityToken` so
      // `submitReportFromDraft` pins to this exact value instead of
      // re-resolving on its own (see that option's doc in submit.ts for the
      // full chain of rounds this closes).
      //
      // PR review, round 5 (Serious) — this call site is STILL one hop later
      // than the user's actual Send click: `ReporterDialog.onSubmit` (which
      // calls `onComplete` below, handing us `payload`) does its OWN
      // bake-annotations/hash prep before ever reaching here, on the most
      // common reporter flow (any blur/arrow/stroke). That dialog now
      // captures at ITS OWN true boundary — the top of `onSubmit`, before
      // ANY of its prep — and threads the result through
      // `payload.capturedIdentityToken`. Prefer that (it's earlier); this
      // call remains ONLY as a fallback for a caller that reaches
      // `onComplete` some other way without having captured anything itself
      // (`payload.capturedIdentityToken === undefined`).
      //
      // Round 5 (Minor) — also wrapped in its own try/catch now (matching
      // the DEFE-02 shape every other prep step in this function already
      // uses, and capture-bridge.ts's equivalent call, which sits inside
      // that function's outer try): an uncaught throw here would reject this
      // whole IIFE, leaving `openResult` unset, `__resolveOpen` never
      // called, and the report silently dropped with no toast. The adapter
      // method itself is documented to never throw, so this is belt-and-
      // braces, not a live gap — but identity work must never be the one
      // uncovered statement in a function this defensive everywhere else.
      //
      // External review, finding 1 (Serious) — the self-declared user
      // (`setUser`) is captured at this SAME boundary, with the same
      // payload-first / capture-as-fallback resolution as the token, and
      // FIRST because it is synchronous: taking it ahead of the token's
      // `await` costs nothing and leaves no window at all. The reasoning
      // recorded here when `setUser` went live — "no expiry race like the
      // identity token, so no submit-boundary capture is needed" — was wrong
      // about why that capture exists: it is not about the token expiring, it
      // is about an ACCOUNT SWITCH during a prep window that can span seconds,
      // which changes the user label exactly as it changes the token.
      let capturedUser: UserMetadata | null = null;
      try {
        capturedUser =
          payload.capturedUser !== undefined
            ? payload.capturedUser
            : ctxValue.adapter.__captureUserAtSubmitBoundary();
      } catch {
        /* swallow — DEFE-02; recognition must never block or fail a report */
      }
      let capturedIdentityToken: string | null = null;
      try {
        capturedIdentityToken =
          payload.capturedIdentityToken !== undefined
            ? payload.capturedIdentityToken
            : await ctxValue.adapter.__captureIdentityAtSubmitBoundary();
      } catch {
        /* swallow — DEFE-02; identity capture must never block or fail a report */
      }
      // REPLAY-02/03 — on submit, take the frozen capture (serialize+scrub+compress),
      // compute its sha256, and thread it onto the bundle so draftToEnvelope emits the
      // session-replay attachment (with sever-and-flag at 8 MB). Then resume buffering.
      // `lifecycle.complete()` drives the recorder's `takeFrozen()` then resumes
      // `start()` (the lifecycle owns the FROZEN→SUBMITTED→BUFFERING transition).
      const bundle = payload.bundle;
      try {
        const lifecycle = ctxValue.adapter.__replayLifecycle;
        if (lifecycle) {
          const capture = await lifecycle.complete();
          if (capture && capture.bytes.byteLength > 0) {
            bundle.replayCapture = capture;
            bundle.replaySha256 = await sha256OfBytes(capture.bytes);
          }
        }
      } catch {
        /* swallow — DEFE-02; a replay failure must never block the report */
      }
      // Breadcrumbs — hand the frozen chain to the envelope build. takeFrozen()
      // clears the snapshot; live capture was never interrupted.
      try {
        const buf = __internalClientState.get(ctxValue.client)?.breadcrumbs;
        const frozen = buf?.takeFrozen();
        if (frozen && frozen.length > 0) {
          bundle.breadcrumbs = frozen;
          bundle.breadcrumbTrim = ctxValue.adapter.__breadcrumbTrimOptions();
        }
      } catch {
        /* swallow — DEFE-02; a breadcrumb failure must never block the report */
      }
      // Network bodies — same freeze-at-open/take-at-submit lifecycle as
      // breadcrumbs, mirrored into a separate buffer (Task 7/8). takeFrozen()
      // clears the snapshot; live capture was never interrupted.
      try {
        const bodyBuf = __internalClientState.get(ctxValue.client)?.networkBodies;
        const frozenBodies = bodyBuf?.takeFrozen();
        if (frozenBodies && frozenBodies.length > 0) {
          bundle.networkBodies = frozenBodies;
        }
      } catch {
        /* swallow — DEFE-02; a network-body failure must never block the report */
      }
      try {
        const outcome = await submitReportFromDraft({
          config: ctxValue.config,
          sdkVersion: PKG_VERSION,
          draft,
          bundle,
          outbox: ctxValue.adapter.outbox,
          credentials: ctxValue.adapter.reporterCredentials ?? null,
          identityToken: ctxValue.adapter.__identityTokenReader,
          // Round 4 — pin to what was captured at the submit boundary above,
          // not whatever's live now that prep has finished.
          capturedIdentityToken,
          // Self-declared identity (spec 2026-08-12) — the value captured at
          // the submit boundary above, NOT a live read here. A live read
          // happens on the far side of the replay hashing / breadcrumb and
          // network-body snapshotting / multipart build, i.e. after the exact
          // window an account switch has to land in to misattribute the
          // report (external review, finding 1).
          user: capturedUser,
        });
        // Two-way replies (Task 8) — a submit that minted/attached a thread
        // wakes the poller immediately so the reporter's first status/reply
        // shows up without waiting out the floor interval.
        if (outcome.threadId) {
          ctxValue.adapter.threads?.wake();
        }
        if (outcome.ok) {
          const successMessage = outcome.threadId ? TOAST_SUCCESS_THREAD : TOAST_SUCCESS;
          setToast({ open: true, tone: 'success', message: successMessage });
          // Drain the outbox on successful submit (PIPE-02 trigger #2).
          if (ctxValue.adapter.outbox) {
            void drainOutbox({
              outbox: ctxValue.adapter.outbox,
              config: ctxValue.config,
              sdkVersion: PKG_VERSION,
              credentials: ctxValue.adapter.reporterCredentials ?? null,
              identityToken: ctxValue.adapter.__identityTokenReader,
            }).then((result) => {
              // Same Finding-2 wake-on-provision rule as the mount/online
              // drain trigger above — this drain can also retry OTHER
              // previously-queued items and provision a thread for one of
              // them, independent of `outcome.threadId` for the item that
              // was just submitted live.
              if (result.provisionedThreadIds.length > 0) {
                ctxValue.adapter.threads?.wake();
              }
            });
          }
          openResult = { status: 'submitted', reportId: outcome.reportId };
        } else if (outcome.retryable) {
          setToast({ open: true, tone: 'warning', message: TOAST_RETRY });
          openResult = { status: 'queued', reportId: outcome.reportId };
        } else {
          setToast({ open: true, tone: 'error', message: TOAST_ERROR });
          openResult = { status: 'cancelled', reason: 'error' };
        }
      } catch {
        // DEFE-02 — never let a submit-path bug bubble out of the Provider.
        setToast({ open: true, tone: 'error', message: TOAST_ERROR });
        openResult = { status: 'cancelled', reason: 'error' };
      }
      ctxValue.adapter.__resolveOpen(openResult);
    })();
  };

  const onCancel = (): void => {
    // REPLAY-02 — discard the frozen window and resume a clean buffer
    // (open→cancel→open→submit leaves no stale frames). `lifecycle.cancel()` drives
    // the recorder's `discardAndResume()` (zeroize) then resumes `start()`.
    // Guarded no-op if not FROZEN.
    try {
      ctxValue.adapter.__replayLifecycle?.cancel();
    } catch {
      /* swallow — DEFE-02 */
    }
    try {
      __internalClientState.get(ctxValue.client)?.breadcrumbs.discardAndResume();
    } catch {
      /* swallow — DEFE-02 */
    }
    try {
      __internalClientState.get(ctxValue.client)?.networkBodies.discardAndResume();
    } catch {
      /* swallow — DEFE-02 */
    }
    (
      ctxValue.adapter as unknown as { __resolveReporterUI: (d: null) => void }
    ).__resolveReporterUI(null);
    ctxValue.adapter.__resolveOpen({ status: 'cancelled' });
    setModalOpen(false);
  };

  return (
    <EverframeContext.Provider value={ctxValue}>
      {children}
      <ReporterDialog
        open={modalOpen}
        adapter={ctxValue.adapter}
        onComplete={onComplete}
        onCancel={onCancel}
      />
      <CompanionPinCard />
      <CompanionBadge />
      {ctxValue.adapter.threads && ctxValue.config.replies?.ui !== 'headless'
        && threadState.count > 0 ? (
        <ReporterFab
          unreadCount={threadState.unread}
          onOpen={() => {
            setInboxOpen(true);
            void ctxValue.adapter.threads?.refresh(); // spec: immediate poll when the UI opens
          }}
        />
      ) : null}
      <InboxDialog
        open={inboxOpen}
        onClose={() => setInboxOpen(false)}
        threads={ctxValue.client.threads}
        onNewReport={() => {
          setInboxOpen(false);
          ctxValue.openModal();
        }}
      />
      <Toast
        open={toast.open}
        tone={toast.tone}
        message={toast.message}
        onDismiss={() => setToast((prev) => ({ ...prev, open: false }))}
      />
    </EverframeContext.Provider>
  );
}

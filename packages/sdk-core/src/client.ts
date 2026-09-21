// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { safeWrap } from './safe-wrap.js';
import type { PlatformAdapter } from './types/platform.js';
import type { TraceItXConfig, UserMetadata, TraceItXError } from './types/config.js';
import { createBreadcrumbBuffer, type BreadcrumbBuffer } from './breadcrumbs/buffer.js';
import { createNetworkBodyBuffer, type NetworkBodyBuffer } from './capture/network-body-buffer.js';
import { BreadcrumbKind, BreadcrumbLevel, type Breadcrumb } from '@traceitx/protocol';
import type { ThreadClient, ThreadClientState, ThreadDetail } from './reporter/thread-client.js';
import type { ThreadSummary } from './reporter/api.js';
import { IdentityTokenHolder, type IdentityTokenSource } from './reporter/identity-token.js';
import { projectUserMetadata } from './user-projection.js';
import type { CaptureExceptionOptions } from './crash/options.js';
import { budgetExtra, EXTRA_MAX_CHARS } from './extra-budget.js';

// Sourced from the protocol enum (canonical) so a future level addition there
// can never silently be dropped here.
const LEVELS: readonly string[] = BreadcrumbLevel.options;

export interface AddBreadcrumbInput {
  message: string;
  /** Defaults to 'custom'. Unknown values coerce to 'custom' (never throw). */
  kind?: Breadcrumb['kind'];
  /** Invalid values are dropped, not passed through (never throw). */
  level?: 'debug' | 'info' | 'warn' | 'error';
  data?: Record<string, unknown>;
}

/**
 * A host-supplied function that produces the next report's `extra` payload
 * on demand. Registered via `setExtra(resolve)`; invoked once per report
 * assembly (see `resolveClientExtra`), never at registration time.
 */
export type ExtraResolver = () => string | Record<string, unknown>;

export interface TraceItXClient {
  /** Lazy init — stores config; no I/O, no patching. DEFE-01. */
  init(config: TraceItXConfig): void;
  setUser(user: UserMetadata | null): void;
  /**
   * Identify the person using your app. Pass a signed JWT, or a provider the
   * SDK re-asks as the token nears expiry — tokens live at most 10 minutes,
   * so a one-shot value leaves the user unrecognized for the rest of the
   * session. Pass null on sign-out.
   *
   * Recognition NEVER blocks or fails a report: if the provider throws, hangs,
   * or returns null, the report is submitted anonymously.
   */
  setIdentityToken(source: IdentityTokenSource): void;
  markSensitive(target: unknown): void;
  report: { open(): Promise<{ reportId: string } | null> };
  /**
   * Two-way replies facade (spec 2026-07-31). Inert (empty lists, zero
   * unread, no-op mutators) before init, after kill, and whenever the
   * platform adapter doesn't wire a `threads` client. Backed by the
   * platform-supplied `ThreadClient` (reporter/thread-client.ts).
   */
  threads: {
    list(): ThreadSummary[];
    get(threadId: string): Promise<ThreadDetail | null>;
    reply(threadId: string, body: string): Promise<void>;
    retryMessage(localId: string): Promise<void>;
    markRead(threadId: string): Promise<void>;
    /**
     * Resolves `true` on success (204) or when the thread was already gone
     * (404) — either way it's no longer local. Resolves `false` on any other
     * error (network/timeout/5xx): the thread may still exist server-side,
     * so local state is left untouched and the caller should offer a retry
     * rather than navigating away as if the delete succeeded.
     */
    delete(threadId: string): Promise<boolean>;
    unreadCount(): number;
    getState(): ThreadClientState;
    subscribe(cb: (state: ThreadClientState) => void): () => void;
    refresh(): Promise<void>;
  };
  /**
   * Attach host-supplied free-form metadata to the next report; lands in
   * `payload.extra`.
   *
   * PREFER THE RESOLVER FORM — `setExtra(() => buildReportExtra())` — over
   * pushing a string/object snapshot. Triggers the SDK owns (the dashboard
   * hotkey on web, native shake on mobile) open the reporter DIRECTLY, with
   * no chance for the host to refresh a pushed snapshot first. That forces a
   * host to enumerate every input its payload depends on and re-push on each
   * one changing — miss one and the report silently ships stale data. A real
   * app got exactly this wrong: its extra payload read four stores, but its
   * refresh effect only fired on route change and profile switch, so
   * switching channel inside a player screen (no route change) shipped a
   * STALE PLAYER SNAPSHOT on every playback-bug report — the single most
   * valuable field for diagnosing it. The resolver is evaluated when the SDK
   * assembles the report, so it always sees current values with no effect to
   * write or keep in sync. A throwing resolver never breaks the report: it
   * is caught, warned once, and `extra` is simply omitted from that report.
   *
   * String/object forms are still supported and REPLACE the previous value
   * (resolver included) on each call; prefer the object form so the SDK
   * serializes it for you. Every form — string, object, or a resolver's
   * return value — is capped at {@link EXTRA_MAX_CHARS} (16 KiB); an
   * over-budget value is OMITTED from the report — never sliced, which for
   * JSON would produce a fragment nothing can parse — and a warning is
   * logged (at the call site for string/object, at read time for a
   * resolver).
   */
  setExtra(value: string): void;
  setExtra(value: Record<string, unknown>): void;
  /**
   * Resolver form (preferred) — see the overview above. Called once per
   * report assembly, never inside `setExtra` itself, so the value it
   * returns always reflects the host's state at report time rather than at
   * registration time.
   */
  setExtra(resolve: ExtraResolver): void;
  /**
   * Drop a host-supplied marker into the action-timeline chain (spec §5) —
   * e.g. "checkout started", "feature flag X on". Redaction-passed and
   * size-capped exactly like automatic crumbs; lands in payload.breadcrumbs.
   */
  addBreadcrumb(input: AddBreadcrumbInput): void;
  /** Report a caught exception without opening UI. No-op when reporting is disabled or killed. */
  captureException(error: unknown, options?: CaptureExceptionOptions): void;
  kill(): void;
}

/**
 * Discriminated so a resolved string can never be confused with an
 * unresolved resolver awaiting its call — overloading the `string` field
 * with a magic sentinel would make "no extra set" and "resolver not yet
 * called" indistinguishable to a reader.
 */
export type ExtraState =
  | { kind: 'value'; value: string }
  | { kind: 'resolver'; resolve: ExtraResolver };

interface ClientState {
  config: TraceItXConfig | null;
  user: UserMetadata | null;
  extra: ExtraState;
  killed: boolean;
  breadcrumbs: BreadcrumbBuffer;
  /**
   * Dedicated network request/response body buffer (spec 2026-07-18 §7). Lives
   * in client state alongside `breadcrumbs` so it shares the same freeze/clear
   * lifecycle + zeroization posture — SEPARATE from the crumb chain's trim.
   */
  networkBodies: NetworkBodyBuffer;
  /**
   * Reporter identity recognition (spec 2026-08-06). In-memory only — see
   * reporter/identity-token.ts's header comment for why nothing here is ever
   * persisted. The platform layer reads this via `__internalClientState` (the
   * same seam used for `breadcrumbs`/`networkBodies`) to attach the token to
   * submits and reporter API calls.
   */
  identityToken: IdentityTokenHolder;
}

/**
 * Normalize an unknown throw into the `onError` contract's shape. Exported so
 * every producer that surfaces an SDK-internal error to the host app (the
 * client's safeWrap chain here, the web reporter's lazy tree walk) speaks the
 * same shape rather than each inventing one.
 */
export function toTraceItXError(err: unknown): TraceItXError {
  if (err instanceof Error) {
    const e: TraceItXError = { name: err.name, message: err.message };
    if (err.stack) e.stack = err.stack;
    return e;
  }
  return { name: 'Unknown', message: String(err) };
}

/** Shared by the eager string form (setExtra) and a resolver's string result (resolveClientExtra). */
function warnExtraStringOverBudget(source: string, length: number): void {
  // eslint-disable-next-line no-console
  console.warn(
    `[traceitx] ${source}: ${length} chars exceeds the ${EXTRA_MAX_CHARS} limit. ` +
      'It will be omitted from the report.',
  );
}

/**
 * Budgets an object value the same way for every source that can produce
 * one — the eager object form (setExtra) and a resolver's object result
 * (resolveClientExtra) — so a resolver cannot be a way to smuggle an
 * over-budget payload past the rules the object form already enforces.
 * Returns the serialized JSON when it fits, or '' (never a truncated
 * fragment) when it doesn't, after warning once.
 */
function budgetExtraObjectOrWarn(source: string, value: Record<string, unknown>): string {
  const budgeted = budgetExtra(value);
  if (budgeted !== null) return budgeted;
  let serializedLength: number | string = 'unserializable (cycle or BigInt)';
  try {
    serializedLength = JSON.stringify(value).length;
  } catch {
    // Cyclic reference or BigInt — leave the fallback text above.
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[traceitx] ${source}: serialized value (${serializedLength} chars) exceeds the ` +
      `${EXTRA_MAX_CHARS}-char limit; extra will be omitted.`,
  );
  return '';
}

/**
 * THE single resolve seam for `payload.extra` (spec 2026-09-17
 * setExtra-resolver). Every reader that needs the current `extra` value —
 * `@traceitx/web`'s in-app + companion report-build paths, `@traceitx/react`'s
 * equivalents — MUST call this rather than reading `ClientState.extra`
 * directly, or it gets the unresolved `{ kind: 'resolver' }` record instead
 * of a value.
 *
 * Resolution happens HERE, at read time — once per call, so a second report
 * re-invokes the resolver and sees fresh values (no caching across calls).
 * A throwing resolver is caught and warned so a diagnostic feature can never
 * abort the diagnostic it's attached to; the report proceeds with `extra`
 * omitted rather than failing.
 */
export function resolveClientExtra(client: TraceItXClient): string {
  const state = __internalClientState.get(client);
  if (!state) return '';
  const extra = state.extra;
  if (extra.kind === 'value') return extra.value;

  let result: string | Record<string, unknown>;
  try {
    result = extra.resolve();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[traceitx] setExtra: the resolver function threw while building a report; ' +
        'extra will be omitted from this report.',
      err,
    );
    return '';
  }

  if (typeof result === 'string') {
    if (result.length > EXTRA_MAX_CHARS) {
      warnExtraStringOverBudget('setExtra (resolver)', result.length);
      return '';
    }
    return result;
  }
  return budgetExtraObjectOrWarn('setExtra (resolver)', result);
}

export function createClient(adapter: PlatformAdapter): TraceItXClient {
  const state: ClientState = {
    config: null,
    user: null,
    extra: { kind: 'value', value: '' },
    killed: false,
    breadcrumbs: null as unknown as BreadcrumbBuffer, // assigned immediately below
    networkBodies: null as unknown as NetworkBodyBuffer, // assigned immediately below
    identityToken: null as unknown as IdentityTokenHolder, // assigned immediately below
  };
  state.breadcrumbs = createBreadcrumbBuffer({
    getRedaction: () => state.config?.redaction ?? {},
  });
  state.networkBodies = createNetworkBodyBuffer();
  state.identityToken = new IdentityTokenHolder();

  const handlers = {
    init(config: TraceItXConfig): void {
      if (state.killed) return;
      const prior = state.config;
      state.config = config;
      // Follow-up (spec 2026-08-12-followups-cleanup-round): everything below
      // was captured or declared under `prior.apiKey` and must not cross into
      // a different tenant. Same rule the outbox already follows (spec
      // 2026-08-12-outbox-key-binding): state belongs to the key that created
      // it. Keyed on CHANGE, not fired on every init(), so a same-key re-init
      // (config refresh, hot reload) does not silently discard a crumb trail.
      //
      // `apiKey` alone is the tenant identity here: unlike the natives, web
      // has no endpoint in TraceItXConfig — INGEST_URL is a build-time
      // constant (sdk-react constants.ts) and cannot differ between two
      // init() calls in one process.
      //
      // clear(), NOT kill(), on both buffers: both document clear() as the
      // wipe for "logout/identity change", and the buffer must keep accepting
      // entries for the new tenant. kill() is permanent.
      if (prior && prior.apiKey !== config.apiKey) {
        state.user = null;
        state.extra = { kind: 'value', value: '' };
        // Drops the source AND any cached token, and bumps the holder's
        // generation so an in-flight provider call cannot write its result
        // into the new tenant's cache. Same call kill() makes below.
        state.identityToken.set(null);
        state.breadcrumbs.clear();
        state.networkBodies.clear();
      }
      // DEFE-01 still holds: NO I/O, NO patching, NO timers, NO event
      // listeners. The block above is local state assignment only — it calls
      // no adapter method.
    },
    setUser(user: UserMetadata | null): void {
      if (state.killed || !state.config) return;
      // External review, finding 1 (Serious) — PROJECT, never store the host's
      // object. `UserMetadata` is a TypeScript interface, so `setUser(currentUser)`
      // with the app's own user object type-checks and used to ship every other
      // property on it (access tokens, addresses, roles, nested profile blobs)
      // straight into the envelope, the outbox, event storage and outbound
      // webhooks. Doing it HERE — the point where the value enters the SDK —
      // makes every downstream reader (`state.user`: the Provider's getter for
      // the in-process report path, `CompanionHost.getUser` for the companion
      // path, and the web crash sink) clean by construction instead of each one
      // having to remember. `projectUserMetadata` also copies, so a later host
      // mutation of the same object cannot change what ships.
      state.user = projectUserMetadata(user);
    },
    setIdentityToken(source: IdentityTokenSource): void {
      if (state.killed || !state.config) return;
      state.identityToken.set(source);
    },
    markSensitive(_target: unknown): void {
      if (state.killed || !state.config) return;
      // Adapter resolves target → rect at capture time (Plan 04 wires this).
    },
    setExtra(value: string | Record<string, unknown> | ExtraResolver): void {
      if (state.killed || !state.config) return;
      if (typeof value === 'function') {
        // KEY DESIGN POINT: do NOT call `value()` here. Resolving eagerly at
        // registration time would reintroduce exactly the staleness the
        // resolver form exists to remove — the whole point is that the host's
        // function runs when the SDK assembles the report (see
        // `resolveClientExtra`), not now.
        state.extra = { kind: 'resolver', resolve: value };
        return;
      }
      if (typeof value === 'string') {
        if (value.length > EXTRA_MAX_CHARS) {
          // Warn HERE, at the call site, where the host can still act. The old
          // code discovered this at envelope-build time and said nothing.
          warnExtraStringOverBudget('setExtra', value.length);
        }
        state.extra = { kind: 'value', value };
        return;
      }
      state.extra = { kind: 'value', value: budgetExtraObjectOrWarn('setExtra', value) };
    },
    captureException(error: unknown, options?: CaptureExceptionOptions): void {
      if (state.killed || !state.config || state.config.disabled || state.config.crashReporting?.disabled) return;
      adapter.captureException?.(error, options);
    },
    addBreadcrumb(input: AddBreadcrumbInput): void {
      if (state.killed || !state.config) return;
      if (!input || typeof input.message !== 'string') return;
      const kind =
        input.kind && (BreadcrumbKind.options as readonly string[]).includes(input.kind)
          ? input.kind
          : 'custom';
      // Coerce-never-throw: an invalid level is dropped (not passed through),
      // so a JS caller can never produce a crumb that fails envelope validation.
      const level =
        input.level && LEVELS.includes(input.level) ? input.level : undefined;
      state.breadcrumbs.add({
        kind,
        message: input.message,
        ...(level ? { level } : {}),
        ...(input.data && typeof input.data === 'object' && !Array.isArray(input.data)
          ? { data: input.data }
          : {}),
      });
    },
    kill(): void {
      state.killed = true;
      // Terminally shut down the adapter's thread client BEFORE zeroizing
      // buffers — otherwise a poll already in flight (or one armed for the
      // next tick) keeps firing /api/reporter/threads requests after kill()
      // returns (finding I1). stopPolling() alone is NOT enough: it only
      // flips `active` off and is deliberately reversible — the mounted
      // Provider's visibilitychange listener calls `threads.wake()` directly
      // on the adapter (bypassing this facade's own `killed` gate), and
      // wake() does `if (!active) startPolling()`, so traffic would resume
      // the moment the tab regains focus. shutdown() is the irreversible
      // counterpart: no caller holding a reference to the adapter's
      // ThreadClient can resurrect it, no matter how they reach it
      // (finding 6).
      try {
        adapter.threads?.shutdown();
      } catch {
        /* swallow — DEFE-02; kill() must never throw */
      }
      state.breadcrumbs.clear(); // zeroization posture: no crumbs survive kill
      // F17 (round-4 review): PERMANENT — kill(), not clear(). A clear() here
      // would zeroize once but leave the buffer willing to accept a body an
      // in-flight (already-past-its-enabled()-check) capture resolves later;
      // kill() makes every subsequent add() a no-op for good.
      state.networkBodies.kill();
      // Reporter identity recognition (spec 2026-08-06) — a host calling
      // kill() (sign-out, privacy opt-out) must not be left holding a live
      // signed credential in memory. set(null) clears both the source AND
      // any cached token (see identity-token.ts's `set()` doc), so a stray
      // late `get()` call after kill() resolves null exactly like no token
      // was ever set.
      state.identityToken.set(null);
      // External review, finding 2 (Serious) — the self-declared user
      // (`setUser`, spec 2026-08-12) must go the same way, for the same
      // zeroization posture the two buffers above are cleared under: nothing
      // captured or declared before the kill can survive it. It is
      // host-supplied PII (id / email / display name), so a host calling
      // kill() for a sign-out or a privacy opt-out must not be left with it
      // sitting in memory — where the crash sink's user getter
      // (`__setUserGetter` on the web adapter, which reads this field with no
      // `killed` check of its own) could still reach it.
      //
      // Parity: Android's `kill()` has always cleared `_user` inside its
      // `stateLock` critical section alongside `_config`; iOS did not, which
      // is the platform half of this same finding.
      state.user = null;
      // F17/F18 — notify the adapter synchronously, AFTER the buffer is
      // already killed above, so a same-tick capture attempt triggered by
      // onKill() itself (there is none today, but future-proofing the
      // ordering costs nothing) would still find the buffer refusing writes.
      // The adapter uses this to flip its own capture-gate checks and cancel
      // any periodic config-refresh timer it owns (see PlatformAdapter.onKill
      // doc comment).
      try {
        adapter.onKill?.();
      } catch {
        /* swallow — DEFE-02 */
      }
    },
    async openReport(): Promise<{ reportId: string } | null> {
      if (state.killed || !state.config) return null;
      // Plan 04 wires capture → redact → multipart → submit.
      // For now: stub returns null so the wave-3 deliverable is the wired API surface,
      // and wave-4 plan-04 fills in the round-trip body.
      return null;
    },
  };

  const onError = (err: unknown): void => state.config?.onError?.(toTraceItXError(err));

  const inertThreads = {
    list: () => [] as ThreadSummary[],
    unreadCount: () => 0,
    getState: () =>
      ({
        enabled: false,
        readOnly: false,
        threads: [],
        unreadCount: 0,
        pending: [],
        cooldownUntilMs: null,
      }) as ThreadClientState,
  };

  // Same guard shape as every other handler above (`killed || !config`), plus
  // the platform-adapter-may-not-wire-it case unique to this facade.
  function threadsOrNull(): ThreadClient | null {
    if (state.killed || !state.config) return null;
    return adapter.threads ?? null;
  }

  const client: TraceItXClient = {
    init: safeWrap(handlers.init, { name: 'init', onError }),
    setUser: safeWrap(handlers.setUser, { name: 'setUser', onError }),
    setIdentityToken: safeWrap(handlers.setIdentityToken, { name: 'setIdentityToken', onError }),
    markSensitive: safeWrap(handlers.markSensitive, { name: 'markSensitive', onError }),
    setExtra: safeWrap(handlers.setExtra, { name: 'setExtra', onError }),
    addBreadcrumb: safeWrap(handlers.addBreadcrumb, { name: 'addBreadcrumb', onError }),
    captureException(error: unknown, options?: CaptureExceptionOptions): void {
      try {
        handlers.captureException(error, options);
      } catch (err) {
        // Reporting a failure must stay safe even if the host's diagnostic callback fails.
        try { onError(err); } catch { /* swallow */ }
      }
    },
    kill: safeWrap(handlers.kill, { name: 'kill', onError }),
    report: {
      open: safeWrap(handlers.openReport, { name: 'report.open', onError }) as () => Promise<{
        reportId: string;
      } | null>,
    },
    threads: {
      list: safeWrap(
        () => threadsOrNull()?.list() ?? inertThreads.list(),
        { name: 'threads.list', onError },
      ) as () => ThreadSummary[],
      get: safeWrap(
        async (id: string) => (await threadsOrNull()?.get(id)) ?? null,
        { name: 'threads.get', onError },
      ) as (threadId: string) => Promise<ThreadDetail | null>,
      reply: safeWrap(
        async (id: string, body: string) => {
          await threadsOrNull()?.reply(id, body);
        },
        { name: 'threads.reply', onError },
      ) as (threadId: string, body: string) => Promise<void>,
      retryMessage: safeWrap(
        async (localId: string) => {
          await threadsOrNull()?.retryMessage(localId);
        },
        { name: 'threads.retryMessage', onError },
      ) as (localId: string) => Promise<void>,
      markRead: safeWrap(
        async (id: string) => {
          await threadsOrNull()?.markRead(id);
        },
        { name: 'threads.markRead', onError },
      ) as (threadId: string) => Promise<void>,
      delete: safeWrap(
        async (id: string): Promise<boolean> => {
          // Finding 5 (round 6, PR review) — `true` is the documented
          // contract only for a genuine local removal. When the facade is
          // inert (pre-init, post-kill, or no adapter thread client at all)
          // no delete happens, so this must resolve `false` rather than
          // falling through the optional chain to an unconditional `true`.
          const threads = threadsOrNull();
          if (!threads) return false;
          try {
            await threads.deleteThread(id);
            return true;
          } catch (err) {
            // deleteThread() rethrows on anything other than success/404 so
            // its caller can distinguish "gone" from "failed, still there"
            // (finding 5). Report it through the normal onError channel
            // (safeWrap's own catch never sees it, since we catch here) and
            // resolve false so the UI can show a retry instead of treating
            // this the same as a completed delete.
            onError(err);
            return false;
          }
        },
        { name: 'threads.delete', onError },
      ) as (threadId: string) => Promise<boolean>,
      unreadCount: safeWrap(
        () => threadsOrNull()?.unreadCount() ?? inertThreads.unreadCount(),
        { name: 'threads.unreadCount', onError },
      ) as () => number,
      getState: safeWrap(
        () => threadsOrNull()?.getState() ?? inertThreads.getState(),
        { name: 'threads.getState', onError },
      ) as () => ThreadClientState,
      subscribe: safeWrap(
        (cb: (s: ThreadClientState) => void) => threadsOrNull()?.subscribe(cb) ?? (() => {}),
        { name: 'threads.subscribe', onError },
      ) as (cb: (state: ThreadClientState) => void) => () => void,
      refresh: safeWrap(
        async () => {
          await threadsOrNull()?.refresh();
        },
        { name: 'threads.refresh', onError },
      ) as () => Promise<void>,
    },
  };

  __internalClientState.set(client, state);
  return client;
}

// Internal accessor for tests + Plan 04 (transport calls). Not part of public API.
export const __internalClientState = new WeakMap<TraceItXClient, ClientState>();

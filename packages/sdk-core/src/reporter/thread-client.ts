// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Thread client: the single stateful home of the reporter's threads. The
// public tx.threads.* facade (client.ts) and the built-in inbox UI both read
// exclusively from here. Polling follows the config-provider posture:
// fail-closed (errors never wipe cached state), idle-to-zero (no enabled
// gate, no token, or no open threads ⇒ no requests), 60-second floor.
import type { ReporterCredentialStore } from '../types/platform.js';
import { ReporterApiError } from './api.js';
import type { ReporterApi, ThreadSummary, ThreadMessage } from './api.js';

export const POLL_FLOOR_MS = 60_000;
// Spec (2026-07-31): "optimistic 'sending' state, retried on the next 3
// polls, then manual retry affordance" — i.e. the reporter sees exactly
// THREE poll-driven retries after the initial POST fails, not two. attempts
// counts every failed postMessage() call, starting with the very first one
// (fired synchronously from reply()/retryMessage(), before any poll ever
// runs) — so the cap must cover 1 initial attempt + 3 poll retries = 4
// total failed POSTs before the message flips to 'failed' (finding 8).
export const MAX_SEND_ATTEMPTS = 4;
// get() walks message pages oldest-first, keeping a sliding window of the
// most recent MESSAGE_FETCH_WINDOW messages (trimming the front as it goes)
// so long threads surface their NEWEST messages rather than their oldest
// (finding 8-SDK). MESSAGE_FETCH_PAGE_HARD_CAP is a safety ceiling against a
// server that never reports hasMore:false — unrelated to the window size.
// The walk is RESUMABLE (finding 2-SDK): the server allows only 60
// message-page reads/minute, so a thread past ~60 pages deterministically
// 429s mid-walk. get() persists a per-thread checkpoint (WalkCheckpoint,
// below) on a transient failure instead of discarding progress, and the
// ceiling is charged against pages consumed ACROSS every call that has
// contributed to one walk (see WalkCheckpoint.pagesConsumed), not reset to
// zero per call — otherwise a walk that always failed around the same page
// could restart at page 0 forever without ever making net progress.
export const MESSAGE_FETCH_WINDOW = 500;
export const MESSAGE_FETCH_PAGE_HARD_CAP = 100;

export interface PendingMessage {
  localId: string;
  threadId: string;
  body: string;
  state: 'sending' | 'failed';
  attempts: number;
  createdAt: string;
}

export interface ThreadClientState {
  enabled: boolean;
  readOnly: boolean;
  threads: ThreadSummary[];
  unreadCount: number;
  pending: PendingMessage[];
  cooldownUntilMs: number | null;
}

/**
 * 'older-dropped' — the sliding window kept only the most recent
 *   MESSAGE_FETCH_WINDOW messages; earlier ones were trimmed off the front
 *   as the walk progressed. The messages shown ARE the true latest ones, so
 *   treating the thread as "read" is still accurate (mirrors the admin
 *   panel's the dashboard thread API ThreadTruncation).
 * 'incomplete' — MESSAGE_FETCH_PAGE_HARD_CAP was hit before the server
 *   reported hasMore:false. Unlike 'older-dropped', we cannot vouch that the
 *   window holds the true latest messages — the server may still have more,
 *   newer pages we never reached — so this must NOT be treated as "read".
 * false — nothing was dropped; every message the server has is present.
 */
export type ThreadTruncation = 'older-dropped' | 'incomplete' | false;

export interface ThreadDetail {
  id: string;
  status: 'open' | 'closed';
  reportTitle: string | null;
  messages: ThreadMessage[];
  pending: PendingMessage[];
  /** See {@link ThreadTruncation}. */
  truncation: ThreadTruncation;
  /**
   * True only when THIS call's fetch fully succeeded end to end. False for
   * a cached or sentBuffer-only fallback returned after a transient
   * failure (finding 2-SDK) — a failed/incomplete get() must never be
   * treated as having confirmed the reporter saw the current messages, so
   * callers (ThreadView) must gate markRead on `fresh` in addition to
   * `truncation !== 'incomplete'`.
   */
  fresh: boolean;
}

/**
 * Per-thread resume state for the message-page walk (finding 2-SDK).
 * Internal only — not part of the public ThreadClient surface. Present in
 * the map iff the walk it describes has not yet reached a genuine
 * hasMore:false end (i.e. iff the corresponding ThreadDetail would report
 * truncation:'incomplete'); cleared the moment the walk completes.
 */
interface WalkCheckpoint {
  /** Cursor to resume from: the last successful page's nextCursor, or null
   * if no page has been consumed yet by this walk. */
  cursor: string | null;
  /** Sliding-window messages accumulated so far, already trimmed to
   * MESSAGE_FETCH_WINDOW as the walk progressed. */
  messages: ThreadMessage[];
  /** Whether the window has already trimmed older messages off the front. */
  windowTrimmed: boolean;
  /** Pages successfully consumed so far, summed across every get() call
   * that has contributed to this walk — see MESSAGE_FETCH_PAGE_HARD_CAP. */
  pagesConsumed: number;
  /** ids observed in any fetched page so far, across the whole walk — feeds
   * the finding 4-SDK sentBuffer pruning so a resumed walk doesn't re-leak
   * an already-confirmed local send that was seen in an earlier call. */
  observedIds: string[];
  status: 'open' | 'closed';
}

export interface ThreadClientDeps {
  api: ReporterApi;
  credentials: ReporterCredentialStore | null;
  isEnabled: () => boolean;
  now?: () => number;
  pollIntervalMs?: number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /**
   * Finding 1 (round 5) — a deliberate wake() signal (visibility return, a
   * submit that provisions a thread) is the only place the `isEnabled()`
   * config gate ever gets a chance to re-resolve: the gate's backing
   * provider is fetched once and then cached for its own TTL (5 min), so a
   * config flip that happens WHILE the tab is open (replies turned on
   * server-side, or the one mount-time fetch transiently failed) would
   * otherwise idle the poller to zero forever. When present, wake() awaits
   * this BEFORE deciding whether to arm — fail-closed: a throwing/hanging
   * refreshGate must never break wake() (caught, then wake() proceeds with
   * whatever isEnabled() reports). Never invoked from the ordinary poll
   * tick — the 60s floor / idle-to-zero cadence is unaffected by this dep.
   */
  refreshGate?: () => Promise<void>;
}

export interface ThreadClient {
  getState(): ThreadClientState;
  list(): ThreadSummary[];
  unreadCount(): number;
  subscribe(cb: (state: ThreadClientState) => void): () => void;
  refresh(): Promise<void>;
  wake(): void;
  startPolling(): void;
  stopPolling(): void;
  get(threadId: string): Promise<ThreadDetail | null>;
  reply(threadId: string, body: string): Promise<void>;
  retryMessage(localId: string): Promise<void>;
  markRead(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  /**
   * Terminal, irreversible shutdown (finding 6). Unlike stopPolling() — which
   * only flips `active` off and is deliberately resumable by wake()/
   * startPolling() — shutdown() permanently disarms this client. Every
   * caller that can reach this instance directly (not just through the
   * public tx.threads.* facade, which already gates on client.kill()'s own
   * `killed` flag) is a potential escape path: the mounted Provider's
   * visibilitychange listener calls `threads.wake()` on the adapter
   * directly, and a stale FAB can call `threads.refresh()` directly. Both
   * bypass client.ts entirely, so the guard has to live here, not just in
   * client.ts.
   *
   * After shutdown(): startPolling/wake/refresh/pollOnce and the
   * poll-driven send-retry loop are permanent no-ops; get/reply/
   * retryMessage/markRead/deleteThread resolve to their no-op value
   * (null/undefined) without throwing; observable state resets to empty
   * (threads: [], pending: [], unreadCount: 0, enabled: false); subscribers
   * receive that final empty snapshot exactly once and are then cleared, so
   * mounted UI (FAB, inbox) drops away. Idempotent — safe to call more than
   * once. stopPolling() remains safe to call after shutdown() (the
   * Provider's own effect cleanup calls it unconditionally on unmount).
   */
  shutdown(): void;
}

export function createThreadClient(deps: ThreadClientDeps): ThreadClient {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const intervalMs = Math.max(POLL_FLOOR_MS, deps.pollIntervalMs ?? POLL_FLOOR_MS);

  let threads: ThreadSummary[] = [];
  let pending: PendingMessage[] = [];
  // Reporter messages confirmed by a 201 but not yet visible via a re-fetch,
  // merged into get() results and deduped by id once the server echoes them.
  const sentBuffer = new Map<string, ThreadMessage[]>();
  // Last successfully fetched ThreadDetail per thread. get() falls back to
  // this (with current pending re-merged) on a transient failure, instead of
  // the degraded sentBuffer-only view, so an offline refresh doesn't erase
  // already-visible history (finding 6). Cleared per-thread on
  // dropThreadLocal and wholesale on the invalid_device_token full reset.
  const lastDetail = new Map<string, ThreadDetail>();
  // Resume checkpoints for the message-page walk (finding 2-SDK). Cleared
  // per-thread on dropThreadLocal and wholesale on the invalid_device_token
  // full reset — same lifecycle as lastDetail/sentBuffer.
  const walkCheckpoints = new Map<string, WalkCheckpoint>();
  let etag: string | null = null;
  let readOnly = false;
  // Finding 1 (round 8, PR review): set the first time a poll observes
  // deps.isEnabled() === true. Distinguishes a genuine ON->OFF config-gate
  // TRANSITION (which must reconcile into the replies_disabled latch, same
  // as a 401 would) from a client that has never seen the gate enabled —
  // replies off from the start, or the config provider still unresolved at
  // the first tick — which must keep idling silently, exactly as before.
  // Never reset by handleAuthFailure/wake(), so a client that goes
  // ON -> OFF -> (wake() clears readOnly) -> still OFF re-latches cleanly on
  // the very next poll instead of being treated as "never enabled" again.
  let wasEnabled = false;
  let cooldownUntilMs: number | null = null;
  // Finding 1 (round 9, PR review): the reporter API enforces THREE
  // independent per-device rate buckets — rmsg (10 sends/hour, this file's
  // `cooldownUntilMs`), rmread (60 message-page reads/minute, tracked here),
  // rpoll (10 thread-list polls/minute, handled entirely inside pollOnce()'s
  // own retryAfter-driven nextDelayMs — never touches either cooldown
  // field). A single shared cooldown used to couple rmsg and rmread: a send
  // 429 (with an hourly retryAfter) made get()'s short-circuit refuse every
  // message read for up to an hour too, hiding an already-waiting team
  // reply; the reverse coupling (a read 429 suppressing reply()'s POST) also
  // existed. `cooldownUntilMs` stays the public, SEND-only cooldown —
  // ThreadClientState.cooldownUntilMs is exactly what it always was, still
  // consumed by ThreadView's composer gating/cooldown timer. This field is
  // internal-only: written solely by get()'s rate_limit_exceeded catch,
  // read solely by get()'s own short-circuit above the network call.
  let readCooldownUntilMs: number | null = null;
  // Finding 2 (round 10, PR review): a read 429 used to set
  // readCooldownUntilMs and notify() once, with no recovery path of its
  // own — the deadline is internal, no timer schedules another get(), and
  // ordinary ETag-304 list polls don't notify. So crossing the deadline
  // changed no observable state and a rate-limited message walk stayed
  // parked until an unrelated notification or a close/reopen. This holds
  // the handle for a one-shot wake (via the injected schedule/cancel
  // deps, never raw setTimeout) armed at the read-cooldown deadline; its
  // sole job is notify()ing subscribers so a subscribed view reloads and
  // the resumable walk checkpoint advances — it never touches
  // active/timerHandle, so it can't resurrect the poll loop. A second read
  // 429 replaces the pending wake (see armReadCooldownWake) rather than
  // stacking a second timer; shutdown() cancels it, same as the poll
  // timer. Finding 2 residual (round 10 re-review, Issue A): stopPolling()
  // ALSO cancels it — a pending wake used to survive a hidden tab and
  // fire independently, the first path that initiated network traffic
  // after stopPolling(), violating the foreground-only posture the
  // pause-epoch machinery otherwise enforces. Recovery now happens
  // exclusively on the foreground path, in wake().
  let readCooldownWakeHandle: unknown = null;
  let active = false;          // polling loop armed
  // Bumped by every stopPolling() call (round-5 re-review, finding 1
  // follow-up). wake()'s async refreshGate continuation captures this
  // BEFORE awaiting the gate; if it has moved by the time the gate
  // settles, a pause (stopPolling — e.g. the tab went hidden) happened
  // mid-flight and the continuation must not arm polling, or a hidden tab
  // would end up polling until the next visibility transition. A later,
  // genuine wake() call captures a fresh value, so this never permanently
  // blocks future wakes.
  let pauseEpoch = 0;
  let inFlight = false;        // a pollOnce is running
  let timerHandle: unknown = null;
  let localSeq = 0;
  // Per-message send lock: localIds with a postMessage() currently in flight.
  // Guards against retryPendingSends() (poll-driven) racing a direct
  // reply()/retryMessage() call for the same pending message, which would
  // otherwise fire two concurrent POSTs and duplicate the message server-side.
  const sendingInFlight = new Set<string>();
  const subscribers = new Set<(s: ThreadClientState) => void>();
  // Terminal shutdown latch (finding 6). Unlike `active`/readOnly — both of
  // which are reversible by design (wake()/startPolling() re-arm `active`;
  // wake() clears the replies_disabled readOnly latch) — this never resets.
  // Checked at the top of every method that does I/O, arms a timer, or
  // mutates observable state, so a caller holding a reference to this
  // ThreadClient directly (bypassing the tx.threads.* facade's own `killed`
  // gate in client.ts) can never resurrect traffic after shutdown().
  let shutdownFlag = false;

  function snapshot(): ThreadClientState {
    if (shutdownFlag) {
      // Forced empty/disabled regardless of deps.isEnabled() or any state
      // left over from before shutdown — the UI (FAB, inbox) must read this
      // as "nothing here" so it drops away.
      return { enabled: false, readOnly: false, threads: [], unreadCount: 0, pending: [], cooldownUntilMs: null };
    }
    return {
      enabled: deps.isEnabled(),
      readOnly,
      threads: threads.slice(),
      unreadCount: threads.reduce((sum, t) => sum + t.unreadCount, 0),
      pending: pending.slice(),
      cooldownUntilMs,
    };
  }

  function notify(): void {
    const state = snapshot();
    for (const cb of subscribers) {
      try {
        cb(state);
      } catch {
        // A subscriber must never break the client (safe-wrap posture).
      }
    }
  }

  async function loadToken(): Promise<string | null> {
    if (!deps.credentials) return null;
    try {
      return await deps.credentials.load();
    } catch {
      return null;
    }
  }

  function handleAuthFailure(err: ReporterApiError): void {
    if (err.code === 'invalid_device_token') {
      // Spec: silently discard the token and local state; next report mints fresh.
      // Finding 3 (round 9, PR review): unlike replies_disabled below, this
      // WIPES pending outright rather than failing it in place — the
      // device identity itself is gone (token cleared; a fresh one mints on
      // the next report), so there is no surviving local conversation to
      // show a failed bubble inside. replies_disabled keeps the identity
      // and thread list intact (merely closed/read-only), so a queued send
      // there stays visible as 'failed' instead of vanishing.
      void deps.credentials?.clear().catch(() => {});
      threads = [];
      pending = [];
      sentBuffer.clear();
      lastDetail.clear();
      walkCheckpoints.clear();
      etag = null;
      // Finding 2 residual (round 10 re-review, Issue B): stopPolling()
      // below now cancels any pending read-cooldown wake too, but cancel
      // it explicitly here as well — a stale one-shot left pointing at a
      // deadline this reset has already made irrelevant would otherwise
      // fire into a guarded (shutdownFlag/readOnly-checked) no-op, which
      // is harmless but pointless. Cheap to guarantee directly rather than
      // rely solely on stopPolling()'s cascade.
      cancelReadCooldownWake();
      stopPolling();
      notify();
    } else if (err.code === 'replies_disabled') {
      // Spec: polling stops; existing threads go read-only.
      readOnly = true;
      threads = threads.map((t) => ({ ...t, status: 'closed' as const }));
      // Finding 3 (round 9, PR review): the latch closes every conversation
      // PERMANENTLY — unlike a send cooldown (which lifts) or a transient
      // failure (which retries), a thread closed by replies_disabled never
      // reopens on its own, so a queued 'sending' entry can never succeed.
      // Left alone it would show "Sending…" forever under "This
      // conversation is closed", with no cooldown or poll left to advance
      // it. Transition every still-queued send straight to the terminal
      // 'failed' state, preserving its body so the reporter's typed text
      // stays visible (with the existing Retry affordance, which is itself
      // moot here since every future attempt would 401 too — but at least
      // the state is honest and not stuck).
      //
      // This is DELIBERATELY different from invalid_device_token below,
      // which wipes `pending` outright: that path means the device
      // identity itself is gone (token cleared, fresh one mints on the next
      // report) — there is no local conversation left to show a failed
      // bubble IN, so nothing survives. replies_disabled keeps the identity
      // and the thread list intact (just closed/read-only), so the
      // reporter's attempted text should stay visible as 'failed' rather
      // than vanish.
      pending = pending.map((p) => (p.state === 'sending' ? { ...p, state: 'failed' as const } : p));
      // The cached ETag hashes the server's list JSON, which disabling
      // replies does NOT change — so it stays valid against the server even
      // though our local copy is now wrong (all statuses forced closed).
      // Clearing it here, at the moment the local view diverges from the
      // server, guarantees the first poll after wake() clears the latch is
      // a full 200 rather than a 304 that would leave the locally-closed
      // statuses (and thus anyOpen === false, idling the poller) uncorrected
      // indefinitely.
      etag = null;
      // Finding 2 residual (round 10 re-review, Issue B): same explicit
      // cancel as the invalid_device_token branch above — belt-and-braces
      // alongside stopPolling()'s own cascade.
      cancelReadCooldownWake();
      stopPolling();
      notify();
    }
  }

  /** One poll: list threads (ETag-aware) and retry queued sends. */
  async function pollOnce(): Promise<{ nextDelayMs: number | null }> {
    if (shutdownFlag) return { nextDelayMs: null };
    const enabledNow = deps.isEnabled();
    if (enabledNow) {
      wasEnabled = true;
    } else if (wasEnabled && !readOnly) {
      // Finding 1 (round 8, PR review): the config gate flipped ON -> OFF
      // (every deliberate wake() force-refreshes it) since the last time
      // this client saw it enabled. Left alone, pollOnce() would idle
      // silently right here — no request ever fires, so no reporter
      // response could ever produce the replies_disabled 401 that's
      // normally what engages the latch. Reconcile into that SAME latch
      // state directly: readOnly, closed cached rows, cleared ETag,
      // stopped polling, exactly one notify — by reusing handleAuthFailure
      // rather than duplicating its bookkeeping. A synthetic error is
      // sufficient; handleAuthFailure only branches on `.code`.
      handleAuthFailure(new ReporterApiError('replies_disabled', null));
      return { nextDelayMs: null };
    }
    if (!enabledNow || readOnly) return { nextDelayMs: null };
    const token = await loadToken();
    if (!token) return { nextDelayMs: null };
    try {
      const result = await deps.api.listThreads(token, etag);
      if (result.kind === 'ok') {
        threads = result.threads;
        etag = result.etag;
        notify();
      }
      await retryPendingSends(token);
      const anyOpen = threads.some((t) => t.status === 'open');
      const anySending = pending.some((p) => p.state === 'sending');
      return { nextDelayMs: anyOpen || anySending ? intervalMs : null };
    } catch (err) {
      if (err instanceof ReporterApiError) {
        if (err.code === 'invalid_device_token' || err.code === 'replies_disabled') {
          handleAuthFailure(err);
          return { nextDelayMs: null };
        }
        if (err.code === 'rate_limit_exceeded') {
          const waitMs = Math.max(intervalMs, (err.retryAfter ?? 60) * 1000);
          return { nextDelayMs: waitMs };
        }
      }
      // network_error / malformed_response / anything else: fail closed,
      // keep the cached list, keep cadence.
      return { nextDelayMs: intervalMs };
    }
  }

  function markThreadClosed(threadId: string): void {
    threads = threads.map((t) => (t.id === threadId ? { ...t, status: 'closed' as const } : t));
  }

  function dropThreadLocal(threadId: string): void {
    threads = threads.filter((t) => t.id !== threadId);
    pending = pending.filter((p) => p.threadId !== threadId);
    sentBuffer.delete(threadId);
    lastDetail.delete(threadId);
    walkCheckpoints.delete(threadId);
  }

  /**
   * Build the best available offline view of a thread: the last
   * successfully fetched detail (finding 6) or, failing that, a
   * sentBuffer-only shape. Always fresh:false — a caller must never treat
   * this as confirming the reporter saw current messages. `forceClosed` is
   * set whenever the replies_disabled latch is (or is about to become)
   * engaged (finding 1-SDK): the client has deliberately closed every
   * thread locally, and a cached detail fetched before the latch engaged
   * may still say 'open', which would be stale and misleading now that
   * replies are known to be off.
   */
  function fallbackDetail(threadId: string, forceClosed: boolean): ThreadDetail | null {
    const summary = threads.find((t) => t.id === threadId);
    const cached = lastDetail.get(threadId);
    if (cached) {
      // Finding 2 (round 8, PR review): a successful attemptSend() drains
      // `pending` and buffers the confirmed message in sentBuffer, relying
      // on the NEXT successful get() to fold it into the returned view via
      // mergeSentBuffer(). If that reconciliation read fails, this cached
      // branch used to return only the stale cached messages plus current
      // `pending` — never sentBuffer — so a confirmed, just-delivered reply
      // vanished from the view until some later successful walk. Reuse
      // mergeSentBuffer() (dedupes by id against `cached.messages`) with an
      // EMPTY observedIds set: no page was fetched on this fallback path, so
      // nothing has been server-confirmed by observation and the buffer must
      // NOT be pruned here — only a real walk's own observedIds may do that.
      return {
        ...cached,
        status: forceClosed ? 'closed' : cached.status,
        messages: mergeSentBuffer(threadId, cached.messages, new Set()),
        pending: pending.filter((p) => p.threadId === threadId),
        fresh: false,
      };
    }
    return summary
      ? {
          id: threadId,
          status: forceClosed ? 'closed' : summary.status,
          reportTitle: summary.reportTitle,
          messages: sentBuffer.get(threadId) ?? [],
          pending: pending.filter((p) => p.threadId === threadId),
          truncation: false,
          fresh: false,
        }
      : null;
  }

  /**
   * Round-1 finding 6 residual (round-4 re-review): compares the newest
   * message of two candidate views to decide whether an in-progress
   * partial walk window is worth displaying over an already-cached detail.
   * The walk is oldest-first, so a partial window cut short by an
   * early-page transient failure is, by construction, the thread's OLDEST
   * fetched messages — strictly worse to show than a complete, already-
   * latest cached view. `(createdAt, id)` is cheap and obviously correct:
   * createdAt is server-assigned ISO-8601 (lexicographically ordered) and
   * ties only happen for the literal same message, where id breaks it.
   * `a` "wins" (returns true) when it is at least as new as `b`; a
   * candidate with no last message (empty/absent) never wins over one that
   * has one, and anything wins over nothing.
   */
  function isAtLeastAsNew(a: ThreadMessage | undefined, b: ThreadMessage | undefined): boolean {
    if (!a) return false;
    if (!b) return true;
    if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
    return a.id >= b.id;
  }

  /**
   * Prune sentBuffer entries confirmed by any page observed so far (finding
   * 4-SDK — pruned the moment an id is *observed*, before the window trims
   * it away, so a confirmed-but-now-outside-the-window send doesn't leak
   * back in as if it were the newest message) and append any still-
   * unconfirmed local sends not already present in the window.
   */
  function mergeSentBuffer(threadId: string, windowMessages: ThreadMessage[], observedIds: Set<string>): ThreadMessage[] {
    const buffered = sentBuffer.get(threadId);
    if (buffered) {
      const stillPending = buffered.filter((m) => !observedIds.has(m.id));
      if (stillPending.length > 0) sentBuffer.set(threadId, stillPending);
      else sentBuffer.delete(threadId);
    }
    const seen = new Set(windowMessages.map((m) => m.id));
    const result = windowMessages.slice();
    for (const local of sentBuffer.get(threadId) ?? []) {
      if (!seen.has(local.id)) result.push(local);
    }
    return result;
  }

  /** Attempt one pending send. Returns true when it should count an attempt. */
  async function attemptSend(token: string, msg: PendingMessage): Promise<void> {
    // A second caller (retryPendingSends racing a direct reply()/retryMessage()
    // call, or a rapid double-click of retryMessage()) for the same message
    // steps aside rather than firing a concurrent POST. Whoever holds the
    // lock owns reconciling this message's outcome.
    if (sendingInFlight.has(msg.localId)) return;
    sendingInFlight.add(msg.localId);
    try {
      const { id } = await deps.api.postMessage(token, msg.threadId, msg.body);
      pending = pending.filter((p) => p.localId !== msg.localId);
      const buf = sentBuffer.get(msg.threadId) ?? [];
      buf.push({ id, authorKind: 'reporter', authorName: null, body: msg.body, createdAt: new Date(now()).toISOString() });
      sentBuffer.set(msg.threadId, buf);
      // Finding 1 (round 10, PR review): the in-flight send lock
      // (sendingInFlight) is per-localId, so two DIFFERENT pending
      // messages can be POSTing concurrently. A success used to
      // unconditionally null out the device-wide send cooldown — so if
      // message A 429'd (setting an hour-long cooldown) while message B
      // was already in flight, B's later success erased A's still-future
      // cooldown, and the very next poll retried A early, straight back
      // into the server's rate limit. Only clear a deadline that has
      // already passed; a still-future cooldown belongs to whichever
      // request set it and must survive an unrelated success. The guards
      // that consult cooldownUntilMs (retryPendingSends/reply/
      // retryMessage) already compare `now() < cooldownUntilMs`, so a
      // stale expired value left behind here would be harmless anyway —
      // this just also tidies it up when there's nothing left to protect.
      if (cooldownUntilMs !== null && now() >= cooldownUntilMs) {
        cooldownUntilMs = null;
      }
      notify();
    } catch (err) {
      if (err instanceof ReporterApiError) {
        if (err.code === 'invalid_device_token' || err.code === 'replies_disabled') {
          handleAuthFailure(err);
          return;
        }
        if (err.code === 'rate_limit_exceeded') {
          // Cooldown, not failure (spec). No attempt consumed.
          cooldownUntilMs = now() + (err.retryAfter ?? 60) * 1000;
          notify();
          return;
        }
        if (err.code === 'thread_closed' || err.code === 'thread_not_found') {
          if (err.code === 'thread_closed') markThreadClosed(msg.threadId);
          else dropThreadLocal(msg.threadId);
          pending = pending.map((p) => (p.localId === msg.localId ? { ...p, state: 'failed' as const } : p));
          notify();
          return;
        }
        if (err.code === 'invalid_input') {
          // Finding 4 (round 9, PR review): a PERMANENT rejection — the
          // server has already told us this exact body will never be
          // accepted (e.g. over-length, reachable through the public
          // headless tx.threads.reply() even though the built-in textarea's
          // maxLength blocks it from that path). Unlike a network/5xx blip,
          // retrying the identical body changes nothing, so this must fail
          // immediately like thread_closed/thread_not_found above — no
          // attempt accounting, no further POSTs.
          pending = pending.map((p) => (p.localId === msg.localId ? { ...p, state: 'failed' as const } : p));
          notify();
          return;
        }
      }
      // Finding 3 residual (round-9 re-review, Minor): if a DIFFERENT call
      // latched replies_disabled (readOnly) while THIS message's own POST
      // was still in flight, handleAuthFailure() already flipped it to
      // 'failed' above. A latched client can never succeed a send — polling
      // (and thus retryPendingSends) is stopped, so 'sending' would be a
      // dead end with nothing left to advance it. Skip the ordinary
      // transient recompute entirely in that case and leave the entry
      // terminal, body intact. The normal (non-latched) 4-attempt cadence
      // below is unaffected.
      if (readOnly) return;
      // Genuine transient failure: count the attempt; flip to failed at the cap.
      pending = pending.map((p) => {
        if (p.localId !== msg.localId) return p;
        const attempts = p.attempts + 1;
        return { ...p, attempts, state: attempts >= MAX_SEND_ATTEMPTS ? 'failed' as const : 'sending' as const };
      });
      notify();
    } finally {
      sendingInFlight.delete(msg.localId);
    }
  }

  async function retryPendingSends(token: string): Promise<void> {
    if (shutdownFlag) return;
    if (cooldownUntilMs !== null && now() < cooldownUntilMs) return;
    for (const msg of pending.filter((p) => p.state === 'sending')) {
      // A message queued at the top of this tick may no longer be eligible
      // by the time its turn comes around: an invalid_device_token reset
      // triggered by an EARLIER message in this same batch wipes `pending`
      // entirely (handleAuthFailure), so attempting one that no longer
      // exists locally would be a doomed request against state we've
      // already discarded.
      if (!pending.some((p) => p.localId === msg.localId && p.state === 'sending')) continue;
      await attemptSend(token, msg);
      // Finding 3 (round 5): re-check the pause/terminal state after EACH
      // attempt, not just once before the loop. If the attempt just made
      // established a cooldown (429), latched readOnly (replies_disabled),
      // or triggered a terminal shutdown, stop immediately instead of
      // hammering the rest of the queued batch in the same tick — the
      // server (or our own state machine) just told us to back off. The
      // messages already attempted above keep whatever outcome they got;
      // only the REMAINING, unattempted ones are left queued for a later
      // tick.
      if (shutdownFlag || readOnly || (cooldownUntilMs !== null && now() < cooldownUntilMs)) break;
    }
  }

  /**
   * Cancels any pending read-cooldown recovery wake without arming a
   * replacement. Idempotent — a no-op when nothing is pending.
   */
  function cancelReadCooldownWake(): void {
    if (readCooldownWakeHandle !== null) {
      cancel(readCooldownWakeHandle);
      readCooldownWakeHandle = null;
    }
  }

  /**
   * Finding 2 (round 10, PR review): arm (or re-arm) the one-shot
   * read-cooldown recovery wake. Cancels any previously-pending wake first
   * so a second read 429 replaces it instead of stacking a second timer.
   * The callback ONLY notify()s — it deliberately never touches
   * active/timerHandle/startPolling, so it can't arm or resurrect the poll
   * loop, and it re-checks shutdownFlag at fire time in case shutdown()
   * raced the timer itself.
   *
   * Finding 2 residual (round 10 re-review, Issue A): clearing
   * readCooldownUntilMs the moment this fires (whether from a natural
   * foreground timer fire, or from wake()'s own recovery notify below)
   * keeps the two recovery paths from double-notifying each other — once
   * this has fired, there is nothing left for a later wake() call to
   * "recover".
   */
  function armReadCooldownWake(ms: number): void {
    if (shutdownFlag) return;
    cancelReadCooldownWake();
    readCooldownWakeHandle = schedule(() => {
      readCooldownWakeHandle = null;
      if (shutdownFlag) return;
      readCooldownUntilMs = null;
      notify();
    }, ms);
  }

  function armTimer(ms: number): void {
    timerHandle = schedule(() => {
      void tick();
    }, ms);
  }

  async function tick(): Promise<void> {
    // The timer that triggered this call has now fired — nothing is armed
    // until this function (or the poll it steps aside for, below) arms a
    // fresh one. Marking it consumed up front lets refresh() distinguish
    // "a tick is still pending" from "a tick fired and needs a re-arm".
    timerHandle = null;
    if (!active) return;
    if (inFlight) {
      // A refresh() (or, defensively, another tick) already owns the
      // current poll cycle. Concurrent pollOnce() calls are never allowed,
      // so step aside instead — the in-flight poll's own completion is
      // responsible for re-arming (or idling) the loop, which keeps this
      // tick from silently orphaning it.
      return;
    }
    inFlight = true;
    let nextDelayMs: number | null = intervalMs;
    try {
      ({ nextDelayMs } = await pollOnce());
    } finally {
      inFlight = false;
    }
    if (!active) return;
    if (nextDelayMs === null) {
      active = false;            // idle-to-zero; wake() re-arms
      return;
    }
    armTimer(nextDelayMs);
  }

  function startPolling(): void {
    if (shutdownFlag) return;
    if (active) return;
    active = true;
    armTimer(0);
  }

  function stopPolling(): void {
    active = false;
    pauseEpoch++;
    if (timerHandle !== null) {
      cancel(timerHandle);
      timerHandle = null;
    }
    // Finding 2 residual (round 10 re-review, Issue A — High-class
    // foreground violation): a pending read-cooldown wake used to survive
    // stopPolling(). With the thread view open in a hidden tab, the
    // Provider calls stopPolling() on visibilitychange, but the wake would
    // still fire independently, notify()ing ThreadView into a real
    // listMessages walk resumption (and a markRead POST if it completed
    // fresh) — the first path that initiated network traffic in a hidden
    // tab after stopPolling(), contradicting the foreground-only posture
    // the pause-epoch machinery otherwise enforces everywhere else.
    // Cancel it here too; recovery now happens exclusively on the
    // foreground path, in wake() below.
    cancelReadCooldownWake();
  }

  return {
    getState: snapshot,
    list: () => threads.slice(),
    unreadCount: () => threads.reduce((sum, t) => sum + t.unreadCount, 0),
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    async refresh() {
      if (shutdownFlag) return;
      if (inFlight) return;
      inFlight = true;
      let nextDelayMs: number | null = intervalMs;
      try {
        ({ nextDelayMs } = await pollOnce());
      } finally {
        inFlight = false;
      }
      // If the poll loop isn't running, refresh() must not start it by side
      // effect — wake() stays the only explicit re-arm (per contract).
      if (!active) return;
      // If a scheduled tick is still pending (timerHandle !== null), leave it
      // to drive the cadence untouched. Only re-arm here when this refresh()
      // was the poll that a racing tick stepped aside for — i.e. that tick
      // fired mid-flight, cleared timerHandle, and left the loop's next step
      // undecided. Without this, the loop would be silently orphaned: active
      // stays true forever with nothing scheduled, and wake() (which only
      // acts when !active) can never recover it.
      if (timerHandle !== null) return;
      if (nextDelayMs === null) {
        active = false;          // idle-to-zero, same outcome as a normal tick
        return;
      }
      armTimer(nextDelayMs);
    },
    wake() {
      // Finding 6: shutdown() is terminal. Without this guard, the
      // Provider's visibilitychange listener (which calls wake() directly
      // on the adapter's ThreadClient, bypassing the tx.threads.* facade's
      // own client.kill() gate) would resurrect polling after kill().
      if (shutdownFlag) return;
      // Finding 2 residual (round 10 re-review, Issue A): stopPolling()
      // cancels any pending read-cooldown wake (foreground-only posture —
      // see stopPolling() above), so recovery now happens exclusively
      // here, on the foreground path. If a deadline exists: it having
      // already passed means the tab was hidden through it (the wake that
      // would otherwise have fired was cancelled) — notify() once, same
      // effect as the wake it stood in for, so a subscribed view reloads
      // and the checkpoint resumes. If it's still in the future, re-arm
      // the wake for the remaining time so recovery still happens on its
      // own if the tab stays foregrounded past it. Synchronous and
      // unconditional on refreshGate — this must not wait on that async
      // gate. Only ever notifies/re-arms a notify-only timer, never
      // touches active/timerHandle, so it can't arm or resurrect the poll
      // loop itself.
      if (readCooldownUntilMs !== null) {
        const remaining = readCooldownUntilMs - now();
        if (remaining <= 0) {
          readCooldownUntilMs = null;
          notify();
        } else {
          armReadCooldownWake(remaining);
        }
      }
      // The replies_disabled latch (readOnly=true) would otherwise be
      // permanent for the client's lifetime: pollOnce() short-circuits on
      // readOnly forever, so a re-enabled server could never be noticed
      // again (finding 7). wake() clears it optimistically — thread
      // statuses stay as last latched (closed) until the next successful
      // list is fetched, which is authoritative. If the server still has
      // replies off, that next poll's 401 simply re-latches.
      if (readOnly) {
        readOnly = false;
        notify();
      }
      // Finding 1 (round 5): without a refreshGate dep, behavior is
      // byte-identical to before — arm synchronously off the current
      // isEnabled() cache.
      if (!deps.refreshGate) {
        if (!active) startPolling();
        return;
      }
      // A deliberate wake signal gets one chance to re-resolve the config
      // gate BEFORE we decide whether to arm — otherwise a config flip that
      // happened while the tab was open (replies turned on server-side, or
      // the one mount-time fetch that failed) idles forever on the stale
      // cached isEnabled()===false. Awaited, fail-closed: a throwing or
      // slow refreshGate must never break wake() — the gate's own provider
      // is itself fail-closed/timeout-bounded (config-provider.ts), so this
      // is a defensive backstop, not the primary bound.
      const epochAtWake = pauseEpoch;
      void (async () => {
        try {
          await deps.refreshGate!();
        } catch {
          // fail-closed — proceed with whatever isEnabled() reports now.
        }
        // Re-check: shutdown() may have fired while the gate was in flight.
        if (shutdownFlag) return;
        // Round-5 re-review (finding 1 follow-up): stopPolling() may ALSO
        // have fired while the gate was in flight — e.g. the tab went
        // hidden right after this wake() started. Without this check, the
        // continuation would arm polling in a now-hidden tab and it would
        // keep polling at the normal cadence until the next visibility
        // transition, violating the foreground-only contract the mount-path
        // visibility gate otherwise enforces. If the epoch moved, a pause
        // happened after this wake() captured it — abandon this arm; a
        // later, genuine wake() (visibility return) will capture a fresh
        // epoch and arm normally.
        if (pauseEpoch !== epochAtWake) return;
        if (!active) startPolling();
      })();
    },
    startPolling,
    stopPolling,
    async get(threadId) {
      if (shutdownFlag) return null;
      // Finding 1-SDK: once the replies_disabled latch is engaged, every
      // future network read is doomed — the server will keep 401ing. Go
      // straight to the best cached view instead of burning a request on a
      // read that can never succeed. Forced closed since that's the
      // latch's meaning, even if the cached detail predates it.
      if (readOnly) return fallbackDetail(threadId, true);
      // Finding 3 (round 7 re-review): get()'s page walk used to hit the
      // network unconditionally, even with an active cooldown. The send
      // paths (reply()/retryPendingSends) already respect cooldownUntilMs
      // — get() did not, and its 429 handler below calls notify()
      // synchronously from inside the failed call's own catch. ThreadView
      // (round-7 finding 3) treats that notify as a dirty flag and fires
      // exactly one trailing get() once the in-flight call settles; that
      // trailing call immediately re-hit the walk, 429'd again, notified
      // again, and got itself re-scheduled again — one live HTTP request
      // per cycle, back to back, until the server's rate window reset (the
      // file header notes a thread past ~60 pages 429s deterministically
      // mid-walk, so this is the mainline long-thread path, not exotic).
      // Short-circuiting here — same shape as the readOnly guard above,
      // checked second so the terminal replies_disabled latch always wins
      // over a merely-temporary cooldown — breaks the chain at its root:
      // no request → no 429 → no notify → nothing left for ThreadView's
      // dirty flag to react to. Deliberately does NOT touch
      // walkCheckpoints, so the in-progress walk (if any) resumes exactly
      // where it left off, from its checkpoint, the moment the cooldown
      // expires — mirrors the existing transient-failure-with-no-progress
      // fallback below, just reached without ever making a network call.
      // Finding 1 (round 9, PR review): this consults the READ cooldown
      // (rmread), not the send cooldown — a send 429 must never block a
      // message read, since the two are independent server-side buckets.
      if (readCooldownUntilMs !== null && now() < readCooldownUntilMs) {
        return fallbackDetail(threadId, false);
      }
      const token = await loadToken();
      if (!token) return null;
      const summary = threads.find((t) => t.id === threadId);
      // Finding 2-SDK: resume a prior in-progress walk instead of
      // restarting at cursor zero. See WalkCheckpoint and the
      // MESSAGE_FETCH_PAGE_HARD_CAP comment above for the accounting.
      const checkpoint = walkCheckpoints.get(threadId);
      let messages: ThreadMessage[] = checkpoint ? checkpoint.messages.slice() : [];
      let cursor: string | null = checkpoint ? checkpoint.cursor : null;
      let status: 'open' | 'closed' = checkpoint?.status ?? summary?.status ?? 'open';
      let windowTrimmed = checkpoint?.windowTrimmed ?? false;
      let pagesConsumed = checkpoint?.pagesConsumed ?? 0;
      // Finding 4-SDK: every id the API echoes back across every page this
      // walk has consumed (this call plus any prior checkpointed calls) —
      // BEFORE the sliding window trims anything off the front. A
      // sentBuffer entry that shows up in any fetched page is
      // server-confirmed, even if the window trim below immediately drops
      // it because enough newer messages pushed it out. Deduping the
      // returned messages against only the post-trim window (the old
      // `seen` set) left confirmed-but-now-outside-the-window entries stuck
      // in sentBuffer forever — each subsequent get() re-appended the old
      // send at the END of the list, as if it were the newest message.
      // Pruning here, the first time an id is *observed* rather than only
      // when it's in the final visible set, fixes that leak — and carrying
      // it in the checkpoint keeps that guarantee across a resumed walk.
      const observedIds = new Set<string>(checkpoint?.observedIds ?? []);
      let completed = false;
      try {
        while (pagesConsumed < MESSAGE_FETCH_PAGE_HARD_CAP) {
          const result = await deps.api.listMessages(token, threadId, cursor);
          pagesConsumed++;
          for (const m of result.messages) observedIds.add(m.id);
          messages.push(...result.messages);
          status = result.status;
          // Sliding window: trim the front as we go so the final result is
          // the NEWEST MESSAGE_FETCH_WINDOW messages, not the oldest.
          if (messages.length > MESSAGE_FETCH_WINDOW) {
            messages = messages.slice(messages.length - MESSAGE_FETCH_WINDOW);
            windowTrimmed = true;
          }
          if (!result.hasMore || result.nextCursor === null) {
            cursor = null;
            completed = true;
            break;
          }
          cursor = result.nextCursor;
        }
        // Not completed while still under the cap only happens by resuming
        // a walk whose checkpoint already sat at the cap (the while
        // condition was false on entry, so this call made ZERO network
        // calls) — a misbehaving server that never reports hasMore:false
        // gets reported as permanently incomplete without being re-polled
        // forever. Otherwise, !completed means THIS call's own loop ran out
        // of budget. Either way we cannot vouch the window holds the true
        // latest messages — strictly worse than an ordinary window trim, so
        // it's reported as a distinct value (finding 2-SDK; mirrors the
        // admin ThreadTruncation split) that MUST suppress mark-read.
        const truncation: ThreadTruncation = !completed
          ? 'incomplete'
          : windowTrimmed
            ? 'older-dropped'
            : false;
        const finalMessages = mergeSentBuffer(threadId, messages, observedIds);
        const detail: ThreadDetail = {
          id: threadId,
          status,
          reportTitle: summary?.reportTitle ?? null,
          messages: finalMessages,
          pending: pending.filter((p) => p.threadId === threadId),
          truncation,
          fresh: true,
        };
        lastDetail.set(threadId, detail);
        // Checkpoint invariant: present iff truncation is 'incomplete', so
        // the NEXT get() resumes instead of restarting at cursor zero
        // (finding 2-SDK). Cleared the moment the walk genuinely finishes.
        if (truncation === 'incomplete') {
          walkCheckpoints.set(threadId, { cursor, messages, windowTrimmed, pagesConsumed, observedIds: Array.from(observedIds), status });
        } else {
          walkCheckpoints.delete(threadId);
        }
        return detail;
      } catch (err) {
        if (err instanceof ReporterApiError) {
          if (err.code === 'thread_not_found') {
            dropThreadLocal(threadId);
            notify();
            return null;
          }
          if (err.code === 'invalid_device_token') {
            handleAuthFailure(err);
            return null;
          }
          if (err.code === 'replies_disabled') {
            // Finding 1-SDK: the latch still engages exactly as before
            // (ETag cleared, threads forced closed, polling stopped) — but
            // the caller gets the cached detail back, not null, so a
            // thread the reporter can still see listed doesn't look like
            // it vanished.
            handleAuthFailure(err);
            return fallbackDetail(threadId, true);
          }
          if (err.code === 'rate_limit_exceeded') {
            // Finding 2-SDK / Finding 1 (round 9): the READ cooldown, not
            // the shared/send one — rmread is its own independent bucket
            // with its own retryAfter (finding 1, round 9, PR review). The
            // send path (reply/retryPendingSends/attemptSend) never
            // consults this field, so a read 429 can't stall an outbound
            // reply, and vice versa.
            const retryAfterMs = (err.retryAfter ?? 60) * 1000;
            readCooldownUntilMs = now() + retryAfterMs;
            // Finding 2 (round 10, PR review): give the read cooldown a
            // real recovery path — a one-shot wake at the deadline that
            // notify()s so a subscribed view (ThreadView) reloads and the
            // checkpoint above resumes on its own, instead of staying
            // parked until an unrelated notification or a close/reopen.
            armReadCooldownWake(retryAfterMs);
            notify();
          }
        }
        // Transient failure (429, network_error, malformed_response, or a
        // non-ReporterApiError) partway through the walk. If THIS walk
        // (this call plus whatever a prior call already checkpointed) made
        // any progress, persist it so the NEXT get() resumes rather than
        // restarting at cursor zero (finding 2-SDK) — regardless of which
        // view we choose to display below; resumption must track the
        // walk's true progress, not the display decision.
        if (pagesConsumed > 0) {
          walkCheckpoints.set(threadId, { cursor, messages, windowTrimmed, pagesConsumed, observedIds: Array.from(observedIds), status });
          // Round-1 finding 6 residual (round-4 re-review): don't erase
          // already-visible history. A cached, complete detail already
          // fetched earlier is strictly better to show than an in-progress
          // partial window that hasn't yet walked as far as that cache —
          // for an early-page blip, the partial window is the thread's
          // OLDEST messages, and displaying it would visibly regress the
          // UI "back in time" until a later get() resumes and converges.
          // Only prefer the partial window once it has genuinely walked at
          // least as far as the cache's own newest message (or there is no
          // cache to compare against, per fallbackDetail below). Either
          // way this is NOT a fresh fetch — a caller (ThreadView) must not
          // mark a cached/fallback render as read.
          const cached = lastDetail.get(threadId);
          if (cached && !isAtLeastAsNew(messages.at(-1), cached.messages.at(-1))) {
            return fallbackDetail(threadId, false);
          }
          const finalMessages = mergeSentBuffer(threadId, messages, observedIds);
          return {
            id: threadId,
            status,
            reportTitle: summary?.reportTitle ?? null,
            messages: finalMessages,
            pending: pending.filter((p) => p.threadId === threadId),
            truncation: 'incomplete',
            fresh: false,
          };
        }
        return fallbackDetail(threadId, false);
      }
    },

    async reply(threadId, body) {
      if (shutdownFlag) return;
      // Finding 1 (round 7, PR review): queue the optimistic PendingMessage
      // BEFORE resolving the credential, not after. This used to be
      // `const token = await loadToken(); if (!token) return;` — a return
      // BEFORE the message was ever queued. ThreadView clears the composer
      // immediately after calling reply(), so when the credential was
      // momentarily unavailable (another tab cleared the scoped key after
      // an invalid_device_token, or storage access dropped mid-session
      // while cached threads are still on screen) the reporter's text was
      // silently discarded: no pending entry, no POST, no failed bubble —
      // contradicting the "never vanishes silently" guarantee. Now the
      // entry always exists and is visible; if no token turns up, it goes
      // straight to a VISIBLE 'failed' state so ThreadView's existing
      // Retry affordance covers it, exactly like a failed postMessage().
      const msg: PendingMessage = {
        localId: `local-${++localSeq}`,
        threadId,
        body,
        state: 'sending',
        attempts: 0,
        createdAt: new Date(now()).toISOString(),
      };
      pending = [...pending, msg];
      notify();
      const token = await loadToken();
      // Ordering note: loadToken() itself never wipes `pending` — only a
      // caught API error inside attemptSend()/pollOnce() does, via
      // handleAuthFailure(). But loadToken() is an async gap, so a poll
      // tick's invalid_device_token reset CAN legitimately wipe `pending`
      // to [] while this call is suspended awaiting it. Updating via
      // `pending.map(...)` over the live array (never a closure capture of
      // this local `msg`) means that race resolves itself correctly: if
      // the wipe already happened, the map below is a no-op over the
      // now-empty array, so a reply attempted around a full auth reset does
      // not resurrect a wiped list.
      if (!token) {
        pending = pending.map((p) => (p.localId === msg.localId ? { ...p, state: 'failed' as const } : p));
        notify();
        return;
      }
      if (cooldownUntilMs !== null && now() < cooldownUntilMs) return;  // queued for the next tick
      await attemptSend(token, msg);
    },

    async retryMessage(localId) {
      if (shutdownFlag) return;
      const msg = pending.find((p) => p.localId === localId);
      if (!msg) return;
      // Finding 3 (round 10, PR review): the replies_disabled latch
      // correctly fails every queued entry, but retryMessage() had no
      // read-only or thread-status guard of its own — a click on the
      // (still-enabled) Retry button issued a SECOND POST into a client
      // that must issue no write traffic at all, and even landed a 201 in
      // the repro that reproduced the finding. A read-only client
      // (readOnly latched) or a thread already closed locally (whether by
      // that same latch or an earlier thread_closed 409) can never
      // succeed a send — every future attempt would 401/409 again — so
      // retryMessage() must no-op here rather than flip the entry to
      // 'sending' only to have nothing left to advance it. The failed
      // bubble and its body stay exactly as they are.
      if (readOnly) return;
      if (threads.find((t) => t.id === msg.threadId)?.status === 'closed') return;
      const token = await loadToken();
      if (!token) return;
      pending = pending.map((p) => (p.localId === localId ? { ...p, state: 'sending' as const, attempts: 0 } : p));
      notify();
      // Finding 2 (round 9, PR review): unlike reply()/retryPendingSends(),
      // a manual Retry used to call attemptSend() unconditionally — so a
      // user clicking Retry on a failed bubble during an active send
      // cooldown fired a second POST straight into the 429 that's still in
      // effect. The reset-to-'sending'-and-notify above already happened,
      // so the entry is visibly queued; just defer the actual POST to the
      // next poll tick (retryPendingSends), exactly like an ordinary queued
      // send that arrived mid-cooldown.
      if (cooldownUntilMs !== null && now() < cooldownUntilMs) return;
      await attemptSend(token, { ...msg, state: 'sending', attempts: 0 });
    },

    async markRead(threadId) {
      if (shutdownFlag) return;
      const token = await loadToken();
      if (!token) return;
      try {
        await deps.api.markRead(token, threadId);
        threads = threads.map((t) => (t.id === threadId ? { ...t, unreadCount: 0 } : t));
        notify();
      } catch (err) {
        if (err instanceof ReporterApiError && err.code === 'thread_not_found') {
          dropThreadLocal(threadId);
          notify();
        } else if (err instanceof ReporterApiError && (err.code === 'invalid_device_token' || err.code === 'replies_disabled')) {
          handleAuthFailure(err);
        }
        // Anything else: unread stays; next poll reconciles.
      }
    },

    async deleteThread(threadId) {
      if (shutdownFlag) return;
      const token = await loadToken();
      if (!token) {
        // Finding 2 (round 7, PR review): used to `return` here silently —
        // the same shape as a genuine no-op — and the facade (client.ts
        // threads.delete) maps every normal return to `true`. With a
        // cached row and a momentarily unreadable credential (another tab
        // cleared the scoped key, or storage access became unavailable),
        // that made Delete claim success — no request, no local removal —
        // and a later reconciliation could show the "deleted" thread again.
        // Mechanism chosen: throw, mirroring the existing rethrow-on-
        // real-failure path at the bottom of this method (network_error,
        // rate_limit_exceeded, etc.) — the facade already maps any thrown
        // error to `false` while leaving local state untouched, so this
        // keeps the documented contract exactly as-is: `true` means only
        // "the row was actually removed locally" (204, 404, or the
        // invalid_device_token auth-reset wipe below).
        throw new Error('everframe: no reporter credential available for deleteThread');
      }
      try {
        await deps.api.deleteThread(token, threadId);
      } catch (err) {
        if (err instanceof ReporterApiError) {
          if (err.code === 'invalid_device_token') {
            // Finding 4 (round 5): handleAuthFailure's invalid_device_token
            // branch wipes the ENTIRE local thread list as part of the
            // token reset — including this row. So "true" (the caller's
            // facade resolves success) stays an honest answer even though
            // the server-side delete itself was never confirmed: the
            // conversation genuinely IS gone locally. Deliberately NOT
            // rethrown here, unlike replies_disabled below.
            handleAuthFailure(err);
            return;
          }
          if (err.code === 'replies_disabled') {
            // Finding 4 (round 5): unlike invalid_device_token, this latch
            // does NOT remove the row — the thread stays listed (forced
            // closed) so the reporter can still see its history. Preserve
            // the latch handling (readOnly, ETag clear, polling stop), but
            // — unlike the old behavior of returning here silently —
            // rethrow so the facade (client.ts threads.delete) catches it
            // and resolves `false`, the same as every other "the row is
            // still there" outcome below. Resolving `true` here would
            // contradict the documented "true only on success/404"
            // contract and make the read-only inbox navigate back as if
            // the delete worked while the conversation is still listed.
            handleAuthFailure(err);
            throw err;
          }
          if (err.code === 'thread_not_found') {
            // 404 = already gone server-side; remove locally too.
            dropThreadLocal(threadId);
            notify();
            return;
          }
        }
        // Any other error (network_error, malformed_response,
        // rate_limit_exceeded, thread_closed, invalid_input, or a
        // non-ReporterApiError): the thread may still exist server-side.
        // Keep all local state untouched — dropping it here would hide a
        // conversation that's still there, and with the cached ETag
        // retained a subsequent poll would 304 and never resurrect it
        // (finding 5). Nothing changed, so don't notify; rethrow so the
        // caller (the tx.threads.delete facade) can surface a retry.
        throw err;
      }
      dropThreadLocal(threadId);
      notify();
    },
    shutdown() {
      // Idempotent — a second kill() (or an unmount racing kill()) must not
      // re-notify subscribers that were already cleared by the first call.
      if (shutdownFlag) return;
      shutdownFlag = true;
      // stopPolling() now cancels the read-cooldown recovery wake too (see
      // Issue A, round 10 re-review) — this explicit call stays as a
      // defensive belt-and-braces (the wake is independent of the poll
      // timer, so it's cheap to guarantee here directly rather than rely
      // solely on stopPolling()'s cascade): no timer survives shutdown()
      // and none fires afterward.
      stopPolling();
      cancelReadCooldownWake();
      threads = [];
      pending = [];
      // notify() BEFORE clearing subscribers: mounted UI (the Provider's
      // threadState subscription, which gates the FAB/inbox) must receive
      // this final empty snapshot so it actually drops away, rather than
      // being frozen on its last pre-shutdown state forever.
      notify();
      subscribers.clear();
    },
  };
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, vi } from 'vitest';
import { createThreadClient, MAX_SEND_ATTEMPTS, MESSAGE_FETCH_WINDOW } from '../src/reporter/thread-client.js';
import { ReporterApiError } from '../src/reporter/api.js';
import type { ReporterApi, ThreadSummary, ThreadMessage } from '../src/reporter/api.js';

const TOKEN = 'evr_' + 'a'.repeat(43);
const OPEN: ThreadSummary = { id: 't1', status: 'open', reportTitle: 'Crash', createdAt: '2026-08-01T00:00:00.000Z', lastMessageAt: null, unreadCount: 2 };
const TEAM_MSG: ThreadMessage = { id: 'm1', authorKind: 'team', authorName: 'Acme Support', body: 'On it', createdAt: '2026-08-01T01:00:00.000Z' };

function memoryStore() {
  let value: string | null = TOKEN;
  return { randomBytes: (n: number) => new Uint8Array(n), load: async () => value, save: async (t: string) => { value = t; }, clear: async () => { value = null; } };
}

function makeApi(overrides: Partial<Record<keyof ReporterApi, unknown>> = {}): ReporterApi {
  return {
    listThreads: vi.fn(async () => ({ kind: 'ok', threads: [OPEN], etag: null })),
    listMessages: vi.fn(async () => ({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false })),
    postMessage: vi.fn(async () => ({ id: 'srv-1' })),
    markRead: vi.fn(async () => undefined),
    deleteThread: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ReporterApi;
}

function make(api: ReporterApi, nowRef = { ms: 0 }) {
  const client = createThreadClient({
    api, credentials: memoryStore(), isEnabled: () => true,
    now: () => nowRef.ms, schedule: () => 0, cancel: () => {},
  });
  return client;
}

/**
 * Manual scheduler for the read-cooldown recovery wake tests (finding 2,
 * round 10, and its round-10-re-review foreground-only follow-up). Collects
 * scheduled callbacks instead of firing them; tests advance the injected
 * clock and fire them explicitly.
 */
function manualScheduler() {
  const queue: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ id, fn, ms });
      return id;
    },
    cancel: (handle: unknown) => {
      const idx = queue.findIndex((q) => q.id === handle);
      if (idx >= 0) queue.splice(idx, 1);
    },
    fireAll: () => {
      const jobs = queue.splice(0);
      for (const j of jobs) j.fn();
    },
    // Fires (and removes) only the queued entry with this exact delay —
    // lets a test isolate one timer (e.g. the read-cooldown wake) from an
    // unrelated one that also happens to be queued (e.g. wake()'s own
    // poll-loop restart tick), without assuming queue order.
    fireDelay: (ms: number) => {
      const idx = queue.findIndex((q) => q.ms === ms);
      if (idx < 0) return;
      const [job] = queue.splice(idx, 1);
      job!.fn();
    },
    queued: () => queue.length,
    delays: () => queue.map((q) => q.ms),
    lastDelay: () => queue[queue.length - 1]?.ms,
  };
}

describe('thread client messages', () => {
  it('get() walks pages and merges confirmed local sends without duplicates', async () => {
    const page1 = { status: 'open', messages: [TEAM_MSG], nextCursor: 'c1', hasMore: true };
    const page2 = { status: 'open', messages: [{ ...TEAM_MSG, id: 'm2' }], nextCursor: null, hasMore: false };
    const listMessages = vi.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    const detail = await client.get('t1');
    expect((listMessages.mock.calls[1] as unknown[])?.[2]).toBe('c1');     // cursor echoed opaquely
    expect(detail!.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(detail!.reportTitle).toBe('Crash');
  });

  it('reply() is optimistic: pending appears immediately, then confirms into the merged view', async () => {
    const client = make(makeApi());
    await client.refresh();
    const states: number[] = [];
    client.subscribe((s) => states.push(s.pending.length));
    await client.reply('t1', 'hello');
    expect(states[0]).toBe(1);                            // optimistic push notified first
    expect(client.getState().pending).toHaveLength(0);    // confirmed → pending drained
    const detail = await client.get('t1');
    expect(detail!.messages.some((m) => m.id === 'srv-1' && m.body === 'hello' && m.authorKind === 'reporter')).toBe(true);
  });

  it('failed sends survive: attempts accumulate on poll ticks, then flip to failed; retryMessage revives', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('network_error', null); });
    const client = make(makeApi({ postMessage }));
    await client.refresh();
    await client.reply('t1', 'hello');                    // attempt 1 fails
    expect(client.getState().pending[0]?.state).toBe('sending');
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) await client.refresh();  // retried per tick
    expect(client.getState().pending[0]?.state).toBe('failed');
    expect(postMessage).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);

    (postMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'srv-2' });
    const localId = client.getState().pending[0]?.localId;
    await client.retryMessage(localId!);
    expect(client.getState().pending).toHaveLength(0);
  });

  // Finding 8: the checked-in spec is binding — "optimistic 'sending' state,
  // retried on the next 3 polls, then manual retry affordance". The initial
  // POST (fired synchronously from reply(), before any poll ever runs) is
  // attempt #1; it must NOT itself count as one of the "3 polls". Pins the
  // exact cadence with hard-coded numbers (not MAX_SEND_ATTEMPTS) so a future
  // constant change can't silently make this test agree with a regression:
  // initial POST fails, then exactly THREE refresh()-driven poll attempts
  // occur (4 postMessage calls total) before the message flips to 'failed'.
  it('pins the send-retry cadence: 1 initial POST + exactly 3 poll retries (4 total) before failed', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('network_error', null); });
    const client = make(makeApi({ postMessage }));
    await client.refresh();

    await client.reply('t1', 'hello');                     // attempt #1 (initial POST) fails
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(client.getState().pending[0]?.state).toBe('sending');

    await client.refresh();                                 // poll retry #1 (attempt #2) fails
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(client.getState().pending[0]?.state).toBe('sending');

    await client.refresh();                                 // poll retry #2 (attempt #3) fails
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(client.getState().pending[0]?.state).toBe('sending');

    await client.refresh();                                 // poll retry #3 (attempt #4) fails
    expect(postMessage).toHaveBeenCalledTimes(4);
    expect(client.getState().pending[0]?.state).toBe('failed');

    // retryMessage still resets and revives a failed send.
    (postMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'srv-revived' });
    const localId = client.getState().pending[0]?.localId;
    await client.retryMessage(localId!);
    expect(client.getState().pending).toHaveLength(0);
    expect(postMessage).toHaveBeenCalledTimes(5);
  });

  // Finding 1 (round 7, PR review): reply() used to check for a credential
  // BEFORE creating the optimistic PendingMessage — `const token =
  // loadToken(); if (!token) return;` returned silently, before the
  // message was ever queued. Meanwhile ThreadView clears the composer
  // right after calling reply(). So when the credential is momentarily
  // unavailable (another tab cleared the scoped key after an
  // invalid_device_token, or storage access dropped mid-session while
  // cached threads are still on screen), the typed text vanished: no
  // pending entry, no POST, no failed bubble, nothing — contradicting the
  // "never vanishes silently" guarantee. reply() must queue first, then
  // resolve the credential; with none available the entry goes straight to
  // a VISIBLE 'failed' state instead of disappearing.
  it('reply() with no credential available queues a visible failed entry instead of discarding the text', async () => {
    const noTokenStore = {
      randomBytes: (n: number) => new Uint8Array(n),
      load: async () => null,
      save: async () => {},
      clear: async () => {},
    };
    const postMessage = vi.fn(async () => ({ id: 'srv-1' }));
    const api = makeApi({ postMessage });
    const client = createThreadClient({
      api, credentials: noTokenStore, isEnabled: () => true,
      now: () => 0, schedule: () => 0, cancel: () => {},
    });
    await client.reply('t1', 'hi');
    expect(client.getState().pending).toHaveLength(1);
    expect(client.getState().pending[0]).toMatchObject({ threadId: 't1', body: 'hi', state: 'failed' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('a reply() queued as failed (no credential) can be retried once a credential becomes available', async () => {
    let token: string | null = null;
    const store = {
      randomBytes: (n: number) => new Uint8Array(n),
      load: async () => token,
      save: async (t: string) => { token = t; },
      clear: async () => { token = null; },
    };
    const postMessage = vi.fn(async () => ({ id: 'srv-2' }));
    const api = makeApi({ postMessage });
    const client = createThreadClient({
      api, credentials: store, isEnabled: () => true,
      now: () => 0, schedule: () => 0, cancel: () => {},
    });
    await client.reply('t1', 'hi');
    expect(client.getState().pending[0]?.state).toBe('failed');
    expect(postMessage).not.toHaveBeenCalled();

    token = TOKEN; // credential becomes available later
    const localId = client.getState().pending[0]?.localId;
    await client.retryMessage(localId!);
    expect(client.getState().pending).toHaveLength(0);
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('429 on send sets a cooldown, consumes no attempt, and pauses retries until it passes', async () => {
    const nowRef = { ms: 0 };
    const postMessage = vi.fn(async () => { throw new ReporterApiError('rate_limit_exceeded', 429, 30); });
    const client = make(makeApi({ postMessage }), nowRef);
    await client.refresh();
    await client.reply('t1', 'hello');
    expect(client.getState().cooldownUntilMs).toBe(30_000);
    expect(client.getState().pending[0]).toMatchObject({ state: 'sending', attempts: 0 });
    await client.refresh();                                // still cooling down
    expect(postMessage).toHaveBeenCalledTimes(1);
    nowRef.ms = 31_000;
    (postMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'srv-3' });
    await client.refresh();                                // cooldown over → retried
    expect(client.getState().pending).toHaveLength(0);
  });

  // Finding 1 (round 10, PR review): attemptSend()'s per-localId
  // `sendingInFlight` lock allows two DIFFERENT pending messages to be in
  // flight concurrently. A successful POST used to unconditionally reset
  // the device-wide send cooldown to null — so if message A 429s (setting
  // an hour-long cooldown) while message B is already in flight, B's later
  // success erased A's still-future cooldown, and the very next poll
  // retried A early, straight back into the server's rate limit. A success
  // must never clear a cooldown established by a DIFFERENT, still-future
  // 429 — only an already-expired deadline may be cleared.
  it('a concurrent successful send does not erase another send\'s still-future 429 cooldown', async () => {
    const nowRef = { ms: 0 };
    let rejectA!: (err: unknown) => void;
    let resolveB!: (v: { id: string }) => void;
    const postMessage = vi.fn()
      .mockImplementationOnce(() => new Promise<{ id: string }>((_resolve, reject) => { rejectA = reject; }))
      .mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => { resolveB = resolve; }));
    const client = make(makeApi({ postMessage }), nowRef);
    await client.refresh();

    const replyA = client.reply('t1', 'A');           // POST A in flight
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const replyB = client.reply('t2', 'B');            // POST B in flight concurrently (different localId)
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));

    // A settles first: a 429 with a long (hour-scale) retryAfter.
    rejectA(new ReporterApiError('rate_limit_exceeded', 429, 3600));
    await replyA;
    expect(client.getState().cooldownUntilMs).toBe(3600 * 1000);

    // B settles second, successfully — while A's cooldown is still far in
    // the future.
    resolveB({ id: 'srv-b' });
    await replyB;

    // B's success must NOT have erased A's still-future cooldown.
    expect(client.getState().cooldownUntilMs).toBe(3600 * 1000);

    // A following poll must not retry A early — it's still cooling down.
    await client.refresh();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(client.getState().pending.find((p) => p.body === 'A')).toMatchObject({ state: 'sending' });

    // Once the deadline genuinely passes, the next poll retries A normally.
    nowRef.ms = 3600 * 1000;
    (postMessage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'srv-a-retry' });
    await client.refresh();
    expect(client.getState().pending.find((p) => p.body === 'A')).toBeUndefined();
  });

  // Finding 1 (round 9, PR review): the server enforces THREE independent
  // per-device rate buckets — rmsg (10 sends/hour), rmread (60 page-reads/
  // minute), rpoll (10 thread-list polls/minute) — with wildly different
  // retryAfter magnitudes. A single shared cooldownUntilMs coupled them: a
  // send 429 (hourly bucket) used to make get()'s short-circuit refuse every
  // message read for up to an hour too, hiding an already-waiting team
  // reply. Send and read cooldowns must be tracked independently; the public
  // cooldownUntilMs stays SEND-only (what ThreadView's composer consumes).
  it('a send 429 with a long retryAfter does not block get() from fetching the (separately-bucketed) read path', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('rate_limit_exceeded', 429, 3600); });
    const listMessages = vi.fn(async () => ({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false }));
    const client = make(makeApi({ postMessage, listMessages }));
    await client.refresh();
    await client.reply('t1', 'hello');                    // rmsg 429: hourly send cooldown
    expect(client.getState().cooldownUntilMs).toBe(3600 * 1000);

    const detail = await client.get('t1');                // rmread is a separate bucket
    expect(listMessages).toHaveBeenCalledTimes(1);         // NOT short-circuited by the send cooldown
    expect(detail!.messages.some((m) => m.id === 'm1')).toBe(true);
  });

  // Reverse coupling: a message-read 429 must not suppress reply()'s POST.
  it('a read 429 does not block reply() from sending on the (separately-bucketed) send path', async () => {
    const listMessages = vi.fn(async () => { throw new ReporterApiError('rate_limit_exceeded', 429, 60); });
    const postMessage = vi.fn(async () => ({ id: 'srv-1' }));
    const client = make(makeApi({ listMessages, postMessage }));
    await client.refresh();
    await client.get('t1');                                // rmread 429: sets only the read cooldown
    expect(client.getState().cooldownUntilMs).toBeNull();   // public (send) cooldown untouched

    await client.reply('t1', 'hello');                      // rmsg is a separate bucket
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(client.getState().pending).toHaveLength(0);
  });

  // Finding 2 (round 9, PR review): a manual Retry used to reset the entry
  // and call attemptSend() UNCONDITIONALLY — unlike reply() and
  // retryPendingSends(), it never checked the active send cooldown, so a
  // user clicking Retry on a failed bubble during an active 429 fired a
  // second doomed POST straight into the cooldown. retryMessage() must
  // requeue the entry as 'sending' (visible immediately) but defer the
  // actual POST to the next poll tick, same as an ordinary queued send.
  it('retryMessage() during an active send cooldown does not POST — it requeues and a later poll sends it once the cooldown lifts', async () => {
    const nowRef = { ms: 0 };
    const postMessage = vi.fn(async () => { throw new ReporterApiError('network_error', null); });
    const client = make(makeApi({ postMessage }), nowRef);
    await client.refresh();

    // Message A fails out via the ordinary transient-retry counter — no
    // cooldown involved yet.
    await client.reply('t1', 'A');
    for (let i = 1; i < MAX_SEND_ATTEMPTS; i++) await client.refresh();
    expect(client.getState().pending[0]).toMatchObject({ body: 'A', state: 'failed' });
    const localIdA = client.getState().pending[0]!.localId;

    // An unrelated send (B) now 429s, establishing the shared send cooldown.
    (postMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ReporterApiError('rate_limit_exceeded', 429, 30));
    await client.reply('t1', 'B');
    expect(client.getState().cooldownUntilMs).toBe(30_000);
    const callsBeforeRetry = postMessage.mock.calls.length;

    // A manual Retry on A's failed bubble, fired while that cooldown is
    // still active, must NOT POST.
    await client.retryMessage(localIdA);
    expect(postMessage.mock.calls.length).toBe(callsBeforeRetry); // no new POST
    expect(client.getState().cooldownUntilMs).toBe(30_000);        // cooldown untouched
    const requeuedA = client.getState().pending.find((p) => p.localId === localIdA);
    expect(requeuedA).toMatchObject({ state: 'sending', attempts: 0 }); // queued, not left 'failed'

    // Once the cooldown lifts, the next poll sends both A and B automatically.
    (postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'srv-revived' });
    nowRef.ms = 31_000;
    await client.refresh();
    expect(client.getState().pending).toHaveLength(0);
  });

  // Finding 3 (round 5): retryPendingSends() used to check cooldownUntilMs
  // only ONCE, before entering the loop over every queued 'sending'
  // message. If the FIRST message in the batch 429s (setting the
  // cooldown), the loop kept POSTing every remaining message in the same
  // tick anyway — hammering an endpoint that just told us to back off. The
  // pause must be re-checked after EACH attempt, breaking the batch the
  // moment one is established.
  it('a mid-batch 429 stops retryPendingSends immediately: the rest of the queue stays unattempted until the cooldown passes', async () => {
    const nowRef = { ms: 0 };
    const postMessage = vi.fn()
      .mockRejectedValueOnce(new ReporterApiError('network_error', null))   // reply('a') initial attempt
      .mockRejectedValueOnce(new ReporterApiError('network_error', null));  // reply('b') initial attempt
    const client = make(makeApi({ postMessage }), nowRef);
    await client.refresh();
    await client.reply('t1', 'a');
    await client.reply('t1', 'b');
    expect(client.getState().pending).toHaveLength(2);
    expect(postMessage).toHaveBeenCalledTimes(2);

    // Next tick: the first queued message (a) 429s. The second (b) must NOT
    // be attempted in the same tick.
    postMessage.mockRejectedValueOnce(new ReporterApiError('rate_limit_exceeded', 429, 30));
    await client.refresh();
    expect(postMessage).toHaveBeenCalledTimes(3);           // exactly one POST this tick
    expect(client.getState().cooldownUntilMs).toBe(30_000);
    const [msgA, msgB] = client.getState().pending;
    expect(msgA?.state).toBe('sending');
    expect(msgB?.state).toBe('sending');
    expect(msgB?.attempts).toBe(1);                          // untouched this tick

    // A later tick, after the cooldown elapses, attempts both — including
    // the one that was skipped.
    nowRef.ms = 31_000;
    postMessage.mockResolvedValueOnce({ id: 'srv-a' }).mockResolvedValueOnce({ id: 'srv-b' });
    await client.refresh();
    expect(postMessage).toHaveBeenCalledTimes(5);
    expect(client.getState().pending).toHaveLength(0);
  });

  // Finding 3 (round 5): the same guard must also stop a batch mid-flight
  // when an earlier message in the queue trips the replies_disabled latch
  // — otherwise the remaining queued messages get POSTed against an
  // endpoint we already know just 401'd everything.
  it('a mid-batch replies_disabled stops retryPendingSends immediately: the rest of the queue is never attempted', async () => {
    const postMessage = vi.fn()
      .mockRejectedValueOnce(new ReporterApiError('network_error', null))
      .mockRejectedValueOnce(new ReporterApiError('network_error', null));
    const client = make(makeApi({ postMessage }));
    await client.refresh();
    await client.reply('t1', 'a');
    await client.reply('t1', 'b');
    expect(postMessage).toHaveBeenCalledTimes(2);

    postMessage.mockRejectedValueOnce(new ReporterApiError('replies_disabled', 401));
    await client.refresh();
    expect(postMessage).toHaveBeenCalledTimes(3);            // only the first queued message attempted
    expect(client.getState().readOnly).toBe(true);
    // Finding 3 (round 9, PR review): replies_disabled permanently closes
    // every conversation, so a queued 'sending' entry can never succeed —
    // handleAuthFailure() now flips EVERY still-'sending' pending entry to
    // 'failed' the moment the latch engages, not just the one whose own
    // attempt triggered it. Previously both stayed 'sending' forever, with
    // no cooldown or poll left to ever advance them.
    const [msgA, msgB] = client.getState().pending;
    expect(msgA?.state).toBe('failed');
    expect(msgB?.state).toBe('failed');
    expect(msgB?.attempts).toBe(1);                          // attempt count untouched by the latch
  });

  // Finding 3 (round 9, PR review): disabling replies permanently closes
  // existing conversations — a queued 'sending' entry can never succeed
  // once the latch engages, so it must not be left showing "Sending…"
  // forever with no cooldown/timer left to advance it. Triggered here via
  // markRead() (a codepath independent of the queued message itself) to
  // show the transition applies to ANY 'sending' entry present when the
  // latch engages, not just the one whose own request happened to 401.
  it('the replies_disabled latch fails every queued "sending" entry, preserving its body, instead of leaving it stuck', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('rate_limit_exceeded', 429, 30); });
    const markRead = vi.fn(async () => { throw new ReporterApiError('replies_disabled', 401); });
    const client = make(makeApi({ postMessage, markRead }));
    await client.refresh();
    await client.reply('t1', 'still queued'); // 429s: stays 'sending', never itself hits replies_disabled
    expect(client.getState().pending[0]).toMatchObject({ body: 'still queued', state: 'sending' });

    await client.markRead('t1'); // unrelated call trips the latch
    expect(client.getState().readOnly).toBe(true);
    expect(client.getState().pending[0]).toMatchObject({ body: 'still queued', state: 'failed' });
  });

  // Finding 3 residual (round-9 re-review, Minor): an in-flight send could
  // resurrect a just-latched entry. Sequence: B's postMessage() is still in
  // flight when a DIFFERENT call (markRead/get/the gate-transition poll)
  // engages the replies_disabled latch, correctly flipping B to 'failed'
  // (the fix above). But when B's own POST then settles with a transient
  // error (network_error/malformed_response), the generic attempt-counter
  // recompute at the bottom of attemptSend() used to unconditionally move
  // it back to 'sending' (attempts still under the cap) — with readOnly
  // latched and polling stopped, nothing would ever advance it again. Stuck
  // at "Sending…" once more, the exact symptom finding 3 eliminated
  // elsewhere. The recompute must skip entirely once readOnly is set: a
  // latched client can never succeed a send, so a transient settle must
  // leave the entry terminal.
  it('a send latched by replies_disabled WHILE its own POST is still in flight is not resurrected to "sending" when that POST later settles transiently', async () => {
    let rejectPost!: (err: unknown) => void;
    const postMessage = vi.fn(
      () => new Promise<{ id: string }>((_resolve, reject) => { rejectPost = reject; }),
    );
    const markRead = vi.fn(async () => { throw new ReporterApiError('replies_disabled', 401); });
    const client = make(makeApi({ postMessage, markRead }));
    await client.refresh();

    const replyPromise = client.reply('t1', 'hello'); // POST in flight, not yet settled
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const localId = client.getState().pending[0]!.localId;

    // A DIFFERENT call engages the latch while the POST above is still in flight.
    await client.markRead('t1');
    expect(client.getState().readOnly).toBe(true);
    expect(client.getState().pending.find((p) => p.localId === localId)).toMatchObject({ state: 'failed' });

    // The in-flight POST now settles with an ordinary transient error.
    rejectPost(new ReporterApiError('network_error', null));
    await replyPromise;

    // Must stay terminal — not resurrected to 'sending' — with no further POST.
    expect(client.getState().pending.find((p) => p.localId === localId)).toMatchObject({
      state: 'failed', body: 'hello',
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  // Finding 3 (round 10, PR review): the replies_disabled latch correctly
  // fails every queued entry, but retryMessage() had no read-only guard —
  // a click on the (still-enabled) Retry button issued a SECOND POST
  // straight into a read-only client. A read-only client must issue no
  // write traffic at all, so retryMessage() must no-op (no POST, entry
  // stays 'failed') once the latch has engaged.
  it('retryMessage() no-ops (no POST) once the replies_disabled latch has engaged, leaving the entry failed', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('rate_limit_exceeded', 429, 30); });
    const markRead = vi.fn(async () => { throw new ReporterApiError('replies_disabled', 401); });
    const client = make(makeApi({ postMessage, markRead }));
    await client.refresh();
    await client.reply('t1', 'still queued'); // 429s: stays 'sending', no attempt consumed
    const localId = client.getState().pending[0]!.localId;

    await client.markRead('t1'); // an unrelated call trips the latch
    expect(client.getState().readOnly).toBe(true);
    expect(client.getState().pending[0]).toMatchObject({ state: 'failed' });

    const callsBefore = postMessage.mock.calls.length;
    await client.retryMessage(localId);
    expect(postMessage.mock.calls.length).toBe(callsBefore); // no new POST
    expect(client.getState().pending.find((p) => p.localId === localId)).toMatchObject({
      state: 'failed', body: 'still queued',
    });
  });

  // Finding 3 (round 10, PR review): same no-write guard, but for a thread
  // closed locally (e.g. by a prior thread_closed 409) rather than the
  // global readOnly latch — every future attempt on it would 409 again, so
  // Retry must not fire a doomed POST there either.
  it('retryMessage() no-ops (no POST) on a thread that is locally closed, leaving the entry failed', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('thread_closed', 409); });
    const client = make(makeApi({ postMessage }));
    await client.refresh();
    await client.reply('t1', 'hello'); // 409s: fails the send and closes the thread locally
    expect(client.list()[0]?.status).toBe('closed');
    expect(client.getState().pending[0]?.state).toBe('failed');
    const localId = client.getState().pending[0]!.localId;

    postMessage.mockClear();
    await client.retryMessage(localId);
    expect(postMessage).not.toHaveBeenCalled();
    expect(client.getState().pending.find((p) => p.localId === localId)).toMatchObject({
      state: 'failed', body: 'hello',
    });
  });

  it('409 thread_closed fails the send and closes the thread locally', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('thread_closed', 409); });
    const client = make(makeApi({ postMessage }));
    await client.refresh();
    await client.reply('t1', 'hello');
    expect(client.getState().pending[0]?.state).toBe('failed');
    expect(client.list()[0]?.status).toBe('closed');
  });

  // Finding 4 (round 9, PR review): invalid_input is a PERMANENT rejection
  // (the server has already told us this exact body will never be
  // accepted — e.g. over-length) but attemptSend() used to fall through to
  // the generic transient-failure counter, same as a network_error. That
  // left a 400 showing "Sending…" and re-POSTed the same doomed body on the
  // next three poll ticks before finally failing — reachable through the
  // public headless tx.threads.reply() even though the built-in textarea's
  // maxLength prevents an over-length body from that particular path. Treat
  // it like thread_closed/thread_not_found: fail immediately, no attempt
  // accounting, no further POSTs.
  it('invalid_input fails the send immediately — exactly one POST, no transient retries', async () => {
    const postMessage = vi.fn(async () => { throw new ReporterApiError('invalid_input', 400); });
    const client = make(makeApi({ postMessage }));
    await client.refresh();
    await client.reply('t1', 'hello');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(client.getState().pending[0]).toMatchObject({ state: 'failed', attempts: 0 });

    // A poll tick must not re-attempt it — it's terminal, not queued.
    await client.refresh();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(client.getState().pending[0]?.state).toBe('failed');
  });

  it('get() on 404 drops the thread quietly and returns null', async () => {
    const listMessages = vi.fn(async () => { throw new ReporterApiError('thread_not_found', 404); });
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    expect(await client.get('t1')).toBeNull();
    expect(client.list()).toHaveLength(0);
  });

  it('markRead zeroes the local unread count; deleteThread removes everything local', async () => {
    const client = make(makeApi());
    await client.refresh();
    await client.markRead('t1');
    expect(client.unreadCount()).toBe(0);
    await client.deleteThread('t1');
    expect(client.list()).toHaveLength(0);
  });

  // Finding 5: a deleteThread failure that ISN'T "already gone" (404) must
  // never fall through to local removal — otherwise a timeout/network/500
  // hides a conversation that still exists server-side, and with the cached
  // ETag retained, subsequent polls 304 and never resurrect it.
  it('deleteThread on a network_error keeps the thread and all local state, and rethrows for the caller to retry', async () => {
    const deleteThread = vi.fn(async () => { throw new ReporterApiError('network_error', null); });
    const client = make(makeApi({ deleteThread }));
    await client.refresh();
    expect(client.list()).toHaveLength(1);
    await expect(client.deleteThread('t1')).rejects.toBeInstanceOf(ReporterApiError);
    expect(client.list()).toHaveLength(1);
    expect(client.list()[0]?.id).toBe('t1');
  });

  it('deleteThread on a 404 (thread_not_found) drops the thread locally, same as a successful delete', async () => {
    const deleteThread = vi.fn(async () => { throw new ReporterApiError('thread_not_found', 404); });
    const client = make(makeApi({ deleteThread }));
    await client.refresh();
    await client.deleteThread('t1');
    expect(client.list()).toHaveLength(0);
  });

  // Finding 4 (round 5): a replies_disabled delete used to latch (readOnly,
  // ETag clear, polling stop) and then return WITHOUT throwing — so the
  // public facade (client.ts) resolved `true` even though the thread row
  // was never removed. deleteThread() must preserve the latch handling but
  // signal failure (rethrow) so the facade can resolve `false` — `true`
  // must keep meaning "the conversation is really gone locally".
  it('deleteThread on replies_disabled latches read-only but rethrows and keeps the thread listed (does not silently succeed)', async () => {
    const deleteThread = vi.fn(async () => { throw new ReporterApiError('replies_disabled', 401); });
    const client = make(makeApi({ deleteThread }));
    await client.refresh();
    expect(client.list()).toHaveLength(1);
    await expect(client.deleteThread('t1')).rejects.toBeInstanceOf(ReporterApiError);
    expect(client.list()).toHaveLength(1);          // NOT dropped locally
    expect(client.list()[0]?.id).toBe('t1');
    expect(client.list()[0]?.status).toBe('closed'); // latch still forces closed
    expect(client.getState().readOnly).toBe(true);   // latch still engages
  });

  // invalid_device_token is the one auth-failure code where "true" (the row
  // is gone locally) stays defensible: handleAuthFailure wipes the ENTIRE
  // local thread list as part of the token reset, so this row is genuinely
  // gone too — deleteThread must NOT rethrow here.
  it('deleteThread on invalid_device_token wipes all local threads (including this one) and does not throw', async () => {
    const deleteThread = vi.fn(async () => { throw new ReporterApiError('invalid_device_token', 401); });
    const client = make(makeApi({ deleteThread }));
    await client.refresh();
    expect(client.list()).toHaveLength(1);
    await expect(client.deleteThread('t1')).resolves.toBeUndefined();
    expect(client.list()).toHaveLength(0);
  });

  // Finding 2 (round 7, PR review): deleteThread() used to `return` normally
  // when no credential was available — same shape as a genuine no-op — and
  // the facade (client.ts threads.delete) maps every normal return to
  // `true`. With a cached row and an unreadable credential, Delete would
  // navigate back as though the conversation were gone even though no
  // request and no local removal ever happened, and a later reconciliation
  // could show the thread again. deleteThread() must now throw when no
  // token is available (mirroring the existing rethrow-on-real-failure
  // path just above) so the facade contract stays "true only when the row
  // was actually removed locally".
  it('deleteThread() with no credential available throws instead of silently succeeding, leaving the thread listed', async () => {
    let token: string | null = TOKEN;
    const store = {
      randomBytes: (n: number) => new Uint8Array(n),
      load: async () => token,
      save: async (t: string) => { token = t; },
      clear: async () => { token = null; },
    };
    const deleteThread = vi.fn(async () => undefined);
    const client = createThreadClient({
      api: makeApi({ deleteThread }), credentials: store, isEnabled: () => true,
      now: () => 0, schedule: () => 0, cancel: () => {},
    });
    await client.refresh(); // populates the cached row while the token is still available
    expect(client.list()).toHaveLength(1);

    token = null; // credential becomes unavailable mid-session
    await expect(client.deleteThread('t1')).rejects.toBeInstanceOf(Error);
    expect(deleteThread).not.toHaveBeenCalled();
    expect(client.list()).toHaveLength(1); // still there, not silently dropped
  });

  // Finding 6: a call-local page array meant a later-page transient failure
  // returned only the degraded sentBuffer fallback, erasing already-visible
  // history on an offline refresh. get() must cache the last successful
  // detail and prefer it over that fallback.
  it('get() falls back to the last successfully fetched detail (not the degraded sentBuffer-only view) on a later transient failure', async () => {
    const page1 = [TEAM_MSG, { ...TEAM_MSG, id: 'm2' }];
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ status: 'open', messages: page1, nextCursor: null, hasMore: false })
      .mockRejectedValueOnce(new ReporterApiError('network_error', null));
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    const first = await client.get('t1');
    expect(first!.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    const second = await client.get('t1');
    expect(second!.messages.map((m) => m.id)).toEqual(['m1', 'm2']); // cached, not shrunk to sentBuffer-only
  });

  // Finding 2 (round 8, PR review): a successful attemptSend() removes the
  // pending bubble and buffers the confirmed message in sentBuffer, relying
  // on the next successful get() to merge it in via mergeSentBuffer(). If
  // that reconciliation read fails, fallbackDetail()'s cached branch used to
  // return only the stale cached messages plus current `pending` — never
  // sentBuffer — so a confirmed, just-delivered reply vanished from the view
  // until some later successful walk. fallbackDetail() must merge sentBuffer
  // into the cached fallback too (deduped by id, unpruned since nothing was
  // confirmed by a server echo here).
  it('a confirmed reply survives a failing reconciliation read: fallbackDetail merges sentBuffer into the cached view', async () => {
    const postMessage = vi.fn(async () => ({ id: 'sent-1' }));
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false }) // establishes cached ['m1']
      .mockRejectedValueOnce(new ReporterApiError('network_error', null)); // reconciliation read fails
    const client = make(makeApi({ postMessage, listMessages }));
    await client.refresh();
    const cached = await client.get('t1');
    expect(cached!.messages.map((m) => m.id)).toEqual(['m1']);

    await client.reply('t1', 'hello'); // confirmed: sentBuffer['t1'] = [sent-1], pending drained
    expect(client.getState().pending).toHaveLength(0);

    const detail = await client.get('t1'); // reconciliation read fails -> falls back to cached
    expect(detail!.fresh).toBe(false);
    expect(detail!.messages.map((m) => m.id)).toEqual(['m1', 'sent-1']);

    // No duplicate once a later successful walk echoes the send back.
    listMessages.mockResolvedValueOnce({
      status: 'open',
      messages: [TEAM_MSG, { id: 'sent-1', authorKind: 'reporter', authorName: null, body: 'hello', createdAt: '2026-08-01T02:00:00.000Z' }],
      nextCursor: null,
      hasMore: false,
    });
    const later = await client.get('t1');
    expect(later!.messages.map((m) => m.id)).toEqual(['m1', 'sent-1']);
    expect(later!.messages.filter((m) => m.id === 'sent-1')).toHaveLength(1);
  });

  // Finding 8-SDK: the old fixed 10-page cap kept the FIRST 500 messages
  // (oldest-first walk), hiding the newest messages of a long thread. get()
  // must walk to hasMore:false, keeping the LAST MESSAGE_FETCH_WINDOW
  // messages instead, and flag truncation:'older-dropped' when older ones
  // were dropped by the window (finding 2-SDK: distinct from 'incomplete').
  it('get() keeps the LAST MESSAGE_FETCH_WINDOW messages across many pages and marks truncation older-dropped, fresh', async () => {
    const PAGES = 12;
    const PER_PAGE = 50;
    const listMessages = vi.fn();
    for (let page = 0; page < PAGES; page++) {
      const pageMessages: ThreadMessage[] = Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `p${page}-${i}`,
        authorKind: 'team' as const,
        authorName: 'Acme Support',
        body: `msg ${page}-${i}`,
        createdAt: '2026-08-01T00:00:00.000Z',
      }));
      const isLast = page === PAGES - 1;
      listMessages.mockResolvedValueOnce({
        status: 'open',
        messages: pageMessages,
        nextCursor: isLast ? null : `c${page + 1}`,
        hasMore: !isLast,
      });
    }
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    const detail = await client.get('t1');
    expect(detail!.messages).toHaveLength(MESSAGE_FETCH_WINDOW);
    expect(detail!.truncation).toBe('older-dropped');
    expect(detail!.fresh).toBe(true);
    // 600 total - 500 window = 100 dropped = pages 0-1; last kept is p11-49.
    expect(detail!.messages[0]?.id).toBe('p2-0');
    expect(detail!.messages.at(-1)?.id).toBe(`p${PAGES - 1}-${PER_PAGE - 1}`);
  });

  it('get() on a short thread (single page) is not truncated and fresh', async () => {
    const listMessages = vi.fn(async () => ({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false }));
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    const detail = await client.get('t1');
    expect(detail!.truncation).toBe(false);
    expect(detail!.fresh).toBe(true);
  });

  // Finding 2-SDK: the hard page ceiling is a strictly WORSE situation than
  // an ordinary window trim — the server never confirmed hasMore:false, so
  // we cannot vouch the window holds the true latest messages. It must be
  // reported as a distinct 'incomplete' value (not folded into the same
  // boolean as 'older-dropped') so ThreadView can suppress mark-read.
  it('get() reports truncation:"incomplete" when the hard page ceiling is hit before hasMore:false', async () => {
    // MESSAGE_FETCH_PAGE_HARD_CAP pages, every one still reporting hasMore:true.
    const listMessages = vi.fn(async (): Promise<{ status: 'open'; messages: ThreadMessage[]; nextCursor: string; hasMore: true }> => ({
      status: 'open',
      messages: [TEAM_MSG],
      nextCursor: 'more',
      hasMore: true,
    }));
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    const detail = await client.get('t1');
    expect(detail!.truncation).toBe('incomplete');
    expect(detail!.fresh).toBe(true);
  });

  // Finding 2-SDK: a failed/incomplete get() must never be silently
  // acknowledged as a fresh view of the thread. `fresh` distinguishes a
  // genuine successful fetch from a cached or degraded fallback so a caller
  // (ThreadView) can gate mark-read correctly.
  it('get() marks a failed fetch fresh:false, even the cached-fallback and sentBuffer-only-fallback paths', async () => {
    // First call succeeds (establishes a cached lastDetail); second call fails.
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false })
      .mockRejectedValueOnce(new ReporterApiError('network_error', null));
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    const first = await client.get('t1');
    expect(first!.fresh).toBe(true);
    const second = await client.get('t1'); // fails -> falls back to cached
    expect(second!.fresh).toBe(false);
    expect(second!.messages.map((m) => m.id)).toEqual(['m1']); // still shows cached history

    // A thread with a summary but no prior successful get() falls back to
    // the sentBuffer-only view — also not fresh.
    const listMessages2 = vi.fn(async () => { throw new ReporterApiError('network_error', null); });
    const client2 = make(makeApi({ listMessages: listMessages2 }));
    await client2.refresh(); // populates the thread summary, no get() yet
    await client2.reply('t1', 'hi'); // seeds sentBuffer via a confirmed send
    const detail2 = await client2.get('t1');
    expect(detail2!.fresh).toBe(false);
  });

  // Finding 4-SDK: sentBuffer entries were deduped against only the FINAL,
  // post-window-trim `messages` set. Once enough newer messages pushed a
  // confirmed local send out of the MESSAGE_FETCH_WINDOW, its id never
  // showed up in that final `seen` set again, so it stayed in sentBuffer
  // forever and got re-appended to every future get() as if it were the
  // NEWEST message — even though it's actually old, acknowledged, and
  // already present (further back) in the server's real history. The fix
  // prunes an entry the moment its id is observed in ANY fetched page
  // during the walk, before the window trims it away.
  it('prunes a sentBuffer entry once observed in a fetched page, even after the window trims it out — it never leaks back on a later get()', async () => {
    const postMessage = vi.fn(async () => ({ id: 'echo-1' }));
    const listMessages = vi.fn();
    const client = make(makeApi({ postMessage, listMessages }));
    await client.refresh();
    await client.reply('t1', 'hello'); // confirmed send buffered under sentBuffer['t1']

    const PAGES = 12;
    const PER_PAGE = 50;
    for (let page = 0; page < PAGES; page++) {
      const isEchoSlot = (i: number) => page === 0 && i === 0;
      const pageMessages: ThreadMessage[] = Array.from({ length: PER_PAGE }, (_, i) => ({
        id: isEchoSlot(i) ? 'echo-1' : `p${page}-${i}`,
        authorKind: isEchoSlot(i) ? ('reporter' as const) : ('team' as const),
        authorName: isEchoSlot(i) ? null : 'Acme Support',
        body: isEchoSlot(i) ? 'hello' : `msg ${page}-${i}`,
        createdAt: '2026-08-01T00:00:00.000Z',
      }));
      const isLast = page === PAGES - 1;
      listMessages.mockResolvedValueOnce({
        status: 'open',
        messages: pageMessages,
        nextCursor: isLast ? null : `c${page + 1}`,
        hasMore: !isLast,
      });
    }

    const detail = await client.get('t1');
    // 600 total - 500 window = 100 dropped = pages 0-1, which is where the
    // echoed reporter message lives — it's legitimately outside the window.
    expect(detail!.messages).toHaveLength(MESSAGE_FETCH_WINDOW);
    expect(detail!.messages.some((m) => m.id === 'echo-1')).toBe(false);
    // Specifically: it must NOT be tacked on at the end as if newest.
    expect(detail!.messages.at(-1)?.id).toBe(`p${PAGES - 1}-${PER_PAGE - 1}`);

    // A later get() (window now excludes it via a small, unrelated page)
    // must not resurrect it either — the buffer entry was pruned for good.
    listMessages.mockResolvedValueOnce({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false });
    const later = await client.get('t1');
    expect(later!.messages.some((m) => m.id === 'echo-1')).toBe(false);
  });

  // Finding 1-SDK: get() used to route replies_disabled through
  // handleAuthFailure and return null unconditionally — ThreadView treats
  // null as "the thread vanished" and navigates back, even though the
  // client deliberately keeps the summary as closed/read-only. A reporter
  // could no longer open a conversation they could still see listed. Once
  // the latch is engaged, get() must not even attempt the doomed network
  // read; while it's engaging (this call's own listMessages threw
  // replies_disabled), it must still latch exactly as before (closed
  // threads, ETag cleared, polling stopped) but hand back the cached detail
  // instead of null.
  it('get() returns the cached closed detail (not null) when replies_disabled fires mid-fetch, and the next get() makes no further doomed read', async () => {
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false })
      .mockRejectedValueOnce(new ReporterApiError('replies_disabled', 401));
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    const first = await client.get('t1');
    expect(first!.fresh).toBe(true);

    const second = await client.get('t1'); // replies_disabled fires mid-fetch
    expect(second).not.toBeNull();
    expect(second!.fresh).toBe(false);
    expect(second!.status).toBe('closed');
    expect(second!.messages.map((m) => m.id)).toEqual(['m1']);
    expect(client.getState().readOnly).toBe(true);
    expect(listMessages).toHaveBeenCalledTimes(2);

    // Latched: the third call must not attempt another network read at all.
    const third = await client.get('t1');
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(third).not.toBeNull();
    expect(third!.fresh).toBe(false);
    expect(third!.status).toBe('closed');
    expect(third!.messages.map((m) => m.id)).toEqual(['m1']);
  });

  // Finding 1-SDK: a thread with no prior successful get() (so no cached
  // lastDetail) must still surface something — the sentBuffer-only shape —
  // rather than null, once the latch engages, as long as the reporter still
  // has a summary for it.
  it('get() falls back to the sentBuffer-only shape (still not null) under the replies_disabled latch when nothing was ever cached', async () => {
    const listMessages = vi.fn(async () => { throw new ReporterApiError('replies_disabled', 401); });
    const client = make(makeApi({ listMessages }));
    await client.refresh(); // populates the thread summary, no successful get() yet
    const detail = await client.get('t1');
    expect(detail).not.toBeNull();
    expect(detail!.fresh).toBe(false);
    expect(detail!.status).toBe('closed');
    expect(client.getState().readOnly).toBe(true);
  });

  // invalid_device_token means the identity itself is gone — there is no
  // history to show under a token that no longer exists, so this must keep
  // returning null (unlike replies_disabled, where the identity is still
  // valid and the thread is merely read-only).
  it('get() still returns null when invalid_device_token fires mid-fetch — the identity is gone, not just read-only', async () => {
    const listMessages = vi.fn()
      .mockResolvedValueOnce({ status: 'open', messages: [TEAM_MSG], nextCursor: null, hasMore: false })
      .mockRejectedValueOnce(new ReporterApiError('invalid_device_token', 401));
    const client = make(makeApi({ listMessages }));
    await client.refresh();
    await client.get('t1');
    expect(await client.get('t1')).toBeNull();
  });

  // Finding 2-SDK: get() used to restart the oldest-first walk from cursor
  // zero on EVERY call. The frozen server contract allows 60 message-page
  // reads/minute (50 rows/page), so a thread past 60 pages deterministically
  // 429s mid-walk; the next get() started over and could never converge.
  // get() must persist a per-thread checkpoint (cursor + accumulated window
  // + pages consumed) on a transient failure and RESUME from it instead.
  it('resumes a rate-limited walk from its checkpoint instead of restarting at cursor zero, and converges on the newest messages', async () => {
    const TOTAL_PAGES = 70; // more pages than the 60-page/minute rate window
    const PER_PAGE = 50;
    const FAIL_AT_CALL = 61; // the 61st listMessages call 429s
    let callCount = 0;
    const listMessages = vi.fn(async (_token: string, _threadId: string, cursor: string | null) => {
      callCount++;
      const pageIndex = cursor ? Number(cursor.slice(1)) : 0;
      if (callCount === FAIL_AT_CALL) {
        throw new ReporterApiError('rate_limit_exceeded', 429, 30);
      }
      const pageMessages: ThreadMessage[] = Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `p${pageIndex}-${i}`,
        authorKind: 'team' as const,
        authorName: 'Acme Support',
        body: `msg ${pageIndex}-${i}`,
        createdAt: '2026-08-01T00:00:00.000Z',
      }));
      const isLast = pageIndex === TOTAL_PAGES - 1;
      return {
        status: 'open' as const,
        messages: pageMessages,
        nextCursor: isLast ? null : `c${pageIndex + 1}`,
        hasMore: !isLast,
      };
    });
    const nowRef = { ms: 0 };
    const client = make(makeApi({ listMessages }), nowRef);
    await client.refresh();

    const first = await client.get('t1');
    expect(first!.fresh).toBe(false);
    expect(first!.truncation).toBe('incomplete');
    // Finding 1 (round 9, PR review): a get() 429 now sets an internal READ
    // cooldown, distinct from the public (send-only) cooldownUntilMs — so
    // the composer / send path is never affected by a read-side rate limit.
    expect(client.getState().cooldownUntilMs).toBeNull();
    const callsAfterFirst = listMessages.mock.calls.length;
    expect(callsAfterFirst).toBe(FAIL_AT_CALL); // 60 successful pages + the 429, no restart

    // Finding 3 (round 7 re-review): get() now respects the cooldown the
    // 429 just set — same guard the send paths already had — instead of
    // hitting the network again immediately. Advance past the deadline
    // before the walk is allowed to resume.
    nowRef.ms = 30_000;
    const second = await client.get('t1');
    // Resumed from the checkpoint's cursor (page 60), NOT cursor zero.
    expect(listMessages.mock.calls[callsAfterFirst]?.[2]).toBe('c60');
    expect(second!.fresh).toBe(true);
    expect(second!.truncation).toBe('older-dropped');
    expect(second!.messages).toHaveLength(MESSAGE_FETCH_WINDOW);
    expect(second!.messages.at(-1)?.id).toBe(`p${TOTAL_PAGES - 1}-${PER_PAGE - 1}`);

    // Total reads across both calls is ~ the pages actually needed (70
    // pages + 1 failed attempt = 71), not a doubled restart-from-zero walk
    // (which would have been 60 + 70 = 130).
    expect(listMessages).toHaveBeenCalledTimes(TOTAL_PAGES + 1);
  });

  // Finding 3 (round 7 re-review — Important defect in the companion
  // ThreadView fix): unlike the send paths (reply()/retryPendingSends,
  // which both check cooldownUntilMs), get() used to hit the network
  // unconditionally regardless of an active cooldown. Its 429 handler
  // calls notify() synchronously from inside its own catch, while the
  // ThreadView load that invoked it is still in flight; ThreadView's
  // round-7 finding-3 fix records that notify as a dirty flag and fires
  // exactly one trailing get() once the in-flight call settles — so an
  // ungated get() re-hit the walk, 429'd again, notified again, scheduled
  // again: one live HTTP request per cycle, back to back, until the
  // server's rate window reset. get() must now respect cooldownUntilMs the
  // same way the send paths already do, without disturbing the resumable
  // walk checkpoint.
  it('a rate-limited get() short-circuits on repeat calls during the cooldown (zero network calls), then resumes from the checkpoint once it expires', async () => {
    const PER_PAGE = 10;
    const TOTAL_PAGES = 3;
    const FAIL_AT_CALL = 2; // the 2nd listMessages call 429s (1 page already consumed)
    let callCount = 0;
    const listMessages = vi.fn(async (_token: string, _threadId: string, cursor: string | null) => {
      callCount++;
      const pageIndex = cursor ? Number(cursor.slice(1)) : 0;
      if (callCount === FAIL_AT_CALL) {
        throw new ReporterApiError('rate_limit_exceeded', 429, 30);
      }
      const pageMessages: ThreadMessage[] = Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `p${pageIndex}-${i}`,
        authorKind: 'team' as const,
        authorName: 'Acme Support',
        body: `msg ${pageIndex}-${i}`,
        createdAt: '2026-08-01T00:00:00.000Z',
      }));
      const isLast = pageIndex === TOTAL_PAGES - 1;
      return {
        status: 'open' as const,
        messages: pageMessages,
        nextCursor: isLast ? null : `c${pageIndex + 1}`,
        hasMore: !isLast,
      };
    });
    const nowRef = { ms: 0 };
    const client = make(makeApi({ listMessages }), nowRef);
    await client.refresh();

    const first = await client.get('t1');
    expect(first!.fresh).toBe(false);
    expect(first!.truncation).toBe('incomplete');
    // Finding 1 (round 9, PR review): same read/send cooldown split as above.
    expect(client.getState().cooldownUntilMs).toBeNull();
    const callsAfterFirst = listMessages.mock.calls.length;
    expect(callsAfterFirst).toBe(FAIL_AT_CALL); // 1 successful page + the 429, no restart

    // Repeat get() calls made WHILE the cooldown is still active — the
    // storm-trigger scenario (a ThreadView trailing reload firing right
    // after the notify() in get()'s own 429 catch) — must issue ZERO
    // further listMessages calls and must not disturb the cooldown.
    const duringCooldown = await client.get('t1');
    expect(listMessages).toHaveBeenCalledTimes(callsAfterFirst); // unchanged — no request made
    expect(duringCooldown).not.toBeNull();
    expect(duringCooldown!.fresh).toBe(false);
    await client.get('t1');
    await client.get('t1');
    // Pinned count: a regression reintroducing the storm (one real request
    // per repeat call) would fail this loudly.
    expect(listMessages).toHaveBeenCalledTimes(callsAfterFirst);
    // Finding 1 (round 9, PR review): the read cooldown is internal-only —
    // the public (send) cooldownUntilMs was never touched by any of this.
    expect(client.getState().cooldownUntilMs).toBeNull();

    // Once the cooldown expires, the walk resumes from its checkpoint
    // (page 0's cursor into page 1), NOT cursor zero.
    nowRef.ms = 30_000;
    const resumed = await client.get('t1');
    expect(listMessages.mock.calls[callsAfterFirst]?.[2]).toBe('c1');
    expect(resumed!.fresh).toBe(true);
    expect(resumed!.truncation).toBe(false);
    expect(resumed!.messages.map((m) => m.id)).toEqual([
      'p0-0', 'p0-1', 'p0-2', 'p0-3', 'p0-4', 'p0-5', 'p0-6', 'p0-7', 'p0-8', 'p0-9',
      'p1-0', 'p1-1', 'p1-2', 'p1-3', 'p1-4', 'p1-5', 'p1-6', 'p1-7', 'p1-8', 'p1-9',
      'p2-0', 'p2-1', 'p2-2', 'p2-3', 'p2-4', 'p2-5', 'p2-6', 'p2-7', 'p2-8', 'p2-9',
    ]);
    // Total reads: TOTAL_PAGES successful + the one 429, no doubled
    // restart-from-zero walk.
    expect(listMessages).toHaveBeenCalledTimes(TOTAL_PAGES + 1);
  });

  // Round-4 re-review residual of round-1 finding 6: get()'s transient-
  // failure path always preferred the in-progress partial walk window over
  // an already-cached, complete detail — but the walk is oldest-first, so
  // an early-page blip's partial window is the thread's OLDEST messages.
  // Displaying it visibly regressed the UI "back in time" until a later
  // get() resumed and converged, even though fresh:false correctly kept
  // markRead from firing. get() must prefer the cached view whenever the
  // partial walk hasn't genuinely advanced past what's already cached.
  it('round-1 finding 6 residual: a transient failure with only early-page progress must not regress the UI to older cached content', async () => {
    const PER_PAGE = 50;
    const TOTAL_PAGES = 3; // small thread, well under the window — no trimming
    const page = (pageIndex: number, hasMore: boolean, nextCursor: string | null) => ({
      status: 'open' as const,
      messages: Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `p${pageIndex}-${i}`,
        authorKind: 'team' as const,
        authorName: 'Acme Support',
        body: `msg ${pageIndex}-${i}`,
        // Increasing, lexicographically-sortable timestamps so later pages
        // are genuinely "newer" under the (createdAt, id) comparison.
        createdAt: `2026-08-01T00:${String(pageIndex).padStart(2, '0')}:${String(i).padStart(2, '0')}.000Z`,
      })),
      nextCursor,
      hasMore,
    });
    const listMessages = vi.fn()
      // First get(): walk all 3 pages successfully — a complete cache.
      .mockResolvedValueOnce(page(0, true, 'c1'))
      .mockResolvedValueOnce(page(1, true, 'c2'))
      .mockResolvedValueOnce(page(2, false, null))
      // Second get(): a fresh walk (checkpoint cleared) reads page 0 fine,
      // then its SECOND read (page 1) hits a transient network error —
      // only early-page progress, strictly older than the cache.
      .mockResolvedValueOnce(page(0, true, 'c1'))
      .mockRejectedValueOnce(new ReporterApiError('network_error', null))
      // Third get(): resumes from the checkpoint (page 1's cursor), not
      // cursor zero, and completes normally.
      .mockResolvedValueOnce(page(1, true, 'c2'))
      .mockResolvedValueOnce(page(2, false, null));
    const client = make(makeApi({ listMessages }));
    await client.refresh();

    const first = await client.get('t1');
    expect(first!.fresh).toBe(true);
    expect(first!.messages).toHaveLength(TOTAL_PAGES * PER_PAGE);
    expect(first!.messages.at(-1)?.id).toBe(`p${TOTAL_PAGES - 1}-${PER_PAGE - 1}`);

    const second = await client.get('t1');
    // Must show the cached (complete, latest) view, NOT the partial
    // page-zero-only window — the exact regression round-1 finding 6
    // asked us to eliminate.
    expect(second!.fresh).toBe(false);
    expect(second!.messages.map((m) => m.id)).toEqual(first!.messages.map((m) => m.id));
    expect(second!.messages.at(-1)?.id).toBe(`p${TOTAL_PAGES - 1}-${PER_PAGE - 1}`);

    // The checkpoint must still be persisted from the REAL partial
    // progress (page 0 fetched, failed on page 1) so the next get()
    // resumes rather than restarting at cursor zero — resumption is
    // unaffected by which view was displayed.
    const callsBeforeThird = listMessages.mock.calls.length;
    const third = await client.get('t1');
    expect(listMessages.mock.calls[callsBeforeThird]?.[2]).toBe('c1'); // resumed from page 1's cursor, not null
    expect(third!.fresh).toBe(true);
    expect(third!.messages.map((m) => m.id)).toEqual(first!.messages.map((m) => m.id));
  });

  // Companion case: once a resumed/partial walk has genuinely advanced
  // past what the cache already covers, the newer partial view must win —
  // the fix must not pin the display to the cache forever.
  it('round-1 finding 6 residual: once a partial walk has genuinely passed the cached window, the newer partial view wins', async () => {
    const PER_PAGE = 50;
    const page = (pageIndex: number, hasMore: boolean, nextCursor: string | null) => ({
      status: 'open' as const,
      messages: Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `p${pageIndex}-${i}`,
        authorKind: 'team' as const,
        authorName: 'Acme Support',
        body: `msg ${pageIndex}-${i}`,
        createdAt: `2026-08-01T00:${String(pageIndex).padStart(2, '0')}:${String(i).padStart(2, '0')}.000Z`,
      })),
      nextCursor,
      hasMore,
    });
    const listMessages = vi.fn()
      // First get(): the thread has exactly 2 pages right now; the walk
      // completes and caches pages 0-1.
      .mockResolvedValueOnce(page(0, true, 'c1'))
      .mockResolvedValueOnce(page(1, false, null))
      // Second get(): the thread has since grown. A fresh walk re-reads
      // pages 0-2 — page 2 is genuinely newer than anything cached — then
      // hits a transient failure on page 3.
      .mockResolvedValueOnce(page(0, true, 'c1'))
      .mockResolvedValueOnce(page(1, true, 'c2'))
      .mockResolvedValueOnce(page(2, true, 'c3'))
      .mockRejectedValueOnce(new ReporterApiError('network_error', null))
      // Third get(): resumes from the checkpoint and finishes the walk.
      .mockResolvedValueOnce(page(3, false, null));
    const client = make(makeApi({ listMessages }));
    await client.refresh();

    const first = await client.get('t1');
    expect(first!.fresh).toBe(true);
    expect(first!.messages.at(-1)?.id).toBe('p1-49');

    const second = await client.get('t1');
    // The partial walk has already read page 2, strictly newer than
    // anything the cache had (page 1) — it must win over the stale cache.
    expect(second!.fresh).toBe(false);
    expect(second!.truncation).toBe('incomplete');
    expect(second!.messages.at(-1)?.id).toBe('p2-49');

    const callsBeforeThird = listMessages.mock.calls.length;
    const third = await client.get('t1');
    expect(listMessages.mock.calls[callsBeforeThird]?.[2]).toBe('c3'); // resumed, not restarted
    expect(third!.fresh).toBe(true);
    expect(third!.messages.at(-1)?.id).toBe('p3-49');
  });

  it('regression: a poll-driven retry never double-sends a message whose POST is already in flight', async () => {
    let resolvePost!: (v: { id: string }) => void;
    const postMessage = vi.fn(
      () => new Promise<{ id: string }>((resolve) => { resolvePost = resolve; }),
    );
    const client = make(makeApi({ postMessage }));
    await client.refresh();

    const replyPromise = client.reply('t1', 'hello');       // POST in flight, not yet resolved
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));

    // A scheduled tick (or an explicit refresh()) racing the still-pending
    // send must not fire a second concurrent POST for the same message.
    await client.refresh();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(client.getState().pending).toHaveLength(1);
    expect(client.getState().pending[0]).toMatchObject({ state: 'sending', attempts: 0 });

    resolvePost({ id: 'srv-once' });
    await replyPromise;

    expect(postMessage).toHaveBeenCalledTimes(1);            // still exactly once
    expect(client.getState().pending).toHaveLength(0);        // confirmed exactly once
    const detail = await client.get('t1');
    expect(detail!.messages.filter((m) => m.id === 'srv-once')).toHaveLength(1);
  });
});

// Finding 2 (round 10, PR review): a read 429 wrote the internal
// readCooldownUntilMs deadline and notified once, but nothing ever
// scheduled another get() at the deadline — no timer, and ordinary
// ETag-304 list polls don't notify. So crossing the deadline changed no
// observable state: a long conversation that hit the ~60-page read bucket
// stayed partial until an unrelated notification or a close/reopen. The
// fix arms a one-shot wake (via the injected schedule/cancel deps) at the
// read-cooldown deadline that notify()s subscribers — so a subscribed
// view (ThreadView) reloads and the resumable walk checkpoint advances on
// its own, without ever touching the poll loop itself.
describe('read cooldown recovery wake (finding 2, round 10 PR review)', () => {
  it('a read 429 arms a one-shot wake: exactly one notify at the deadline, and the resumed get() hits listMessages again from the checkpoint (not cursor zero)', async () => {
    const PER_PAGE = 10;
    const TOTAL_PAGES = 3;
    const FAIL_AT_CALL = 2; // 1 page consumed, then the 2nd call 429s
    let callCount = 0;
    const listMessages = vi.fn(async (_token: string, _threadId: string, cursor: string | null) => {
      callCount++;
      const pageIndex = cursor ? Number(cursor.slice(1)) : 0;
      if (callCount === FAIL_AT_CALL) {
        throw new ReporterApiError('rate_limit_exceeded', 429, 30);
      }
      const pageMessages: ThreadMessage[] = Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `p${pageIndex}-${i}`,
        authorKind: 'team' as const,
        authorName: 'Acme Support',
        body: `msg ${pageIndex}-${i}`,
        createdAt: '2026-08-01T00:00:00.000Z',
      }));
      const isLast = pageIndex === TOTAL_PAGES - 1;
      return {
        status: 'open' as const,
        messages: pageMessages,
        nextCursor: isLast ? null : `c${pageIndex + 1}`,
        hasMore: !isLast,
      };
    });
    const nowRef = { ms: 0 };
    const sched = manualScheduler();
    const client = createThreadClient({
      api: makeApi({ listMessages }), credentials: memoryStore(), isEnabled: () => true,
      now: () => nowRef.ms, schedule: sched.schedule, cancel: sched.cancel,
    });
    await client.refresh();

    const first = await client.get('t1');
    expect(first!.truncation).toBe('incomplete');
    const callsAfterFirst = listMessages.mock.calls.length; // 1 page + the 429
    expect(sched.queued()).toBe(1); // the read-cooldown wake armed

    let notifyCount = 0;
    client.subscribe(() => {
      notifyCount++;
    });

    // No get() has been issued yet — advancing the clock alone changes
    // nothing observable without the wake.
    nowRef.ms = 30_000;
    expect(notifyCount).toBe(0);

    sched.fireAll(); // the scheduled wake fires at the deadline
    expect(notifyCount).toBe(1); // exactly one notify
    expect(sched.queued()).toBe(0); // consumed, not left stacked

    const resumed = await client.get('t1');
    // Resumes from the checkpoint's cursor ('c1'), not a restart at cursor
    // zero.
    expect(listMessages.mock.calls[callsAfterFirst]?.[2]).toBe('c1');
    expect(resumed!.truncation).toBe(false);
    expect(resumed!.fresh).toBe(true);
    expect(listMessages).toHaveBeenCalledTimes(TOTAL_PAGES + 1);
  });

  it('a second read 429 replaces the pending wake instead of stacking a second timer', async () => {
    const listMessages = vi.fn(async () => {
      throw new ReporterApiError('rate_limit_exceeded', 429, 30);
    });
    const nowRef = { ms: 0 };
    const sched = manualScheduler();
    const client = createThreadClient({
      api: makeApi({ listMessages }), credentials: memoryStore(), isEnabled: () => true,
      now: () => nowRef.ms, schedule: sched.schedule, cancel: sched.cancel,
    });
    await client.refresh();

    await client.get('t1'); // 1st 429: arms a wake
    expect(sched.queued()).toBe(1);
    nowRef.ms = 30_000; // deadline passes; the read-cooldown guard now lets a call through
    await client.get('t1'); // 2nd 429: must replace, not add to, the pending wake
    expect(sched.queued()).toBe(1);
  });

  it('the wake is cancelled by shutdown() — no notify fires afterward', async () => {
    const listMessages = vi.fn(async () => {
      throw new ReporterApiError('rate_limit_exceeded', 429, 30);
    });
    const nowRef = { ms: 0 };
    const sched = manualScheduler();
    const client = createThreadClient({
      api: makeApi({ listMessages }), credentials: memoryStore(), isEnabled: () => true,
      now: () => nowRef.ms, schedule: sched.schedule, cancel: sched.cancel,
    });
    await client.refresh();
    await client.get('t1'); // arms the wake
    expect(sched.queued()).toBe(1);

    client.shutdown();
    expect(sched.queued()).toBe(0); // cancelled, not left armed

    let notifyCount = 0;
    client.subscribe(() => {
      notifyCount++;
    });
    sched.fireAll(); // no-op: nothing queued
    expect(notifyCount).toBe(0);
  });
});

// Round-10 re-review, Issue A (High-class defect closed): stopPolling() used
// to leave the read-cooldown wake armed. With the thread view open in a
// hidden tab, the Provider calls stopPolling() on visibilitychange, but the
// wake still fired independently — notify() → ThreadView reload → a real
// listMessages walk resumption (and a markRead POST if it completed fresh)
// — the first path that initiated network traffic in a hidden tab after
// stopPolling(), contradicting the foreground-only posture the pause-epoch
// machinery enforces everywhere else (the same class of defect this
// reviewer previously filed as High). Recovery now happens exclusively on
// the foreground path, in wake().
describe('read cooldown wake vs. a hidden tab (round-10 re-review, Issue A)', () => {
  it('(a)+(b) stopPolling() cancels the pending wake — nothing fires while hidden; wake() then recovers with exactly one notify, and the resumed get() uses the checkpoint', async () => {
    const PER_PAGE = 10;
    const TOTAL_PAGES = 3;
    const FAIL_AT_CALL = 2; // 1 page consumed, then the 2nd call 429s
    let callCount = 0;
    const listMessages = vi.fn(async (_token: string, _threadId: string, cursor: string | null) => {
      callCount++;
      const pageIndex = cursor ? Number(cursor.slice(1)) : 0;
      if (callCount === FAIL_AT_CALL) {
        throw new ReporterApiError('rate_limit_exceeded', 429, 30);
      }
      const pageMessages: ThreadMessage[] = Array.from({ length: PER_PAGE }, (_, i) => ({
        id: `p${pageIndex}-${i}`,
        authorKind: 'team' as const,
        authorName: 'Acme Support',
        body: `msg ${pageIndex}-${i}`,
        createdAt: '2026-08-01T00:00:00.000Z',
      }));
      const isLast = pageIndex === TOTAL_PAGES - 1;
      return {
        status: 'open' as const,
        messages: pageMessages,
        nextCursor: isLast ? null : `c${pageIndex + 1}`,
        hasMore: !isLast,
      };
    });
    const nowRef = { ms: 0 };
    const sched = manualScheduler();
    const client = createThreadClient({
      api: makeApi({ listMessages }), credentials: memoryStore(), isEnabled: () => true,
      now: () => nowRef.ms, schedule: sched.schedule, cancel: sched.cancel,
    });
    await client.refresh();

    const first = await client.get('t1'); // 1 page consumed, then 429s: arms the wake
    expect(first!.truncation).toBe('incomplete');
    expect(sched.queued()).toBe(1);
    const callsAfterFirst = listMessages.mock.calls.length;

    let notifyCount = 0;
    client.subscribe(() => {
      notifyCount++;
    });

    // (a) the tab goes hidden — the Provider calls stopPolling() on
    // visibilitychange. The pending wake must be cancelled, not left to
    // fire independently while the tab is hidden.
    client.stopPolling();
    expect(sched.queued()).toBe(0);

    nowRef.ms = 30_000; // the deadline passes WHILE the tab is hidden
    sched.fireAll(); // no-op: nothing was left queued to fire
    expect(notifyCount).toBe(0);
    expect(listMessages).toHaveBeenCalledTimes(callsAfterFirst); // no network activity in the hidden tab

    // (b) the tab returns to the foreground — the Provider calls wake().
    // The deadline has already passed, so wake() itself notifies exactly
    // once, standing in for the wake that was cancelled while hidden.
    client.wake();
    expect(notifyCount).toBe(1);

    const resumed = await client.get('t1');
    // Resumes from the checkpoint's cursor ('c1'), not a restart at cursor
    // zero.
    expect(listMessages.mock.calls[callsAfterFirst]?.[2]).toBe('c1');
    expect(resumed!.truncation).toBe(false);
    expect(resumed!.fresh).toBe(true);
  });

  it('(c) wake() while the deadline is still in the future re-arms the wake for the remaining time, and it fires exactly one notify once that time passes', async () => {
    const listMessages = vi.fn(async () => {
      throw new ReporterApiError('rate_limit_exceeded', 429, 30);
    });
    const nowRef = { ms: 0 };
    const sched = manualScheduler();
    const client = createThreadClient({
      api: makeApi({ listMessages }), credentials: memoryStore(), isEnabled: () => true,
      now: () => nowRef.ms, schedule: sched.schedule, cancel: sched.cancel,
    });
    await client.refresh();
    await client.get('t1'); // 429s: arms the wake for a 30s deadline
    expect(sched.queued()).toBe(1);

    client.stopPolling(); // hidden — cancels the pending wake
    expect(sched.queued()).toBe(0);

    nowRef.ms = 10_000; // only PART of the cooldown has elapsed — deadline still 20s out
    let notifyCount = 0;
    client.subscribe(() => {
      notifyCount++;
    });

    client.wake(); // foreground return: deadline still in the future → re-arm, not notify
    expect(notifyCount).toBe(0); // not yet — the deadline hasn't passed
    // The re-arm uses the REMAINING time (20s), not the original 30s. (wake()
    // also restarts the poll loop as an unrelated, expected side effect — an
    // immediate 0ms tick — so isolate the read-cooldown wake's own entry by
    // its delay rather than assuming queue order or firing everything.)
    expect(sched.delays()).toContain(20_000);

    nowRef.ms = 30_000; // the true deadline
    sched.fireDelay(20_000); // fire ONLY the read-cooldown wake's entry
    expect(notifyCount).toBe(1); // fires exactly once, at the right time
  });
});

// Round-10 re-review, Issue B (tidiness): handleAuthFailure() didn't cancel
// a pending read-cooldown wake, leaving a stale one-shot that would fire
// into a guarded (shutdownFlag/readOnly-checked) no-op. Harmless, but
// pointless — cancel it there too, for both branches.
describe('read cooldown wake vs. an auth-failure latch (round-10 re-review, Issue B)', () => {
  it('a replies_disabled latch engaged while a read-cooldown wake is pending cancels it — no notify fires at the old deadline', async () => {
    const listMessages = vi.fn(async () => {
      throw new ReporterApiError('rate_limit_exceeded', 429, 30);
    });
    const markRead = vi.fn(async () => {
      throw new ReporterApiError('replies_disabled', 401);
    });
    const nowRef = { ms: 0 };
    const sched = manualScheduler();
    const client = createThreadClient({
      api: makeApi({ listMessages, markRead }), credentials: memoryStore(), isEnabled: () => true,
      now: () => nowRef.ms, schedule: sched.schedule, cancel: sched.cancel,
    });
    await client.refresh();
    await client.get('t1'); // 429s: arms the read-cooldown wake
    expect(sched.queued()).toBe(1);

    await client.markRead('t1'); // an unrelated call trips the replies_disabled latch
    expect(client.getState().readOnly).toBe(true);
    expect(sched.queued()).toBe(0); // the pending wake was cancelled by the latch

    let notifyCount = 0;
    client.subscribe(() => {
      notifyCount++;
    });
    nowRef.ms = 30_000; // the old deadline
    sched.fireAll(); // no-op: nothing queued
    expect(notifyCount).toBe(0);
  });

  it('an invalid_device_token reset while a read-cooldown wake is pending cancels it — no notify fires at the old deadline', async () => {
    const listMessages = vi.fn(async () => {
      throw new ReporterApiError('rate_limit_exceeded', 429, 30);
    });
    const markRead = vi.fn(async () => {
      throw new ReporterApiError('invalid_device_token', 401);
    });
    const nowRef = { ms: 0 };
    const sched = manualScheduler();
    const client = createThreadClient({
      api: makeApi({ listMessages, markRead }), credentials: memoryStore(), isEnabled: () => true,
      now: () => nowRef.ms, schedule: sched.schedule, cancel: sched.cancel,
    });
    await client.refresh();
    await client.get('t1'); // 429s: arms the read-cooldown wake
    expect(sched.queued()).toBe(1);

    await client.markRead('t1'); // an unrelated call trips the invalid_device_token reset
    expect(sched.queued()).toBe(0); // the pending wake was cancelled by the reset

    let notifyCount = 0;
    client.subscribe(() => {
      notifyCount++;
    });
    nowRef.ms = 30_000; // the old deadline
    sched.fireAll(); // no-op: nothing queued
    expect(notifyCount).toBe(0);
  });
});

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { readBlobArrayBuffer } from '../internal/blob.js';
import {
  buildMultipart,
  submitReport,
  PayloadTooLargeError,
  ensureDeviceToken,
  decodeSub,
  type SubmitResult,
} from '@traceitx/sdk-core';
import type {
  ReportDraft,
  OutboxAdapter,
  OutboxItem,
  ReporterCredentialStore,
  IdentityTokenReader,
  UserMetadata,
} from '@traceitx/sdk-core';
import type { ReportEnvelope } from '@traceitx/protocol';
import type { WebTraceItXConfig } from '../internal/types.js';
import { INGEST_URL } from '../constants.js';
import type { HostSdkName } from '../internal/sdk-identity.js';
import { draftToEnvelope, type CaptureBundle } from './draft-to-envelope.js';

// PR review Finding 2 (P1, 2026-08-06 identity spec) — "never misattribute;
// lose attribution instead."
//
// An outbox entry persists only the envelope, URL, and SDK key (see
// `OutboxItem`); it carries no notion of WHO queued it. Pre-fix, a drain
// attached whatever identity happened to be signed in at DRAIN time, not at
// ENQUEUE time. Concretely: Alice files a report offline, it queues, Alice
// signs out and Bob signs in, the retry fires with Bob's token attached —
// Alice's report is now permanently attributed to Bob.
//
// The fix: record the SUBJECT (`sub`) of whichever identity was active the
// moment an entry gets queued, keyed by `reportId`, in this in-memory-only
// map — never persisted to the outbox's own (durable) storage. `sub` is the
// customer's own end-user id and is frequently an email address; the outbox
// IS persisted (localStorage), so writing an end-user identifier into it
// would be a privacy expansion this fix must not make. The map is therefore
// just a plain module-level `Map`, and it does NOT survive a reload (nothing
// repopulates it from storage) — that's accepted, see below.
//
// At drain time, the entry's recorded subject is compared against the
// CURRENTLY active identity's subject. The identity header is attached only
// when they match; any mismatch — including "no current identity" — sends
// the entry anonymously. An entry with NO recorded subject (queued in a
// previous page-load session, since this map doesn't survive a reload) is
// ALSO always sent anonymously, even if the same user who filed it is still
// signed in. That is a deliberate, accepted limitation: losing attribution
// for a same-user report that crossed a reload is the safe direction; the
// alternative (attaching whatever identity happens to be active at drain
// time without any enqueue-time record to check it against) is exactly the
// misattribution bug this fix exists to close.
//
// Two more tradeoffs worth writing down (PR review, round 2 — neither was
// called out by the original findings):
//   - If a live submit fails and enqueues BEFORE `/api/config` has resolved,
//     `identityTokenReader` (adapter.ts) is still fail-closed OFF, so
//     `recordEnqueuedIdentitySubject` records `null` even if the host has a
//     real identity source set. That entry can then NEVER be attributed —
//     not even later in the SAME session once config resolves and the same
//     user is still signed in — because its recorded subject is frozen at
//     `null` the moment it was enqueued. Safe direction, same as the reload
//     case above, but a real (small) loss of recognition worth knowing about.
//   - This map is not strictly self-cleaning. Entries are deleted alongside
//     every `outbox.delete()` call in this file, but the localStorage outbox
//     itself can evict an item under its own size cap without going through
//     `delete()` here — an orphaned entry just sits in this map forever
//     (bounded by how many reports can physically queue before eviction
//     kicks in, and harmless — a stale `reportId` key with no matching
//     outbox item is simply never looked up again).
const enqueuedSubjects = new Map<string, string | null>();

/**
 * Wraps a real `IdentityTokenReader` so it only ever hands back a token
 * whose decoded `sub` matches `expectedSub` — the subject recorded at
 * enqueue time. Any mismatch (including "no current token") resolves null,
 * same as "no identity token was ever set" everywhere else in this SDK.
 *
 * `expectedSub === null` (the entry was queued with no identity active —
 * anonymous by construction) is checked FIRST and short-circuits to `null`
 * without even calling `reader.get()`. Without this, `decodeSub(token) ===
 * expectedSub` would pass whenever the drain-time token happens to decode to
 * no `sub` at all (`null === null`), putting a live — if malformed —
 * identity credential on the wire for a report the user filed anonymously.
 * The server would reject that token (`bad_subject`) so nothing actually
 * gets misattributed, but presenting a credential at all on an anonymous
 * report isn't something to leave to that technicality.
 */
function subjectGatedReader(reader: IdentityTokenReader, expectedSub: string | null): IdentityTokenReader {
  return {
    async get(now: number): Promise<string | null> {
      if (expectedSub === null) return null;
      const token = await reader.get(now);
      if (token === null) return null;
      return decodeSub(token) === expectedSub ? token : null;
    },
  };
}

/**
 * Resolve the identity token active RIGHT NOW, or null when there is none /
 * it can't be read. Best-effort: a failure resolves to null (the safe
 * "anonymous" direction), never throws into a submit path.
 *
 * PR review, round 3 (Serious) — this used to be `readIdentitySubject`,
 * which resolved a token and immediately threw the token itself away,
 * keeping only its decoded `sub`. That was fine for RECORDING (the subject
 * is all `recordEnqueuedIdentitySubject` needs), but `submitReportFromDraft`
 * below was ALSO handing `opts.identityToken` — the raw, live reader —
 * straight to `submitReport`, which resolves it AGAIN inside http.ts. Two
 * independent resolutions of a reader whose answer can change between them
 * (the host flips from Alice to Bob) means the LIVE request and the
 * recorded subject can each describe a DIFFERENT identity: the live attempt
 * carries Bob's token and succeeds, so the report never queues and the
 * drain-side gate — which only ever sees queued entries — never even gets a
 * chance to catch it. Alice's report ships, and is permanently attributed
 * to Bob. Returning the TOKEN (not just the subject) lets the caller pin
 * ONE resolution and reuse it for both the live request (via
 * `pinnedIdentityReader` below) and the recorded subject, so they provably
 * describe the same identity by construction.
 */
export async function resolveIdentityToken(
  identityToken: IdentityTokenReader | undefined,
): Promise<string | null> {
  try {
    return identityToken ? await identityToken.get(Date.now()) : null;
  } catch {
    return null;
  }
}

/**
 * Wraps a single, already-resolved token (or `null`) as an `IdentityTokenReader`
 * that always returns exactly that value — never re-invoking the real
 * provider. Lets a caller that has already resolved a token ONCE (e.g.
 * `submitReportFromDraft`'s `enqueueTimeToken`, below) hand `submitReport` a
 * reader without risking a SECOND, independent resolution that could answer
 * differently (see `resolveIdentityToken`'s doc for the bug this closes).
 */
function pinnedIdentityReader(token: string | null): IdentityTokenReader {
  return {
    async get(): Promise<string | null> {
      return token;
    },
  };
}

/**
 * Record `subject` against `reportId` for `drainOutbox` to compare against at
 * drain time (module doc above). Call this once, right after a successful
 * `outbox.enqueue(...)`, from EVERY call site that queues an item —
 * `submitReportFromDraft`'s retryable-enqueue branch below, and adapter.ts's
 * crash-sink, which enqueues directly (bypassing `submitReportFromDraft`
 * entirely) and then drains immediately.
 *
 * FINAL REVIEW, FINDING 2 (Important) — the subject passed here must be the
 * one that was active when the REPORT WAS CREATED, not when the enqueue
 * happened. It takes a resolved `string | null` rather than a reader for
 * exactly that reason: `submitReportFromDraft` burns the whole retry schedule
 * (~31s by default) between those two moments, and the previous shape — a
 * reader, read here — reopened the P1 the drain-side gate had just closed.
 * Alice hits Submit with the network down; the live attempt carries Alice's
 * token and fails over ~31s; during that window Alice signs out and Bob signs
 * in (or the host's provider simply starts returning Bob's token); this
 * recorded BOB. At drain, `subjectGatedReader` compared Bob to Bob, matched,
 * and attached Bob's token — Alice's report permanently attributed to Bob and
 * readable from Bob's other devices. Same class as PR finding P1-3; the fix
 * landed at the drain, the leak was at the enqueue.
 */
export function recordEnqueuedIdentitySubject(
  reportId: string,
  subject: string | null,
): void {
  enqueuedSubjects.set(reportId, subject);
}

export interface SubmitOutcome {
  ok: boolean;
  /** True iff the failure is retryable (5xx / 408 / 429 / network / parse). */
  retryable: boolean;
  /** Always set — even on failure paths the envelope was built so reportId exists. */
  reportId: string;
  status?: number;
  error?: Error;
  /**
   * Reply thread id provisioned for this report (replies-enabled apps only).
   * `null` when the server omitted the block (replies disabled, non-2xx, or
   * a client-side failure before the request was sent).
   */
  threadId: string | null;
}

/**
 * End-to-end submit: build envelope → multipart → POST → outbox lifecycle.
 *
 * Outcome routing:
 *   - 2xx → ok=true (delete from outbox if previously enqueued)
 *   - retryable failure (5xx/408/429/network/parse exhaustion) → enqueue + retryable=true
 *   - non-retryable failure (auth/payload/3xx/protocol-mismatch) → no enqueue + retryable=false
 *   - PayloadTooLargeError thrown by buildMultipart → non-retryable, no enqueue
 */
export async function submitReportFromDraft(opts: {
  config: WebTraceItXConfig;
  /**
   * Which SDK produced this report — envelope `sdk.name`. Defaults to
   * `traceitx-react` (see draftToEnvelope): every caller predates
   * `@traceitx/web`'s own `init()`, and a wrong default here mislabels a
   * host's whole report stream.
   *
   * NOT OPTIONAL IN PRACTICE FOR A VANILLA CALLER. This function is exported
   * from `@traceitx/web`'s barrel, and omitting `sdkName` files the report
   * under `traceitx-react`. Codex round 2 (finding 2) asked for the default to
   * be removed; `packages/sdk-react/src/provider.tsx` — published, and out of
   * bounds for this change — depends on it, so the default stays and the
   * rejection argument (with the exact one-line fix that unblocks it) is
   * recorded on `draftToEnvelope`'s `sdkName` parameter. Pass it.
   */
  sdkName?: HostSdkName;
  sdkVersion: string;
  draft: ReportDraft;
  bundle: CaptureBundle;
  outbox: OutboxAdapter | undefined;
  fetch?: typeof globalThis.fetch;
  /** Test-only: override retry schedule for fast specs (default sdk-core schedule). */
  retryScheduleMs?: readonly number[];
  /**
   * Two-way replies device credential store (web: localStorage). Absent/null =>
   * present no device token on ingest and let the server mint one — the
   * pre-existing behaviour.
   */
  credentials?: ReporterCredentialStore | null;
  /**
   * Reporter identity recognition (spec 2026-08-06). Pass the web adapter's
   * `__identityTokenReader` — already self-gated on `identity.enabled`, so
   * this function doesn't need to know about config at all; it just forwards
   * whatever it's given straight into `submitReport`.
   *
   * When `capturedIdentityToken` (below) is ALSO passed, this reader is not
   * independently re-resolved for the pin — see that option's doc. It is
   * still passed straight through where it's genuinely needed elsewhere
   * (kept required alongside `capturedIdentityToken` rather than replaced by
   * it, for callers that don't have a submit-boundary capture available).
   */
  identityToken?: IdentityTokenReader;
  /**
   * PR review, round 4 (Serious) — the identity TOKEN already captured at
   * the SUBMIT BOUNDARY by the caller (provider.tsx's `onComplete` /
   * capture-bridge.ts's `runCompanionSubmit`, both via the adapter's
   * `__captureIdentityAtSubmitBoundary()`), before any of THIS function's
   * own async prep (multipart build, device-token minting) even starts.
   *
   * Rounds 2 and 3 pinned the token used for the live request and the
   * subject recorded for a later retry to the SAME resolution — but that
   * resolution still happened inside `submitReportFromDraft`, which is
   * itself called only after provider.tsx's `onComplete` has already done
   * replay-capture hashing, breadcrumb/network-body snapshotting, and (for
   * the companion path) baked-screenshot hashing — awaits that can span
   * hundreds of milliseconds to seconds for a report carrying a screenshot
   * or replay buffer. An account switch during THAT window pinned the NEW
   * identity to a report the OLD identity actually created.
   *
   * `undefined` (the parameter omitted entirely — distinct from `null`,
   * "captured, and nothing was live") falls back to resolving `identityToken`
   * internally, exactly as before this round; every real entry point now
   * passes this explicitly, so that fallback exists for other callers (unit
   * tests exercising `identityToken` directly) rather than production code.
   */
  capturedIdentityToken?: string | null;
  /**
   * The self-declared `setUser` value for this report, or null for none. See
   * `draftToEnvelope`.
   *
   * External review, finding 1 (Serious) — every production caller passes the
   * value its own SUBMIT-BOUNDARY capture took (`WebPlatformAdapter
   * .__captureUserAtSubmitBoundary()` / `captureUserSnapshot(host.getUser)`),
   * NOT a live read taken at the call site, for the same reason
   * `capturedIdentityToken` above exists: the prep between the user pressing
   * Send and this function running can span seconds, and an account switch
   * inside that window would otherwise attach the new account's label to the
   * old account's report. There is no fallback reader here (unlike the token's
   * `identityToken`), so `undefined` and `null` both simply mean "no user" —
   * the `undefined` = "not captured" distinction lives one level up, on
   * `ReporterCompletePayload.capturedUser`, where a fallback genuinely exists.
   */
  user?: UserMetadata | null;
}): Promise<SubmitOutcome> {
  const { envelope, attachments } = draftToEnvelope(
    opts.draft,
    opts.bundle,
    opts.config,
    opts.sdkVersion,
    opts.user,
    opts.sdkName,
  );
  const reportId = envelope.reportId;
  const url = `${INGEST_URL.replace(/\/$/, '')}/api/ingest`;
  const apiKey = opts.config.apiKey;

  // Convert blob attachments to bytes for buildMultipart.
  const multipartAttachments: Array<{ name: string; bytes: Uint8Array; contentType: string }> = [];
  for (const att of attachments) {
    const buf = new Uint8Array(await readBlobArrayBuffer(att.blob));
    multipartAttachments.push({
      name: att.name,
      bytes: buf,
      contentType: att.blob.type || 'image/png',
    });
  }

  let body: FormData;
  let envelopeContentEncoding: 'gzip' | undefined;
  try {
    const built = await buildMultipart({ envelope, attachments: multipartAttachments });
    body = built.body;
    envelopeContentEncoding = built.envelopeContentEncoding;
  } catch (err) {
    // PayloadTooLargeError or any other build error — non-retryable client-side error.
    return {
      ok: false,
      retryable: false,
      reportId,
      threadId: null,
      error: err instanceof Error ? err : new Error(String(err)),
      ...(err instanceof PayloadTooLargeError ? { status: 413 } : {}),
    };
  }

  // Two-way replies (Task 2/3) — mint or load the device token before submit.
  // A submit NEVER fails over token work: every touch of `deps.credentials`
  // is try/caught.
  let deviceToken: string | undefined;
  if (opts.credentials) {
    try {
      deviceToken = await ensureDeviceToken(opts.credentials);
    } catch {
      // Token is an enhancement; a submit never fails over it.
    }
  }

  // Round-5 PR-review item 6 — the local veto (`replies: { disabled: true }`)
  // already stops us presenting a device token (see `deviceToken` above via
  // the nulled `opts.credentials` seam); it must also tell the SERVER not to
  // fall back to minting one and provisioning a thread the client will never
  // display. `opts.config` is directly reachable at this call site, so read
  // the veto straight off it — the identical boolean adapter.ts used to
  // decide whether to null `reporterCredentials` in the first place, so this
  // is equivalent to (but doesn't require re-deriving from) `!opts.credentials`.
  const repliesOptOut = opts.config.replies?.disabled === true;

  // Final review, finding 2 — resolve the enqueue-time TOKEN once, BEFORE the
  // live attempt, not after it. `submitReport` below can burn the entire
  // DEFAULT_RETRY_SCHEDULE_MS (~31s) before returning `transient-exhausted`,
  // and reading the identity on the far side of that window records whoever is
  // signed in ~31s after the report was created — which, across a sign-out /
  // sign-in, is a different person, and the drain-time gate then MATCHES them
  // and attaches their token.
  //
  // PR review, round 3 (Serious) — resolving here isn't enough on its own:
  // this used to resolve only the SUBJECT and then hand `submitReport` the
  // raw `opts.identityToken` reader for the live request, which resolved it
  // a SECOND time inside http.ts. If the identity flips between those two
  // independent resolutions, the live request carries the NEW identity's
  // token while `enqueueTimeSubject` records the OLD one — and since a
  // successful live attempt never queues, the drain-side gate (which only
  // ever sees queued entries) never gets a chance to catch the mismatch.
  // `enqueueTimeToken` is resolved exactly ONCE; `pinnedIdentityReader`
  // below hands `submitReport` a reader that just returns it, so the live
  // request and the subject recorded for a later retry provably describe
  // the SAME identity. This also collapses what used to be up to two
  // provider round-trips (up to `IDENTITY_PROVIDER_TIMEOUT_MS` each) into
  // one — a hung provider now costs ~2s here, not ~4s.
  //
  // PR review, round 4 (Serious) — resolving even here is still one step
  // too late: this line runs AFTER the caller (provider.tsx's `onComplete`,
  // capture-bridge.ts's `runCompanionSubmit`) has already done replay
  // hashing / breadcrumb + network-body snapshotting / (companion path)
  // baked-screenshot hashing above `submitReportFromDraft` in the call
  // stack — an account switch during THAT prep would still get pinned here.
  // `opts.capturedIdentityToken`, when the caller supplies it (every real
  // entry point does — see its doc), is what was ALREADY live at the true
  // submit boundary, before any of that prep began; only a caller that
  // omits it (tests exercising `identityToken` directly) falls through to
  // resolving here, same as before this round.
  const enqueueTimeToken =
    opts.capturedIdentityToken !== undefined
      ? opts.capturedIdentityToken
      : await resolveIdentityToken(opts.identityToken);
  const enqueueTimeSubject = enqueueTimeToken ? decodeSub(enqueueTimeToken) : null;

  let result: SubmitResult;
  try {
    result = await submitReport(url, apiKey, body, {
      ...(opts.fetch ? { fetchImpl: opts.fetch } : {}),
      ...(opts.retryScheduleMs !== undefined ? { retryScheduleMs: opts.retryScheduleMs } : {}),
      ...(envelopeContentEncoding ? { envelopeContentEncoding } : {}),
      ...(deviceToken ? { deviceToken } : {}),
      ...(repliesOptOut ? { repliesOptOut: true } : {}),
      // Pinned to `enqueueTimeToken` — see the comment above; never the raw
      // `opts.identityToken` reader, which would re-resolve independently.
      ...(opts.identityToken ? { identityToken: pinnedIdentityReader(enqueueTimeToken) } : {}),
      jitter: false,
    });
  } catch (err) {
    return {
      ok: false,
      retryable: false,
      reportId,
      threadId: null,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  if (result.ok) {
    // Delete from outbox in case this report was a re-attempt of a previously queued item.
    try {
      await opts.outbox?.delete(reportId);
    } catch {
      /* swallow — DEFE-02 */
    }
    // Finding 2 — this entry (if any) is resolved now; drop its recorded
    // enqueue-time subject so the map doesn't grow for entries that are done.
    enqueuedSubjects.delete(reportId);
    // Server-minted token — present ONLY when the client sent none; persist it
    // so subsequent submits present it and share the same thread identity.
    if (result.device?.token && opts.credentials) {
      await opts.credentials.save(result.device.token).catch(() => {});
    }
    return {
      ok: true,
      retryable: false,
      reportId,
      status: result.status,
      // Finding 1-CLIENT (PR review round 2): the local veto
      // (`replies: { disabled: true }`) nulls `opts.credentials` before this
      // call, which already stops us from sending a device token — but the
      // server's no-token fallback still provisions a thread and echoes
      // `{ thread, device }` back regardless (it has no way to know the
      // client is locally vetoed). Echoing `result.thread?.id` straight
      // through here made the Provider show the reply-aware toast and
      // wake() a thread client that, under the veto, doesn't even exist —
      // a promise the client can never fulfill. When no credentials store
      // is in play, reply metadata must be ignored end-to-end: no
      // threadId in the outcome (the token-save below is already gated the
      // same way).
      threadId: opts.credentials ? (result.thread?.id ?? null) : null,
    };
  }

  // sdk-core's reason taxonomy → retryable boolean
  const retryable = result.reason === 'transient-exhausted';

  if (retryable && opts.outbox) {
    try {
      const payloadJson = JSON.stringify(envelope);
      const item: OutboxItem = {
        reportId,
        enqueuedAt: Date.now(),
        attempts: result.attempts,
        payload: new TextEncoder().encode(payloadJson),
        metadata: { url, sdkKey: apiKey },
      };
      await opts.outbox.enqueue(item);
      // Finding 2 — record the subject captured BEFORE the live attempt (see
      // `enqueueTimeSubject` above), not whatever is active now: "now" is up
      // to ~31s of retries later, and re-reading here is exactly the hole the
      // final review found.
      recordEnqueuedIdentitySubject(reportId, enqueueTimeSubject);
    } catch {
      /* swallow — DEFE-02 */
    }
  }

  return {
    ok: false,
    retryable,
    reportId,
    status: result.status,
    threadId: null,
  };
}

/**
 * Drain the outbox by re-attempting every queued report against the same submit pipeline.
 *   - 2xx → delete entry
 *   - retryable failure → leave for next drain
 *   - non-retryable failure → delete (we've moved past it)
 */
type DrainOutboxOptions = {
  outbox: OutboxAdapter;
  config: WebTraceItXConfig;
  sdkVersion: string;
  fetch?: typeof globalThis.fetch;
  retryScheduleMs?: readonly number[];
  /** Two-way replies device credential store — same seam as submitReportFromDraft. */
  credentials?: ReporterCredentialStore | null;
  /** Reporter identity recognition (spec 2026-08-06) — same seam as submitReportFromDraft. */
  identityToken?: IdentityTokenReader;
};

type DrainOutboxResult = {
  submitted: number;
  failed: number;
  provisionedThreadIds: string[];
};

const emptyDrainResult = (): DrainOutboxResult => ({
  submitted: 0,
  failed: 0,
  provisionedThreadIds: [],
});

/**
 * Public/manual drain. This retains the original contract: once called, it
 * owns the drain until completion.
 */
export async function drainOutbox(opts: DrainOutboxOptions): Promise<DrainOutboxResult> {
  return drainOutboxInternal(opts);
}

/**
 * Capture-owned drain used by adapter.ts. The predicate closes over the
 * capture's ownership epoch, so a killed adapter remains stale even when a
 * StrictMode remount claims the same adapter again.
 *
 * Deliberately omitted from the package barrel: this is an adapter/transport
 * coordination seam, not a public SDK API.
 */
export async function drainOutboxWhileOwned(
  opts: DrainOutboxOptions,
  isOwned: () => boolean,
): Promise<DrainOutboxResult> {
  return drainOutboxInternal(opts, isOwned);
}

/** Delete a cancelled capture and its in-memory identity association. */
export async function discardEnqueuedReport(
  outbox: OutboxAdapter,
  reportId: string,
): Promise<void> {
  await outbox.delete(reportId);
  enqueuedSubjects.delete(reportId);
}

async function drainOutboxInternal(
  opts: DrainOutboxOptions,
  isOwned?: () => boolean,
): Promise<DrainOutboxResult> {
  const ownershipReleased = (): boolean => isOwned !== undefined && !isOwned();
  if (ownershipReleased()) return emptyDrainResult();

  let items: OutboxItem[];
  try {
    items = await opts.outbox.list();
  } catch {
    return emptyDrainResult();
  }
  if (ownershipReleased()) return emptyDrainResult();

  // Resolve the device token once for the whole drain batch — same identity
  // for every queued report that belongs to THIS app (see the per-item
  // app-scoping branch below). A submit never fails over token work.
  let deviceToken: string | undefined;
  if (opts.credentials) {
    try {
      deviceToken = await ensureDeviceToken(opts.credentials);
    } catch {
      // Token is an enhancement; a drain never fails over it.
    }
  }
  if (ownershipReleased()) return emptyDrainResult();

  // `submitReport` resolves identity and sleeps between retries internally.
  // Put the ownership gate at its final network boundary so every individual
  // attempt re-checks after those awaits. A synthetic non-retryable response
  // makes a cancelled submit stop immediately without calling the real fetch;
  // the post-submit ownership check below keeps that synthetic result from
  // mutating the queue or counters.
  const attemptFetch: typeof globalThis.fetch | undefined = isOwned
    ? async (input, init) => {
        if (!isOwned()) return new Response(null, { status: 499 });
        return opts.fetch ? opts.fetch(input, init) : globalThis.fetch(input, init);
      }
    : opts.fetch;

  // Same veto seam as submitReportFromDraft — read straight off `opts.config`
  // rather than re-derived from `opts.credentials`, but equivalent to it (see
  // that function's comment for why). Applied only to items that belong to
  // THIS app (see below) — a foreign item is always opted out regardless of
  // this app's own veto state.
  const repliesOptOut = opts.config.replies?.disabled === true;

  let submitted = 0;
  let failed = 0;
  const provisionedThreadIds: string[] = [];
  for (const item of items) {
    if (ownershipReleased()) return { submitted, failed, provisionedThreadIds };
    try {
      const json = new TextDecoder().decode(item.payload);
      const envelope = JSON.parse(json) as ReportEnvelope;
      // Replay path: no fresh attachments — server already has the original payload's
      // refs; we re-send the JSON envelope only. Plan 08 e2e covers attachment replay
      // semantics if/when needed.
      const url =
        item.metadata?.['url'] ?? `${INGEST_URL.replace(/\/$/, '')}/api/ingest`;
      const itemSdkKey = item.metadata?.['sdkKey'];
      if (!itemSdkKey) {
        // Pre-key-binding entry: nothing records which project queued it, so
        // it cannot be routed. This used to fall back to
        // `opts.config.apiKey` — sending a queued report to whichever app
        // happens to be mounted at drain time, which for a localStorage
        // outbox shared across an origin is a cross-tenant leak of the whole
        // report. Drop it instead; the outbox is best-effort by design and
        // already evicts oldest-first under quota pressure.
        await opts.outbox.delete(item.reportId);
        enqueuedSubjects.delete(item.reportId);
        continue;
      }

      // Round-6 PR-review Finding 1 (HIGH) — the localStorage outbox is
      // origin-wide (every `traceitx:outbox:*` key on the origin, regardless
      // of which mounted app enqueued it — see outbox/localStorage.ts's
      // listSerialized), but each adapter owns an app-SCOPED reply
      // credential (device token + local veto). Pre-fix, this function
      // resolved ONE token and ONE `repliesOptOut` from whichever app
      // happens to be currently mounted and applied both to EVERY queued
      // item, taking only the per-request API key from the item's own
      // metadata. That sent app A's queued report with app B's device token
      // (and under B's local veto), and any server-minted replacement token
      // for A's report got persisted into B's scoped credential store —
      // orphaning A's new thread and corrupting B's credential with an
      // identity that belongs to a different app's report stream entirely.
      //
      // The fix resolves reply context PER ITEM, keyed off the item's own
      // effective sdk key compared against the currently-mounted app's
      // `opts.config.apiKey`:
      //   - belongs to THIS app: unchanged behavior — present this app's
      //     device token, honor this app's local veto, adopt + persist any
      //     rotated token into this app's store.
      //   - belongs to a DIFFERENT app: still SUBMIT the report — a queued
      //     report must never be silently lost just because a different
      //     app happens to be mounted when the drain runs; delivery matters
      //     more than thread creation — but present NO device token (this
      //     function has no way to reach that other app's credential store
      //     from here) and force `X-TX-Replies-Opt-Out: 1` regardless of
      //     THIS app's own veto state, so the server doesn't fall back to
      //     minting a thread that nobody holding the correct identity could
      //     ever read. A tokenless provision here would recreate exactly
      //     the orphaned-conversation problem this PR has been eliminating.
      //     Any `device`/`thread` block the server still echoes back for a
      //     foreign item is discarded outright: never persisted into this
      //     app's store, and never counted toward `provisionedThreadIds`
      //     (Finding 2) since this app has no thread to wake a poller for.
      const isThisApp = itemSdkKey === opts.config.apiKey;
      const itemDeviceToken = isThisApp ? deviceToken : undefined;
      const itemOptOut = isThisApp ? repliesOptOut : true;
      // Same app-scoping as deviceToken/repliesOptOut above — a foreign
      // item's identity context isn't THIS app's to present (host.setIdentityToken
      // is per-mounted-app, not global), so it gets no identity header either.
      //
      // PR review Finding 2 (P1, 2026-08-06 identity spec) — for a THIS-app
      // item, don't just forward `opts.identityToken` (that's whoever is
      // signed in RIGHT NOW, at drain time — the exact bug: Alice queues,
      // Bob signs in, the retry would carry Bob's token). Gate it through
      // `subjectGatedReader` so the header is only ever attached when the
      // CURRENT identity's `sub` matches the one recorded at enqueue time
      // (`enqueuedSubjects`, module doc above). `recordedSub === undefined`
      // means this entry has no record at all — queued in a previous
      // page-load session, since that map is in-memory only — and per the
      // same doc, that always sends anonymously too, so `itemIdentityToken`
      // is left `undefined` entirely rather than reader-wrapped.
      const recordedSub = isThisApp ? enqueuedSubjects.get(item.reportId) : undefined;
      const itemIdentityToken =
        isThisApp && opts.identityToken && recordedSub !== undefined
          ? subjectGatedReader(opts.identityToken, recordedSub)
          : undefined;

      const built = await buildMultipart({ envelope, attachments: [] });
      if (ownershipReleased()) return { submitted, failed, provisionedThreadIds };
      const result = await submitReport(url, itemSdkKey, built.body, {
        ...(attemptFetch ? { fetchImpl: attemptFetch } : {}),
        ...(opts.retryScheduleMs !== undefined ? { retryScheduleMs: opts.retryScheduleMs } : {}),
        ...(built.envelopeContentEncoding
          ? { envelopeContentEncoding: built.envelopeContentEncoding }
          : {}),
        ...(itemDeviceToken ? { deviceToken: itemDeviceToken } : {}),
        ...(itemOptOut ? { repliesOptOut: true } : {}),
        ...(itemIdentityToken ? { identityToken: itemIdentityToken } : {}),
        jitter: false,
      });
      if (ownershipReleased()) return { submitted, failed, provisionedThreadIds };
      if (result.ok) {
        await opts.outbox.delete(item.reportId);
        // Finding 2 — this entry is resolved; drop its recorded subject (if
        // any) so the map doesn't grow for entries that are done.
        enqueuedSubjects.delete(item.reportId);
        submitted += 1;
        if (isThisApp) {
          // Round-6 PR-review Finding 2 (HIGH) — surface a provisioned
          // thread so the caller (Provider) can wake the idle poller; only
          // THIS app's items count here (a foreign item never provisions a
          // thread this app could ever display — see above).
          if (result.thread?.id) {
            provisionedThreadIds.push(result.thread.id);
          }
          // Finding 1-CLIENT: same rule as submitReportFromDraft's ok
          // branch — a server-provisioned device block is only actionable
          // when a credentials store is in play (i.e. the local veto isn't
          // active).
          if (result.device?.token && opts.credentials) {
            // Feed the replacement back into the batch-local variable
            // immediately (not just persisted) — Finding 3 (round-4 PR
            // review): a server-minted token means what we presented was
            // absent/malformed/revoked, so every subsequent THIS-app item
            // in THIS drain must present the accepted identity too, or the
            // first conversation's replacement gets clobbered by a second,
            // different mint on the next item's response.
            deviceToken = result.device.token;
            await opts.credentials.save(result.device.token).catch(() => {});
          }
        }
        // else: a foreign item's response is never actioned beyond deleting
        // its own queue entry — no token adoption, no thread tracking (see
        // the Finding 1 comment above).
      } else if (result.reason !== 'transient-exhausted') {
        // non-retryable — drop from queue
        await opts.outbox.delete(item.reportId);
        enqueuedSubjects.delete(item.reportId); // Finding 2 — same cleanup as the ok branch
        failed += 1;
      }
      // else: leave for next drain
    } catch {
      failed += 1;
    }
  }
  return { submitted, failed, provisionedThreadIds };
}

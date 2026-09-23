// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-09 Task 1 — TV-side WebSocket client for the phone-companion
// relay. Browser-native `WebSocket` (D-04 / RESEARCH "Don't Hand-Roll");
// no socket.io. Structural mirror of `the reporter WebSocket client`
// (PATTERNS.md) — same backoff schedule, same close-code
// disposition — but acts as the TV side: connects to `/relay/tv` and consumes
// `pair.created` / `pair.bonded` etc. via the codegen'd `relay.RelayMessage`
// zod schema (Plan 06.2-03 — single source of truth for message shapes).
//
// Sole writer of `CompanionAPI.state` and `CompanionAPI.pairUrl` via the
// `__setState` / `__setPairUrl` seams (mirrors iOS `RelayWSClient` from Plan
// 06.2-07).
//
// Reconnect (RESEARCH §Pattern 2): 1s/2s/4s/8s with 10s ceiling, 5-min wall
// budget before `companion.state` transitions to `unpaired` (token revoked).
//
// Threat model (T-06.2-09-01): NEVER `console.log` `pair_token` /
// `device_token` — explicit grep gate at verification time enforces this.
'use client';
import { readBlobArrayBuffer } from '../internal/blob.js';

import type { z, ZodType } from 'zod';
import { relay } from '@everframe/protocol';
import { INGEST_URL } from '../constants.js';
import type { CompanionAPI } from './state.js';
import { announce } from './announce.js';
import type { AnnounceDeviceBlock } from './announce.js';
import { __getCompanionHost } from './host-seam.js';
import {
  handleCompanionPeerLost,
  handleCompanionPreviewStart,
  handleCompanionPreviewStop,
  handleCompanionShotBinaryMarker,
  handleCompanionShotRequest,
  __companionShouldSettleOnCancel,
} from './capture-bridge.js';

// `relay.RelayMessage` is type-only in @everframe/protocol's bundled `.d.ts`
// (tsup namespace re-export collapses const+type aliases to type-only when
// the identifier appears in both positions — see packages/protocol/dist/
// index.d.ts:444). The runtime VALUE is exported normally — we reach it via
// a defensive cast. Drop-in for when protocol's dts emits the value alias too.
const RelayMessageSchema = (relay as unknown as { RelayMessage: ZodType })
  .RelayMessage;

// Derive types from the branch schemas (which ARE exported as both value+type
// per `index_ReportSubmit: typeof ReportSubmit` in the dts) and union them.
export type PairCreated = z.infer<typeof relay.PairCreated>;
export type PairBonded = z.infer<typeof relay.PairBonded>;
export type PairExpired = z.infer<typeof relay.PairExpired>;
export type PhoneDisconnected = z.infer<typeof relay.PhoneDisconnected>;
export type ReportRequest = z.infer<typeof relay.ReportRequest>;
export type ReportAssembled = z.infer<typeof relay.ReportAssembled>;
export type ReportDraftUpdate = z.infer<typeof relay.ReportDraftUpdate>;
export type ReportSubmit = z.infer<typeof relay.ReportSubmit>;
export type ReportCompleted = z.infer<typeof relay.ReportCompleted>;
export type ReportFailed = z.infer<typeof relay.ReportFailed>;
export type ReportRejected = z.infer<typeof relay.ReportRejected>;
export type ReportCancelled = z.infer<typeof relay.ReportCancelled>;

export type RelayMessage =
  | PairCreated
  | PairBonded
  | PairExpired
  | PhoneDisconnected
  | ReportRequest
  | ReportAssembled
  | ReportDraftUpdate
  | ReportSubmit
  | ReportCompleted
  | ReportFailed
  | ReportRejected
  | ReportCancelled;

const BACKOFF_STEPS_MS = [1_000, 2_000, 4_000, 8_000];
const BACKOFF_CEILING_MS = 10_000;
const TOTAL_RECONNECT_BUDGET_MS = 5 * 60 * 1_000;

// Close codes that mean "the pair is gone — don't retry". Catalog lives in
// the ingest service/docs/relay-threat-model.md.
const TERMINAL_CLOSE_CODES = new Set<number>([4001, 4002, 4003, 4004]);

const DEVICE_TOKEN_KEY = 'everframe-companion:device-token';

// External review W1: bounds the ENTIRE device-resolution step inside
// connectWithAnnounce. A host `deviceProvider` that never settles (or throws
// synchronously) must cost the device block, never the socket — this file's
// own rule is "discovery is allowed to fail; reporting is not."
//
// Round 2 W1 invariant: this outer preflight bound MUST exceed the slowest
// inner adapter's own timeout — currently device-id.ts's webOS Luna timer
// (2s). Both timers used to be 3s and raced each other; the outer one is
// registered first in `Promise.race`, so on a silent Luna bridge it won
// deterministically, and the announce omitted the device block even though
// the localStorage UUID fallback would have resolved moments later. Keeping
// this strictly greater than every inner adapter's timeout means a hung
// platform bridge degrades to the NEXT source in the resolution chain, never
// straight to "no device block."
const DEVICE_PREFLIGHT_TIMEOUT_MS = 4_000;

export interface RelayWSClientOpts {
  /**
   * @internal Test/dev override. Production callers omit — the URL is baked
   * into the SDK build via `constants.ts` substitution.
   */
  endpoint?: string;
  /** Companion state surface — `__setState` / `__setPairUrl` writers live here. */
  companion: CompanionAPI;
  /** Fires when a `report.request` text frame arrives (capture-bridge handles). */
  onReportRequest: (correlationId: string) => void;
  /** Fires when a `report.submit` text frame arrives (host completes ingest submit). */
  onReportSubmit: (msg: ReportSubmit) => void;
  /**
   * Fires when an inbound BINARY frame arrives. The phone sends `report.submit`
   * (text) immediately followed by the baked screenshot (binary); the submit
   * path pairs them. Omit if the host doesn't consume the baked image.
   */
  onBinary?: (bytes: ArrayBuffer) => void;
  /**
   * Fires when a `report.cancelled` text frame arrives (phone tapped
   * Discard). `correlationId` identifies WHICH report was cancelled — a
   * delayed cancel for a finished report must not tear down its successor.
   */
  onReportCancelled?: (correlationId?: string) => void;
  /**
   * SDK key used to announce this device to `/api/companion/announce` before
   * each connect attempt (spec 2026-08-07). Omit to skip announce entirely —
   * the client goes straight to plain `/relay/tv`, same as before this
   * feature existed. Companion discovery is opt-in; reporting never depends
   * on it.
   */
  sdkKey?: string;
  /** Optional human label sent with the announce (e.g. "Lobby TV"); length-capped server-side. */
  deviceLabel?: string;
  /**
   * Advertises to the announce endpoint that this device will render an
   * attach-PIN when the relay pushes `attach.challenge` (spec 2026-08-19).
   * Forwarded verbatim into the announce body; see `announce.ts`.
   */
  supportsAttachPin?: boolean;
  /**
   * Device facts + stable id provider (naming spec 2026-08-24). Awaited
   * inside every announce attempt; a null/rejected resolution just omits the
   * `device` block from that attempt's announce body — never fails the
   * connect. Omit entirely to skip device naming (no `id` to send).
   */
  deviceProvider?: () => Promise<AnnounceDeviceBlock | null>;
  /** Test seam — override `globalThis.WebSocket`. */
  webSocketCtor?: typeof WebSocket;
  /** Test seam — override `window.sessionStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** Test seam — override the `announce` import (default: the real HTTP call). */
  announceImpl?: typeof announce;
}

export interface RelayWSClient {
  start(): void;
  send(msg: RelayMessage): void;
  sendBinary(bytes: ArrayBuffer): void;
  stop(): void;
  /**
   * Companion attribution token captured off the most recent `pair.bonded`
   * frame that carried one (dashboard-initiated attach only — `null` on an
   * ordinary QR bond). Consumed by the capture-bridge submit path as the
   * `X-Everframe-Companion-Attribution` header. SECURITY: never log the return value.
   */
  getCompanionAttribution(): string | null;
}

/**
 * Parse + validate an incoming text frame against the codegen'd Zod schema.
 * Returns null on parse / schema failure so callers can drop malformed frames
 * silently (T-06.2-03-02 — defensive boundary at the trust gate).
 */
function parseRelayMessage(raw: string): RelayMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = RelayMessageSchema.safeParse(parsed);
    return result.success ? (result.data as RelayMessage) : null;
  } catch {
    return null;
  }
}

export function createRelayWSClient(opts: RelayWSClientOpts): RelayWSClient {
  const endpoint = opts.endpoint ?? INGEST_URL;
  const WS = opts.webSocketCtor ?? globalThis.WebSocket;
  const storage =
    opts.storage ??
    (typeof window !== 'undefined' ? window.sessionStorage : undefined);

  if (!WS) {
    throw new Error('companion ws-client: WebSocket constructor unavailable');
  }

  let socket: WebSocket | null = null;
  let attempt = 0;
  let reconnectFirstFailureAt: number | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manuallyClosed = false;
  // SECURITY: do not log this token (T-06.2-09-01).
  let deviceToken: string | null = storage?.getItem(DEVICE_TOKEN_KEY) ?? null;
  // Companion attach (spec 2026-08-07). Captured off `pair.bonded` when the
  // relay populated it (dashboard-initiated attach only). SECURITY: never log.
  let attributionToken: string | null = null;
  const doAnnounce = opts.announceImpl ?? announce;

  // Scheme/origin derivation — UNCHANGED from the pre-companion implementation.
  // Schemes follow the page's protocol — wss when https, ws when localhost.
  function wsScheme(): string {
    const isSecure =
      typeof window !== 'undefined' && window.location?.protocol === 'https:';
    const scheme = isSecure ? 'wss' : 'ws';
    // If the endpoint itself was https://, prefer wss regardless of page protocol
    // (the SDK can be embedded on http://localhost dev pages targeting prod relays).
    return endpoint.startsWith('https://') ? 'wss' : scheme;
  }
  function wsOrigin(): string {
    return endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  // OUT OF SCOPE (spec 2026-08-07 Task 16): `/relay/tv/reconnect/:device_token`
  // has no server route on `main` today. Left exactly as found — do not "fix".
  function buildReconnectUrl(token: string): string {
    return `${wsScheme()}://${wsOrigin()}/relay/tv/reconnect/${encodeURIComponent(token)}`;
  }
  function buildTicketlessUrl(): string {
    return `${wsScheme()}://${wsOrigin()}/relay/tv`;
  }
  function buildTicketUrl(ticket: string): string {
    return `${wsScheme()}://${wsOrigin()}/relay/tv/${encodeURIComponent(ticket)}`;
  }

  function scheduleReconnect(): void {
    if (manuallyClosed) return;
    // The server deletes the pair record on ANY TV-socket close (not just
    // terminal codes) — so no `attach.challenge.cleared` frame can ever
    // arrive once we're here, and a retained challenge would be permanently
    // stale. Clear it on every path that reaches this function, i.e. every
    // non-terminal socket death, not only once the reconnect budget blows.
    opts.companion.__setAttachChallenge(null);
    if (reconnectFirstFailureAt === null) {
      reconnectFirstFailureAt = Date.now();
    }
    const elapsed = Date.now() - reconnectFirstFailureAt;
    if (elapsed >= TOTAL_RECONNECT_BUDGET_MS) {
      // Wall budget blown — drop to unpaired, clear stored token.
      storage?.removeItem(DEVICE_TOKEN_KEY);
      deviceToken = null;
      attributionToken = null;
      opts.companion.__setPairUrl(null);
      // code/attachedUserName/resolvedName share pairUrl's lifecycle — cleared wherever it is.
      opts.companion.__setCode(null);
      opts.companion.__setAttachedUserName(null);
      opts.companion.__setResolvedName(null);
      opts.companion.__setState('unpaired');
      return;
    }
    const delay =
      attempt < BACKOFF_STEPS_MS.length
        ? BACKOFF_STEPS_MS[attempt]!
        : BACKOFF_CEILING_MS;
    attempt += 1;
    // Transient drop within the grace window — surface as phoneDisconnected
    // only if we were already paired (pre-bond drops stay `unpaired`).
    if (opts.companion.getState() === 'paired' ||
        opts.companion.getState() === 'report_in_progress') {
      opts.companion.__setState('phone_disconnected');
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  /**
   * Text-frame send usable from inside `applyMessage`.
   *
   * The public `send` lives on the returned object, which is not in scope
   * here; both write to the same `socket`.
   */
  function sendImpl(msg: RelayMessage): void {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
  }

  function sendBinaryImpl(bytes: ArrayBuffer): void {
    if (socket && socket.readyState === 1) socket.send(bytes);
  }

  function applyMessage(msg: RelayMessage): void {
    // Live preview / multi-shot (spec 2026-07-17 §3) are handled BEFORE the
    // switch below because this module's `RelayMessage` is a narrow
    // hand-written union that predates them — they arrive (the parser
    // validates against the full protocol schema) but are not in this type.
    //
    // Task 9 (plan 2026-08-12): the device side of preview and shots routes
    // through the capture-bridge session handlers, which capture via the
    // companion host seam. With no host mounted the handlers refuse with
    // `capture_unavailable` — the exact pre-Task-9 behaviour — rather than
    // leaving the phone on an empty viewport until its no-frame timeout.
    const framed = msg as unknown as {
      type: string;
      correlation_id?: string;
      shot_id?: string;
      rect?: { x: number; y: number; w: number; h: number };
    };
    if (framed.type === 'preview.start') {
      handleCompanionPreviewStart(
        __getCompanionHost(),
        { send: sendImpl, sendBinary: sendBinaryImpl },
        framed.correlation_id ?? '',
      );
      return;
    }
    if (framed.type === 'shot.request') {
      void handleCompanionShotRequest(
        __getCompanionHost(),
        { send: sendImpl, sendBinary: sendBinaryImpl },
        {
          correlation_id: framed.correlation_id ?? '',
          shot_id: framed.shot_id ?? '',
          ...(framed.rect !== undefined ? { rect: framed.rect } : {}),
        },
      );
      return;
    }
    if (framed.type === 'preview.stop') {
      // Phone closed its add-shot screen (or a stop for a preview this
      // device never started — then this is a no-op).
      handleCompanionPreviewStop();
      return;
    }
    if (framed.type === 'shot.binary') {
      // Submit-phase marker: the NEXT binary frame is that shot's baked
      // image, not the report's primary screenshot (plan Task 8 ordering).
      handleCompanionShotBinaryMarker({
        correlation_id: framed.correlation_id ?? '',
        shot_id: framed.shot_id ?? '',
      });
      return;
    }
    // Attach-PIN (spec 2026-08-19) — same "predates this module's hand-written
    // union" technique as preview.start/shot.request above. Server → TV only.
    if (framed.type === 'attach.challenge') {
      const f = msg as unknown as {
        code: string;
        ttl_ms: number;
        requested_by_name: string;
      };
      opts.companion.__setAttachChallenge({
        code: f.code,
        requestedByName: f.requested_by_name,
        ttlMs: f.ttl_ms,
      });
      return;
    }
    if (framed.type === 'attach.challenge.cleared') {
      opts.companion.__setAttachChallenge(null);
      return;
    }
    // Device naming (naming spec 2026-08-24) — server → TV push after a
    // dashboard rename (or clear). Same "predates the hand-written union"
    // technique as attach.challenge above.
    if (framed.type === 'companion.name') {
      const f = msg as unknown as { name: string };
      if (typeof f.name === 'string' && f.name.length > 0 && f.name.length <= 80) {
        opts.companion.__setResolvedName(f.name);
      }
      return;
    }

    switch (msg.type) {
      case 'pair.created':
        // pair_token is in msg, but we publish a pairUrl host-string composed
        // from the pair_id only (the token is a secret — SECURITY: do not log).
        // The relay's actual pair-URL composition is server-driven; for the TV
        // side we expose the URL the phone should hit. Mirrors iOS pairUrl shape.
        opts.companion.__setPairUrl(
          `${endpoint.replace(/\/$/, '')}/r/${encodeURIComponent(msg.pair_token)}`,
        );
        // Round 2 W2: the server destroys the pair record on ANY TV-socket
        // close (terminal or not — see scheduleReconnect's attach-challenge
        // comment), so a `pair.created` reaching us here is by construction
        // an UNBONDED pair — a rebond, if any, arrives as its own
        // `pair.bonded`. Any attach state retained from a previous bond on
        // an earlier connection is therefore stale and must not survive:
        // without this, a non-terminal close (e.g. 1006) that silently
        // killed the bond leaves the badge claiming the old user is still
        // attached indefinitely. resolvedName is deliberately left alone —
        // it's device identity, not attach state.
        opts.companion.__setAttachedUserName(null);
        opts.companion.__setState('unpaired');
        return;
      case 'pair.bonded':
        // SECURITY: do not log device_token.
        //
        // `device_token` was widened to optional in the protocol so the
        // server can omit it on TV-side bond notifications (the TV doesn't
        // reconnect with a device token; only the phone does). This SPA
        // *is* the phone, so we always receive it — but TypeScript doesn't
        // know that. If the field is ever missing here, just don't update
        // the stored token; the rest of the bond transition still happens.
        if (msg.device_token !== undefined) {
          deviceToken = msg.device_token;
          storage?.setItem(DEVICE_TOKEN_KEY, msg.device_token);
        }
        // Companion attach (spec 2026-08-07): both fields are OPTIONAL and
        // both absent on an ordinary QR bond. SECURITY: never log
        // `attribution_token` — it rides straight to the capture-bridge
        // submit path as the X-Everframe-Companion-Attribution header and nowhere
        // else. Explicitly reset to null when absent so a later ordinary
        // bond on the same session can never inherit a stale companion
        // identity from an earlier dashboard attach.
        attributionToken = msg.attribution_token ?? null;
        opts.companion.__setAttachedUserName(msg.companion_user?.display_name ?? null);
        // Keep pairUrl intact on bond — it's nulled only when the socket
        // closes (terminal close / reconnect-budget exhausted). The pair
        // token is single-use server-side, so a retained URL is harmless.
        // Hosts drive QR teardown off `state === 'paired'` — `state` is the
        // reliably-delivered signal across every runtime (incl. the RN native
        // bridge), so it's the single source of truth for QR visibility.
        opts.companion.__setState('paired');
        return;
      case 'pair.expired':
        // Drop the dead device token + return to unpaired, but keep pairUrl —
        // it's cleared only on socket close (see pair.bonded note). A fresh
        // `pair.created` overwrites it with a new token if the relay re-issues.
        storage?.removeItem(DEVICE_TOKEN_KEY);
        deviceToken = null;
        // A released bond ends the attach — the badge (gated on
        // attachedUserName) must not survive a detach. resolvedName is
        // deliberately kept: it's device identity, not attach state.
        opts.companion.__setAttachedUserName(null);
        opts.companion.__setState('unpaired');
        // Task 9 auto-stop: no peer, no preview — stop reading the screen
        // NOW rather than running out the 2-minute cap into nobody.
        handleCompanionPeerLost();
        return;
      case 'phone.disconnected':
        // Phone WS closed (browser tab close, network drop). Pair record
        // stays alive server-side for the 5-min grace window; if the phone
        // reconnects within that window, a fresh `pair.bonded` lands and
        // we flip back. Keep pairUrl as-is — the QR is still scannable
        // until the grace expires and `pair.expired` arrives.
        opts.companion.__setState('phone_disconnected');
        // Task 9 auto-stop — same reasoning as pair.expired above. A phone
        // that reconnects re-sends preview.start for a fresh loop.
        handleCompanionPeerLost();
        return;
      case 'report.request':
        // Round-5 fix: the relay now mints a FRESH attribution token on
        // every report.request for an attached (companion) pair — the
        // bond-time token alone goes stale after ATTRIBUTION_TTL_MS (10 min)
        // while a companion session can stay attached far longer. Take the
        // newest token whenever one rides this frame; an older server (or an
        // ordinary QR pair, which never gets one) sends none, so the
        // bond-time token already captured on `pair.bonded` — possibly
        // null — is simply left in place. SECURITY: never log.
        if (msg.attribution_token !== undefined) {
          attributionToken = msg.attribution_token;
        }
        opts.companion.__setState('report_in_progress');
        opts.onReportRequest(msg.correlation_id);
        return;
      case 'report.submit':
        opts.onReportSubmit(msg);
        return;
      case 'report.cancelled': {
        // Phone-side user tapped Discard after report.request. The TV must
        // return to `paired` so its host UI clears the "report in progress"
        // indicator. Parity with native SDKs (Android
        // CompanionCaptureBridge / iOS handleControl reportCancelled).
        // Ownership is read BEFORE the callback (which clears the state the
        // predicate inspects): a delayed cancel for a finished report must
        // not stomp the successor's report_in_progress (round 3, finding 3);
        // hosts with no bridge-tracked state keep the legacy unconditional
        // transition.
        const settles = __companionShouldSettleOnCancel(msg.correlation_id);
        opts.onReportCancelled?.(msg.correlation_id);
        if (settles) opts.companion.__setState('paired');
        return;
      }
      case 'report.completed':
      case 'report.failed':
      case 'report.rejected':
        // Drop back to paired once the phone-side report finishes.
        opts.companion.__setState('paired');
        return;
      case 'report.assembled':
      case 'report.draft.update':
        // TV-originated frames — should never arrive at the TV. Drop silently.
        return;
      default:
        // Discriminated union exhaustive — defensive.
        return;
    }
  }

  // Opens the socket at a URL already resolved by `connect()` below. Split
  // out so the ticket-holding announce hop (async) and the ticketless /
  // device-token-reconnect paths (sync, unchanged) can share one place that
  // actually constructs the WebSocket and wires its listeners.
  function openSocket(url: string): void {
    if (manuallyClosed) return;
    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.binaryType = 'arraybuffer';

    ws.addEventListener('open', () => {
      attempt = 0;
      reconnectFirstFailureAt = null;
    });

    // Inbound frame ordering. binaryType='arraybuffer' is set below, but TV
    // WebViews (Tizen/WebOS) don't all honor it — some deliver a Blob, whose
    // ArrayBuffer conversion is the ONE async hop in delivery. Left alone,
    // a later frame processed synchronously overtakes the still-converting
    // binary that PRECEDED it on the wire — e.g. a `shot.binary` marker
    // jumping ahead of the primary baked screenshot swaps the primary and an
    // extra shot in the submit framing (review round 2, finding 1). So:
    // frames deliver synchronously (prior behavior) UNTIL a conversion is in
    // flight; from then on every frame rides one promise chain until it
    // drains, preserving total wire order. Each queued link re-checks this
    // socket is still the live one — a conversion resolving after close must
    // not deliver into a reconnected session's framing.
    let inbound: Promise<void> | null = null;
    const deliverText = (data: string): void => {
      const msg = parseRelayMessage(data);
      if (!msg) {
        // eslint-disable-next-line no-console
        console.warn('[companion] dropping malformed control frame');
        return;
      }
      applyMessage(msg);
    };
    ws.addEventListener('message', (ev: MessageEvent) => {
      const data: unknown = ev.data;
      // Generation guard on BOTH paths: after a stop()/start() on the same
      // client, a message the old socket had already queued must not deliver
      // into the new session (review round 3, finding 2).
      if (socket !== ws) return;
      const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
      if (inbound === null && !isBlob) {
        if (typeof data === 'string') deliverText(data);
        else if (data instanceof ArrayBuffer) opts.onBinary?.(data);
        return;
      }
      const link = (inbound ?? Promise.resolve())
        .then(async () => {
          if (socket !== ws) return; // closed/replaced while queued
          if (typeof data === 'string') {
            deliverText(data);
          } else if (data instanceof ArrayBuffer) {
            opts.onBinary?.(data);
          } else if (isBlob) {
            const buf = await readBlobArrayBuffer(data as Blob);
            if (socket !== ws) return;
            opts.onBinary?.(buf);
          }
        })
        .catch(() => {
          // A failed conversion drops that frame only — never the chain.
        })
        .then(() => {
          if (inbound === link) inbound = null; // drained — restore sync path
        });
      inbound = link;
    });

    ws.addEventListener('close', (ev: CloseEvent) => {
      // A STALE close — this socket was already replaced by a newer one via
      // stop()/start() — must not null the live socket, tear down the new
      // session's preview/framing, or schedule a spurious reconnect
      // (review round 3, finding 2). The current socket's own close (or
      // stop(), which runs the teardown itself) handles all of that.
      if (socket !== ws && socket !== null) return;
      socket = null;
      // The server destroys the pair record on ANY TV-socket close (see
      // pair.created's Round 2 W2 note), so whatever peer existed is gone:
      // stop any preview loop NOW rather than letting it capture into a dead
      // (or later re-bonded) socket until the 2-minute cap, and drop
      // half-received submit framing (review round 1, finding 2). A phone
      // that re-bonds after reconnect re-sends preview.start for a fresh
      // loop — which also requires the stale loop to be gone.
      handleCompanionPeerLost();
      if (manuallyClosed) return;
      if (TERMINAL_CLOSE_CODES.has(ev.code)) {
        storage?.removeItem(DEVICE_TOKEN_KEY);
        deviceToken = null;
        attributionToken = null;
        opts.companion.__setPairUrl(null);
        // code/attachedUserName/resolvedName share pairUrl's lifecycle — cleared wherever it is.
        opts.companion.__setCode(null);
        opts.companion.__setAttachedUserName(null);
        opts.companion.__setResolvedName(null);
        // A dead socket means the server can no longer clear the challenge
        // for us — clear it locally rather than leave a stale PIN on screen.
        opts.companion.__setAttachChallenge(null);
        opts.companion.__setState('unpaired');
        return;
      }
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // Followed by `close` — let that drive reconnect scheduling.
    });
  }

  // Tickets from `/api/companion/announce` are single-use — the server burns
  // one on the first `/relay/tv/:ticket` handshake, so EVERY connect
  // attempt (initial `start()` AND each `scheduleReconnect()` retry) must
  // fetch a fresh one. Never cache `announced` across calls.
  async function connectWithAnnounce(): Promise<void> {
    // deviceProvider errors (or a null resolution) just omit the `device`
    // block from THIS attempt's announce body — discovery degrading to "no
    // name" must never cost the device its reporting. Raced against
    // DEVICE_PREFLIGHT_TIMEOUT_MS so a host provider that never settles
    // can't strand the connect (never even opening the ticketless socket).
    // `Promise.resolve().then(...)` converts a SYNCHRONOUS throw from the
    // provider closure into a rejection `.catch` can actually observe —
    // without it, a sync throw here would blow up connectWithAnnounce before
    // `doAnnounce` is ever called.
    const device =
      opts.deviceProvider !== undefined
        ? await Promise.race([
            Promise.resolve()
              .then(() => opts.deviceProvider!())
              .catch(() => null),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), DEVICE_PREFLIGHT_TIMEOUT_MS),
            ),
          ])
        : null;
    const announced = await doAnnounce({
      endpoint,
      sdkKey: opts.sdkKey!,
      ...(opts.deviceLabel !== undefined ? { label: opts.deviceLabel } : {}),
      ...(opts.supportsAttachPin !== undefined
        ? { supportsAttachPin: opts.supportsAttachPin }
        : {}),
      ...(device !== null ? { device } : {}),
    });
    // `stop()` may have run while the announce request was in flight — don't
    // resurrect a socket the host explicitly closed.
    if (manuallyClosed) return;
    if (announced !== null) {
      opts.companion.__setCode(announced.code);
      opts.companion.__setResolvedName(announced.resolvedName);
      openSocket(buildTicketUrl(announced.ticket));
      return;
    }
    // Announce failed for ANY reason (offline, revoked key, 404 on an older
    // server, timeout) — fall through to the plain, ticketless path. This is
    // the rule that outranks everything else here: discovery is allowed to
    // fail; reporting is not.
    opts.companion.__setCode(null);
    opts.companion.__setResolvedName(null);
    openSocket(buildTicketlessUrl());
  }

  function connect(): void {
    if (manuallyClosed) return;
    if (deviceToken) {
      // OUT OF SCOPE (see buildReconnectUrl) — untouched device-token path.
      openSocket(buildReconnectUrl(deviceToken));
      return;
    }
    if (opts.sdkKey !== undefined) {
      void connectWithAnnounce();
      return;
    }
    opts.companion.__setCode(null);
    opts.companion.__setResolvedName(null);
    openSocket(buildTicketlessUrl());
  }

  return {
    start(): void {
      manuallyClosed = false;
      connect();
    },
    send(msg: relay.RelayMessage): void {
      if (socket && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
    sendBinary(bytes: ArrayBuffer): void {
      if (socket && socket.readyState === socket.OPEN) {
        socket.send(bytes);
      }
    },
    stop(): void {
      manuallyClosed = true;
      // Belt for the close-event's braces: if the socket never opened (or
      // already closed), no `close` event will fire to stop a preview loop.
      handleCompanionPeerLost();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket && socket.readyState <= socket.OPEN) {
        socket.close(1000, 'client_close');
      }
      // The socket is dying (or already gone) here regardless of whether it
      // was ever open — same "no cleared frame can ever arrive" reasoning as
      // the close-handler paths above.
      opts.companion.__setAttachChallenge(null);
    },
    getCompanionAttribution(): string | null {
      return attributionToken;
    },
  };
}

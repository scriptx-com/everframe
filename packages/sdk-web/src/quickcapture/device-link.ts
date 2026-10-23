// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the device-link controller. Lazy chunk.
//
// An unlinked TV sends a hello when the capture gesture fires; a `pending`
// reply (or a takeover's `linkPending` from an ingest reply) starts ONE
// attempt: the matching-number banner, and an attempt check every 3 s until
// the attempt ends or 150 s of WALL-CLOCK time pass (a TV resumed from standby
// ends the attempt on its first tick). `linked` saves the token.
//
// Fencing: every async reply is dropped if the session epoch changed (link
// saved or forgotten, teardown) or its attempt claim is no longer current.
// DEFE-02: nothing here throws into the host; tokens and nonces are never
// logged.
import type { DeviceLinkStatusWire } from '@everframe/sdk-core';
import type { DeviceLinkStore } from '../devicelink/store.js';
import { parseOwner, tokenFingerprint, type DeviceLinkOwner } from '../devicelink/token.js';
import type { HelloDevice } from '../devicelink/tv-platform.js';
import { COPY } from './copy.js';
import type { CheckResult, DeviceLinkClient, HelloResult } from './link-client.js';
import type { Overlay } from './overlay.js';

export const HELLO_DEBOUNCE_MS = 5_000;
export const HELLO_SILENCE_AFTER_429_MS = 60_000;
export const CHECK_INTERVAL_MS = 3_000;
export const CHECK_WINDOW_MS = 150_000;

export interface DeviceLinkTimers {
  set(fn: () => void, ms: number): unknown;
  clear(h: unknown): void;
}

export interface DeviceLinkDeps {
  store: DeviceLinkStore;
  client: DeviceLinkClient;
  overlay: Overlay;
  device(): Promise<HelloDevice>;
  nonce(): string | null;
  /** Wall-clock milliseconds (Date.now): the attempt window survives standby. */
  now(): number;
  timers: DeviceLinkTimers;
  onLinkChanged(): void;
  refreshConfig(): void;
}

export interface LinkSnapshot {
  token: string;
  owner: DeviceLinkOwner;
  fingerprint: string;
}

export interface DeviceLinkConfigBlock {
  enabled: boolean;
  link?: DeviceLinkStatusWire | undefined;
}

export interface DeviceLinkController {
  readonly owner: DeviceLinkOwner | null;
  readonly linkingEnabled: boolean;
  snapshot(): LinkSnapshot | null;
  /**
   * Applies a committed config. The `link` status is applied only when the
   * request carried the stored token. Returns the pending recording request
   * when the status applied as linked.
   */
  applyConfig(
    block: DeviceLinkConfigBlock | undefined,
    carriedToken: string | null,
  ): DeviceLinkStatusWire['recording'] | null;
  sendHello(): void;
  beginAttempt(attemptId: string, number: number, nonce: string): void;
  forget(onlyIfToken?: string): boolean;
  teardown(): void;
}

interface Attempt {
  claim: number;
  attemptId: string;
  nonce: string;
  startedAt: number;
  timer: unknown;
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch {
    /* DEFE-02 */
  }
}

export function createDeviceLinkController(deps: DeviceLinkDeps): DeviceLinkController {
  const { store, client, overlay, timers } = deps;
  let epoch = 0;
  let claimSeq = 0;
  let helloSeq = 0;
  let tornDown = false;
  let linkingEnabled = false;
  let attempt: Attempt | null = null;
  let helloInFlight = false;
  let lastHelloAt: number | null = null;
  let silencedUntil = -Infinity;

  function now(): number {
    try {
      return deps.now();
    } catch {
      return Date.now();
    }
  }

  function endAttempt(): void {
    const a = attempt;
    if (!a) return;
    attempt = null;
    guard(() => timers.clear(a.timer));
    guard(() => overlay.hideBanner());
  }

  /** Ends the session's async work: later replies of this epoch are dropped. */
  function bumpEpoch(): void {
    epoch += 1;
    endAttempt();
  }

  function scheduleCheck(a: Attempt): void {
    a.timer = timers.set(() => guard(() => tick(a.claim)), CHECK_INTERVAL_MS);
  }

  function onLinked(token: string, owner: DeviceLinkOwner): void {
    if (!store.save(token, owner)) {
      endAttempt();
      return;
    }
    bumpEpoch(); // also hides the banner
    guard(() => overlay.toast(COPY.linked(owner)));
    guard(() => deps.onLinkChanged());
    guard(() => deps.refreshConfig());
  }

  function tick(claim: number): void {
    const a = attempt;
    if (tornDown || !a || a.claim !== claim) return;
    if (now() - a.startedAt >= CHECK_WINDOW_MS) {
      endAttempt();
      return;
    }
    const myEpoch = epoch;
    let pending: Promise<CheckResult>;
    try {
      pending = client.check(a.attemptId, a.nonce);
    } catch {
      pending = Promise.resolve({ kind: 'retry' });
    }
    pending.then(
      (result) =>
        guard(() => {
          if (tornDown || epoch !== myEpoch || attempt !== a) return;
          switch (result.kind) {
            case 'linked':
              onLinked(result.token, result.owner);
              return;
            case 'expired':
            case 'stop':
              endAttempt();
              return;
            default:
              scheduleCheck(a);
          }
        }),
      () =>
        guard(() => {
          if (tornDown || epoch !== myEpoch || attempt !== a) return;
          scheduleCheck(a);
        }),
    );
  }

  function beginAttempt(attemptId: string, number: number, nonce: string): void {
    guard(() => {
      if (tornDown || attempt) return;
      const a: Attempt = { claim: ++claimSeq, attemptId, nonce, startedAt: now(), timer: null };
      attempt = a;
      guard(() => overlay.showBanner(number));
      scheduleCheck(a);
    });
  }

  function forget(onlyIfToken?: string): boolean {
    try {
      if (!store.clear(onlyIfToken)) return false;
    } catch {
      return false;
    }
    bumpEpoch();
    guard(() => overlay.toast(COPY.UNLINKED));
    guard(() => deps.onLinkChanged());
    guard(() => deps.refreshConfig());
    return true;
  }

  function hasLink(): boolean {
    try {
      return store.load() !== null;
    } catch {
      return false;
    }
  }

  return {
    get owner(): DeviceLinkOwner | null {
      try {
        return store.load()?.owner ?? null;
      } catch {
        return null;
      }
    },
    get linkingEnabled(): boolean {
      return linkingEnabled;
    },

    snapshot(): LinkSnapshot | null {
      try {
        const link = store.load();
        if (!link) return null;
        return { token: link.token, owner: link.owner, fingerprint: tokenFingerprint(link.token) };
      } catch {
        return null;
      }
    },

    applyConfig(block, carriedToken) {
      try {
        if (tornDown) return null;
        linkingEnabled = block?.enabled === true;
        const link = block?.link;
        if (!link || carriedToken === null) return null;
        const stored = store.load();
        if (!stored || stored.token !== carriedToken) return null;
        if (link.status === 'unlinked') {
          forget(carriedToken);
          return null;
        }
        const owner = parseOwner(link.owner);
        if (!owner) return null;
        if (JSON.stringify(owner) !== JSON.stringify(stored.owner)) {
          store.updateOwner(carriedToken, owner);
        }
        return link.recording ?? null;
      } catch {
        return null;
      }
    },

    sendHello(): void {
      guard(() => {
        if (tornDown || !linkingEnabled || attempt || helloInFlight || hasLink()) return;
        const t = now();
        if (lastHelloAt !== null && t - lastHelloAt < HELLO_DEBOUNCE_MS) return;
        if (t < silencedUntil) return;
        const nonce = deps.nonce();
        if (!nonce) return;
        lastHelloAt = t;
        helloInFlight = true;
        const myHello = ++helloSeq;
        const myEpoch = epoch;
        const done = (): void => {
          if (helloSeq === myHello) helloInFlight = false;
        };
        let work: Promise<HelloResult>;
        try {
          work = deps
            .device()
            .then((device) =>
              tornDown || epoch !== myEpoch
                ? ({ kind: 'none' } as HelloResult)
                : client.hello(nonce, device),
            );
        } catch {
          work = Promise.resolve({ kind: 'stop', rateLimited: false });
        }
        work.then(
          (result) =>
            guard(() => {
              done();
              if (tornDown || epoch !== myEpoch) return;
              if (result.kind === 'pending') {
                beginAttempt(result.attemptId, result.number, nonce);
              } else if (result.kind === 'stop' && result.rateLimited) {
                silencedUntil = now() + HELLO_SILENCE_AFTER_429_MS;
              }
            }),
          () => guard(done),
        );
      });
    },

    beginAttempt,
    forget,

    teardown(): void {
      guard(() => {
        tornDown = true;
        bumpEpoch();
      });
    },
  };
}

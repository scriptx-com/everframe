// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The device link: which token this device holds for the running endpoint and
// SDK key, and the one linking attempt that may be in progress.
//
// Rules (from the other SDKs' reviews):
// - One attempt slot, held by a claim object. Every async reply checks that
//   its claim still holds the slot before it acts; the banner is shown and
//   hidden only by its owning claim.
// - The stored record always ends equal to the in-memory link: writes are
//   serialized and each one writes the state current when it runs.
// - A config reply only touches the link when it was sent with the token the
//   device holds now, so a stale reply never forgets a newer token.
// - Nothing here logs, shows or returns a nonce, and the token leaves only
//   through `current()` and `tokenForRequest()`.
import type { CheckResult, HelloDevice, LinkClient } from './link-client.js';
import { linkedToast } from './link-copy.js';
import type { LinkStore } from './link-store.js';
import type { LinkOwner } from './link-token.js';
import type { RemoteConfig } from './remote-config.js';

export const CHECK_INTERVAL_MS = 3000;
export const CHECK_DEADLINE_MS = 150_000;
export const HELLO_DEBOUNCE_MS = 5000;

/** What draws the linking banner and toasts (the root wrapper's overlay store). */
export interface Presenter {
  showBanner(owner: object, number: number): void;
  hideBanner(owner: object): void;
  toast(text: string): void;
}

export interface DeviceLinkDeps {
  store: LinkStore;
  client: LinkClient;
  /** `linkScope(endpoint, sdkKey)`; null means linking cannot run. */
  scope: string | null;
  presenter: Presenter;
  device: HelloDevice;
  nonce: () => string;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  refreshConfig: () => void;
  /** Development-only diagnostics. Never given a token or a nonce. */
  debug?: (message: string) => void;
}

export interface CurrentLink {
  token: string;
  owner: LinkOwner;
}

export interface DeviceLink {
  readonly ready: Promise<void>;
  isLoaded(): boolean;
  current(): CurrentLink | null;
  /** Bumped whenever the held token changes (a new link, or a forget). */
  generation(): number;
  /** The token to send with a config request or quick capture; null before load or without a scope. */
  tokenForRequest(): string | null;
  linkingEnabled(): boolean;
  applyConfig(sentToken: string | null, config: RemoteConfig): void;
  sendHello(): void;
  beginAttempt(attemptId: string, number: number, nonce: string): void;
  forget(onlyIfToken: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

interface Claim {
  timer: unknown;
  deadline: number;
  /** Set once the hello (or a takeover upload) returned a pending attempt. */
  attempt?: { attemptId: string; nonce: string };
}

export function createDeviceLink(deps: DeviceLinkDeps): DeviceLink {
  let loaded = false;
  let link: CurrentLink | null = null;
  let gen = 0;
  let linkingOn = false;
  let claim: Claim | null = null;
  let lastHelloAt = -Infinity;
  let writes: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const sameOwner = (a: LinkOwner, b: LinkOwner): boolean =>
    a.kind === b.kind && (a.kind === 'team' || a.name === (b as { name: string }).name);

  function notify(): void {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // A listener never breaks the link.
      }
    });
  }

  /** Queue a write of whatever the link is when the write runs. */
  function persist(): Promise<boolean> {
    const run = writes.then(async () => {
      const scope = deps.scope;
      if (!scope) return false;
      try {
        if (link) return await deps.store.save({ token: link.token, owner: link.owner, scope });
        await deps.store.clear();
        return true;
      } catch {
        return false;
      }
    });
    writes = run.catch(() => undefined);
    return run;
  }

  function release(owned: Claim): void {
    if (claim !== owned) return;
    deps.clearTimeout(owned.timer);
    claim = null;
    deps.presenter.hideBanner(owned);
  }

  async function onLinked(owned: Claim, token: string, owner: LinkOwner): Promise<void> {
    // The slot stays held until the link is stored, so nothing else starts.
    link = { token, owner };
    gen++;
    const saved = await persist();
    if (!saved)
      deps.debug?.('[everframe] could not store the device link; it lasts until the app stops');
    release(owned);
    deps.presenter.toast(linkedToast(owner));
    notify();
    try {
      deps.refreshConfig();
    } catch {
      // A refresh failure leaves the link as it is.
    }
  }

  function handleCheck(owned: Claim, result: CheckResult): void {
    if (claim !== owned) return;
    switch (result.kind) {
      case 'pending':
      case 'retry':
        schedule(owned);
        return;
      case 'linked':
        void onLinked(owned, result.token, result.owner);
        return;
      default:
        release(owned);
    }
  }

  function schedule(owned: Claim): void {
    owned.timer = deps.setTimeout(() => {
      const target = owned.attempt;
      if (claim !== owned || !target) return;
      if (deps.now() >= owned.deadline) {
        release(owned);
        return;
      }
      deps.client.check(target.attemptId, target.nonce).then(
        (result) => handleCheck(owned, result),
        () => handleCheck(owned, { kind: 'retry' }),
      );
    }, CHECK_INTERVAL_MS);
  }

  function startPolling(owned: Claim, attemptId: string, number: number, nonce: string): void {
    owned.attempt = { attemptId, nonce };
    owned.deadline = deps.now() + CHECK_DEADLINE_MS;
    deps.presenter.showBanner(owned, number);
    schedule(owned);
  }

  const canAttempt = (): boolean => loaded && deps.scope !== null && claim === null;

  const ready = (async () => {
    if (deps.scope) {
      try {
        const stored = await deps.store.load(deps.scope);
        // A link saved while the load was pending wins.
        if (stored && !link) link = { token: stored.token, owner: stored.owner };
      } catch {
        // Unreadable storage reads as unlinked.
      }
    }
    loaded = true;
    notify();
  })();

  return {
    ready,
    isLoaded: () => loaded,
    current: () => (loaded && link ? { token: link.token, owner: link.owner } : null),
    generation: () => gen,
    tokenForRequest: () => (loaded && deps.scope && link ? link.token : null),
    linkingEnabled: () => linkingOn,
    applyConfig(sentToken, config) {
      linkingOn = config.linkingEnabled === true;
      const status = config.link;
      if (!status || sentToken === null || !link || link.token !== sentToken) return;
      if (status.status === 'unlinked') {
        void this.forget(sentToken);
        return;
      }
      if (!sameOwner(link.owner, status.owner)) {
        link = { token: link.token, owner: status.owner };
        void persist();
        notify();
      }
    },
    sendHello() {
      if (!canAttempt() || link || !linkingOn) return;
      const now = deps.now();
      if (now - lastHelloAt < HELLO_DEBOUNCE_MS) return;
      lastHelloAt = now;
      const owned: Claim = { timer: undefined, deadline: now + CHECK_DEADLINE_MS };
      claim = owned;
      const nonce = deps.nonce();
      deps.client.hello(nonce, deps.device).then(
        (result) => {
          if (claim !== owned) return;
          if (result.kind === 'pending')
            startPolling(owned, result.attemptId, result.number, nonce);
          else release(owned);
        },
        () => release(owned),
      );
    },
    beginAttempt(attemptId, number, nonce) {
      if (!canAttempt()) return;
      const owned: Claim = { timer: undefined, deadline: deps.now() + CHECK_DEADLINE_MS };
      claim = owned;
      startPolling(owned, attemptId, number, nonce);
    },
    async forget(onlyIfToken) {
      if (!link || link.token !== onlyIfToken) return;
      link = null;
      gen++;
      notify();
      await persist();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

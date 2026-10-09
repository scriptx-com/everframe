// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { WebReleaseHealthExposureV2, ReleaseHealthRecord } from '@everframe/protocol';
import { HealthJournalError, openReleaseHealthJournal, type ReleaseHealthJournal } from './journal.js';

export interface ReleaseHealthOptions { enabled: boolean; loadedBuildId?: string; userId?: string }
export interface ReleaseHealthDiagnostics {
  state: 'disabled' | 'starting' | 'active' | 'stopped' | 'unavailable';
  exposure: WebReleaseHealthExposureV2 | null;
  queued: number;
  priorQueueLosses: number;
  error?: string;
}
export interface ReleaseHealthHandle {
  ready: Promise<ReleaseHealthDiagnostics>;
  flush(): Promise<void>;
  diagnostics(): Promise<ReleaseHealthDiagnostics>;
}
let pageLaunchId: string | undefined;
// Retain failed erasure intent across producer instances in this document.
// A token prevents an earlier purge from clearing a newer revocation request.
const pendingRevocations = new Map<string, symbol>();
const MAX_REQUEST_MS = 10_000;

/** Init-owned producer. It uses only explicit release-health identity and never assigns outcomes. */
export function setupReleaseHealth(config: {
  apiKey: string; disabled?: boolean; releaseHealth?: ReleaseHealthOptions;
}, endpoint: string, sdkVersion: string) {
  const enabled = config.disabled !== true && config.releaseHealth?.enabled === true;
  const explicitlyDisabled = config.disabled === true || config.releaseHealth?.enabled === false;
  // Snapshot caller-owned mutable objects before the first await.
  const apiKey = config.apiKey;
  const routeIdentity = JSON.stringify([endpoint, apiKey]);
  if (explicitlyDisabled) pendingRevocations.set(routeIdentity, Symbol());
  const loadedBuildId = config.releaseHealth?.loadedBuildId ?? null;
  const userId = config.releaseHealth?.userId;
  let state: ReleaseHealthDiagnostics['state'] = enabled ? 'starting' : 'disabled';
  let exposure: WebReleaseHealthExposureV2 | null = null;
  let startedMono = 0;
  let error: string | undefined;
  let stopped = false;
  let revoked = explicitlyDisabled;
  let hidden = false;
  let listening = false;
  let journal: ReleaseHealthJournal | undefined;
  let route = '';
  let generation = '';
  let losses = 0;
  let inFlight: AbortController | undefined;
  let draining: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation); tail = next.catch(() => undefined); return next;
  };
  const failure = (reason: unknown) => { state = 'unavailable'; error = reason instanceof Error ? reason.message : String(reason); };
  const snapshot = (queued = 0): ReleaseHealthDiagnostics => ({ state, exposure: exposure ? structuredClone(exposure) : null,
    queued, priorQueueLosses: losses, ...(error === undefined ? {} : { error }) });

  async function openJournal(create = true) {
    const bytes = new TextEncoder().encode(routeIdentity);
    route = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
    journal = await openReleaseHealthJournal(create);
    return journal;
  }
  async function purgePending() {
    if (!journal) return;
    while (pendingRevocations.has(routeIdentity)) {
      const token = pendingRevocations.get(routeIdentity);
      await journal.revoke(route);
      if (pendingRevocations.get(routeIdentity) === token) pendingRevocations.delete(routeIdentity);
    }
  }
  async function begin() {
    if (!journal || stopped || revoked || hidden || pendingRevocations.has(routeIdentity)) return;
    const current = await journal.list(route, generation);
    losses = current.losses;
    const next: WebReleaseHealthExposureV2 = {
      exposureId: crypto.randomUUID(), pageLaunchId: pageLaunchId ??= crypto.randomUUID(),
      startedAt: new Date().toISOString(), platform: 'web', sdkVersion,
      nativeRelease: 'not_applicable', loadedBuildId, sessionPolicy: 'launch-v1',
      // null, as on Android and iOS, means no supplied ID.
      subject: userId == null ? { kind: 'anonymous' } : { kind: 'provided', id: userId },
      coverage: { policy: 'web-page-v1', sampleRate: 1, priorQueueLosses: losses },
    };
    const mono = performance.now();
    try {
      await journal.append(route, generation, { schemaVersion: 2, recordId: crypto.randomUUID(),
        exposure: next, phase: 'start', sequence: 0, capturedAt: next.startedAt, elapsedMs: 0 });
    } catch (reason) {
      // The journal counted the refused start as a loss. Only delivery frees a
      // full queue, so stay active without an exposure and keep draining.
      if (!(reason instanceof HealthJournalError && reason.code === 'capacity')) throw reason;
      if (revoked || stopped || pendingRevocations.has(routeIdentity)) return;
      state = 'active'; error = reason.message; return;
    }
    if (revoked || stopped || pendingRevocations.has(routeIdentity)) return;
    exposure = next; startedMono = mono; state = 'active';
  }
  async function end(reason: 'sdk_stop' | 'page_hide') {
    if (!exposure || !journal || revoked) return;
    const record: ReleaseHealthRecord = { schemaVersion: 2, recordId: crypto.randomUUID(), exposure,
      phase: 'end', sequence: 1, capturedAt: new Date().toISOString(),
      elapsedMs: Math.min(31 * 86_400_000, Math.max(0, Math.floor(performance.now() - startedMono))), endReason: reason };
    await journal.append(route, generation, record);
    exposure = null;
  }
  async function diagnostics(): Promise<ReleaseHealthDiagnostics> {
    await ready;
    if (!journal || revoked || !generation) return snapshot();
    try { const current = await journal.list(route, generation); losses = current.losses; return snapshot(current.rows.length); }
    catch (reason) { failure(reason); return snapshot(); }
  }
  async function drain() {
    if (!journal || stopped || revoked || hidden || pendingRevocations.has(routeIdentity) || state === 'unavailable') return;
    const rows = (await journal.list(route, generation)).rows;
    for (const row of rows) {
      if (stopped || revoked || hidden || pendingRevocations.has(routeIdentity)) break;
      // A new transaction observes another tab's revoke before each request.
      const current = await journal.list(route, generation);
      if (!current.rows.some(item => item.key === row.key)) continue;
      if (stopped || revoked || hidden || pendingRevocations.has(routeIdentity)) break;
      const controller = new AbortController(); inFlight = controller;
      const timer = setTimeout(() => controller.abort(), MAX_REQUEST_MS);
      try {
        const response = await fetch(endpoint + '/api/ingest/release-health', { method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(row.record), signal: controller.signal, credentials: 'omit' });
        if (revoked || stopped) break;
        if (response.status === 200 || response.status === 201) await journal.acknowledge(route, generation, row.key, false);
        else if ([400, 409, 410, 413, 422].includes(response.status)) await journal.acknowledge(route, generation, row.key, response.status !== 410);
        else break;
      } catch { break; }
      finally { clearTimeout(timer); if (inFlight === controller) inFlight = undefined; }
    }
  }
  async function flush() {
    await ready;
    if (draining) return draining;
    draining = drain().catch(failure).finally(() => { draining = undefined; });
    return draining;
  }
  const online = () => { void flush(); };
  const pagehide = () => {
    hidden = true; inFlight?.abort();
    void serialize(async () => { await ready; await end('page_hide'); if (!revoked) state = 'stopped'; }).catch(failure);
  };
  const pageshow = () => {
    if (!hidden || stopped || revoked) return;
    hidden = false;
    void serialize(async () => { await ready; await begin(); }).then(flush).catch(failure);
  };
  function unlisten() { if (!listening) return; listening = false; window.removeEventListener('online', online); window.removeEventListener('pagehide', pagehide); window.removeEventListener('pageshow', pageshow); }
  const ready: Promise<ReleaseHealthDiagnostics> = (async () => {
    if (!enabled && !explicitlyDisabled) return snapshot();
    let opened: ReleaseHealthJournal;
    try { opened = await openJournal(enabled); }
    catch (reason) {
      // Opting out never creates storage just to erase it; no journal means nothing is queued.
      if (!(reason instanceof HealthJournalError && reason.code === 'missing')) throw reason;
      return snapshot();
    }
    await purgePending();
    if (revoked) { state = 'disabled'; return snapshot(); }
    if (stopped) { state = 'stopped'; return snapshot(); }
    const activated = await opened.activate(route); generation = activated.generation; losses = activated.losses;
    await begin();
    if (!stopped && !revoked) {
      listening = true;
      window.addEventListener('online', online); window.addEventListener('pagehide', pagehide); window.addEventListener('pageshow', pageshow);
    }
    return snapshot(exposure ? 1 : 0);
  })().catch(reason => { failure(reason); return snapshot(); });
  // Startup drain is independent of replay/vitals/config transport readiness.
  void ready.then(flush);
  return {
    ready, diagnostics, flush,
    stop() {
      if (stopped) return tail.then(() => undefined);
      stopped = true; inFlight?.abort(); unlisten();
      return serialize(async () => { await ready; await end('sdk_stop'); if (!revoked) state = 'stopped'; }).catch(failure);
    },
    revoke() {
      pendingRevocations.set(routeIdentity, Symbol());
      revoked = true; stopped = true; state = 'disabled'; inFlight?.abort(); unlisten();
      return serialize(async () => {
        await ready;
        // A default-off instance still owns explicit consent withdrawal for
        // this route, including durable rows left by an earlier opted-in mount.
        if (!journal) await openJournal();
        await purgePending(); exposure = null;
      }).catch(failure);
    },
  };
}

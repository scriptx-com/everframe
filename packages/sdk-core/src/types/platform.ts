// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { FocusedNode } from '@everframe/protocol';
import type { ThreadClient } from '../reporter/thread-client.js';
import type { CaptureExceptionOptions } from '../crash/options.js';

// Capture-time inputs from the platform.
export interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: number;
  args?: unknown[];
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  startedAt: number;
  headers?: Record<string, string>;
}

export interface DeviceMetadata {
  os: string;
  osVersion: string;
  model?: string;
  screenSize: { width: number; height: number };
  pixelRatio: number;
  locale: string;
  timezone: string;
  network?: string;
  /**
   * Raw User-Agent string from `navigator.userAgent`. Surfaced to triagers so
   * they can disambiguate things our OS/version parser doesn't capture
   * (browser engine + version, in-app webviews, bot signatures, accessibility
   * UA overrides). Web SDK only — native SDKs leave this undefined.
   */
  userAgent?: string;
}

export interface ReportDraft {
  title: string;
  description: string;
  excludedArtifacts: string[]; // e.g. ['logs', 'network']
  annotations: unknown[];
  redactions: unknown[];
  /** Host-supplied free-form metadata (from `setExtra`). Opaque string, ≤2000 chars. */
  extra?: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotResult {
  blob: Blob;
  width: number;
  height: number;
  sha256: string; // hex
}

// OutboxAdapter — full impl in Plan 01-04. Stub the contract so PlatformAdapter compiles.
export interface OutboxItem {
  reportId: string;
  enqueuedAt: number;
  attempts: number;
  payload: Uint8Array;
  metadata: Record<string, string>;
}

export interface OutboxAdapter {
  enqueue(item: OutboxItem): Promise<void>;
  list(): Promise<OutboxItem[]>;
  delete(reportId: string): Promise<void>;
}

/**
 * The reporter device credential seam (two-way replies). Same shape of contract
 * as `OutboxAdapter` above and for the same reason: sdk-core is DOM-free and
 * Node-free, while both entropy and durable storage are platform concerns. The
 * interface lives here; every implementation lives in a platform package
 * (localStorage on web, Keychain on iOS, Keystore/EncryptedSharedPreferences on
 * Android).
 *
 * The CLIENT mints this token and presents it on every ingest; the server
 * stores only its peppered hash and adopts it on first sight. See
 * `reporter/device-token.ts` for why the provenance runs that way and what a
 * platform owes this interface.
 *
 * OPTIONAL, and safe to omit. A platform that does not implement it presents no
 * token, and the server falls back to minting one — the pre-existing behaviour.
 * A platform that cannot supply a real CSPRNG MUST omit it rather than supply a
 * weak `randomBytes`: this value is the sole authenticator for the device's
 * threads.
 */
export interface ReporterCredentialStore {
  /**
   * `byteLength` cryptographically random bytes. Web: `crypto.getRandomValues`.
   * Node: `node:crypto.randomFillSync`. RN: `react-native-get-random-values`.
   * Never `Math.random()`.
   */
  randomBytes(byteLength: number): Uint8Array;
  /** The persisted token, or null on a fresh install / cleared storage. */
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  /** Drop the stored token — used when the server rejects it (401). */
  clear(): Promise<void>;
}

/**
 * The core/platform seam. Web (Phase 3) and RN (Phase 4) implement this; sdk-core orchestrates.
 */
export interface PlatformAdapter {
  /** Optional platform error reporting path; uses the same delivery as automatic errors. */
  captureException?(error: unknown, options?: CaptureExceptionOptions): void;
  captureScreenshot(): Promise<ScreenshotResult>;
  captureFocusedNode(): FocusedNode | null;
  captureRecentLogs(): LogEntry[];
  captureRecentNetwork(): NetworkEntry[];
  getDeviceMetadata(): DeviceMetadata;
  registerTrigger(handler: () => void): () => void;
  showReporterUI(draft: ReportDraft): Promise<ReportDraft | null>;
  resolveSensitiveRects(): Rect[];
  applyMaskPlan(image: Blob, plan: Rect[]): Promise<Blob>;
  outbox?: OutboxAdapter;
  /**
   * Optional reporter device credential store (two-way replies). Absent =>
   * present no device token on ingest and let the server mint one, which is
   * exactly the behaviour that existed before client-side minting.
   */
  reporterCredentials?: ReporterCredentialStore;
  /**
   * Thread client wired by the platform layer (two-way replies). Absent ⇒
   * `tx.threads` is inert (empty lists, zero unread count, no-op mutators).
   */
  threads?: ThreadClient;
  /**
   * Optional session-replay seam (REPLAY-02). Additive + optional so every native
   * phase (21–25) reuses the SAME contract; sdk-core owns the lifecycle state
   * machine and config policy, while the platform package owns the actual
   * recorder (DOM serializer on web, view-tree on native). sdk-core stays
   * DOM-free — it only ever calls these methods, never imports a recorder.
   *
   * The lifecycle drives these: `start` on buffer-open, `freeze` synchronously at
   * the top of the reporter open (before any reporter UI mounts), `takeFrozen` on
   * submit, `discardAndResume` on cancel, `stop` on teardown.
   */
  replay?: {
    /** Begin the rolling buffer for the last `durationSec`. No-op if replay is not enabled. */
    start(durationSec: number): void;
    /** Stop appending and snapshot the window (capture freezeTs first). */
    freeze(): void;
    /** Zeroize the buffer and resume from a clean state. */
    discardAndResume(): void;
    /** Serialize + scrub + compress the frozen window to bytes, or null if nothing/severed. */
    takeFrozen(): Promise<ReplayCapture | null>;
    /** Tear down the recorder entirely. */
    stop(): void;
  };
  /**
   * Optional kill notification (round-4 review Finding F17/F18) — called
   * synchronously by `createClient(...).kill()`, AFTER `state.killed` has
   * already flipped true and the network-body buffer's own `kill()` has run,
   * so the adapter learns about teardown even though `createClient` never
   * otherwise calls back into the adapter it was constructed with. Mirrors
   * `Everframe.kill()` calling `ReplaySession.teardown()` on iOS (7a047bdd):
   * the web adapter uses this to (a) make its own capture-gate checks
   * (`bodyCapture.enabled()`) start returning false, and (b) cancel any
   * periodic config-refresh timer it owns, so a kill() mid-flight can never
   * be followed by a stale re-arm. Optional — a platform with nothing to
   * tear down on kill (or that has no adapter-owned timers/gates at all)
   * simply omits it.
   */
  onKill?(): void;
}

/**
 * A serialized, compressed session-replay capture ready to ride as a tagged
 * attachment (`kind: 'session-replay'`) through the existing ingest pipeline.
 * `format` is the playback discriminator: web uses the value below; native
 * native producers use `everframe-vtree-v1`; protocol readers also accept the
 * persisted legacy discriminator.
 */
export interface ReplayCapture {
  format: 'rrweb';
  bytes: Uint8Array;
  durationMs: number;
  contentType: string;
}

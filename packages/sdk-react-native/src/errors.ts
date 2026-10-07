// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { captureJsBundleMetadata, type JsBundleConfig } from './js-bundle.js';
import NativeEverframe from './NativeEverframe.js';
import { extractFacts, renderLabel } from './error-facts.js';
import { normalizeCrashDetails } from '@everframe/protocol';
import { extractCrashCauseChain, redactStringContent, type CaptureExceptionOptions } from '@everframe/sdk-core';
import { captureKey, rejectionKey, type CaptureIdentity, type PreparedRejection, type RejectionOutcome } from './rejection-capture.js';

type ErrorHandlerCallback = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler: () => ErrorHandlerCallback;
  setGlobalHandler: (cb: ErrorHandlerCallback) => void;
}
// Shared across controllers: a host lookup can reentrantly install a new one.
const handlerInstallations = new WeakMap<ErrorUtilsLike, object>();
// Resolve the intrinsic before host values can run during capture. Reading a
// bridge function's mutable `.call` after the final ownership guard could
// otherwise dispose/remount the owner and still invoke its stale payload.
const applyFunction = Reflect.apply;
export interface InstallErrorHandlerOptions {
  jsBundle?: JsBundleConfig | undefined;
  /** Test seam. Defaults to the global ErrorUtils. */
  errorUtils?: ErrorUtilsLike;
  /** Runtime mount ownership, checked by automatic and explicit paths. */
  isActive?: () => boolean;
}
export interface CaptureController {
  captureException(error: unknown, options?: CaptureExceptionOptions): void;
  prepareRejection(reason: unknown, occurredAt: string): PreparedRejection | undefined;
  submitRejection(snapshot: PreparedRejection): RejectionOutcome;
  dispose(): void;
}

/** One mounted lifetime, independent allowances, weak first-accepted identity. */
export function createCaptureController(opts: InstallErrorHandlerOptions): CaptureController {
  const jsBundle = captureJsBundleMetadata(opts.jsBundle);
  const handledKeys = new Set<string>();
  const automaticKeys = new Set<string>();
  const identities = new WeakMap<object, CaptureIdentity>();
  const prepared = new WeakSet<PreparedRejection>();
  let active = true;
  let capturing = false;
  let restore: (() => void) | undefined;
  const ownsCapture = () => active && (opts.isActive?.() ?? true);

  function identityFor(error: unknown): CaptureIdentity | undefined {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
    let identity = identities.get(error);
    if (!identity) { identity = { accepted: false }; identities.set(error, identity); }
    return identity;
  }

  function prepareRejection(reason: unknown, occurredAt: string): PreparedRejection | undefined {
    if (!ownsCapture() || capturing) return undefined;
    capturing = true;
    try {
      const identity = identityFor(reason);
      // Rejected non-Error values are often responses or request configs:
      // report their type, never their headers, cookies, URLs or cause.
      let labelled = false;
      const facts = extractFacts(reason, (value) => { labelled = true; return renderLabel(value); });
      if (!ownsCapture()) return undefined;
      const causeChain = labelled
        ? undefined
        : extractCrashCauseChain(reason, (value) => redactStringContent(value, {}), ownsCapture);
      if (!ownsCapture()) return undefined;
      const payload = JSON.stringify({
        ...facts,
        ...(jsBundle ? { jsBundle } : {}),
        ...(causeChain ? { causeChain } : {}),
        source: 'error', mechanism: 'unhandledrejection', handled: false, fatal: false, occurredAt,
      });
      if (!ownsCapture()) return undefined;
      const snapshot: PreparedRejection = { payload, key: rejectionKey(facts), ...(identity ? { identity } : {}) };
      prepared.add(snapshot);
      return snapshot;
    } catch { return undefined; }
    finally { capturing = false; }
  }

  function submitRejection(snapshot: PreparedRejection): RejectionOutcome {
    if (!ownsCapture() || !prepared.has(snapshot)) return 'inactive';
    if (capturing) return 'capture-failed';
    capturing = true;
    try {
      if (snapshot.identity?.accepted || automaticKeys.has(snapshot.key)) return 'duplicate';
      if (automaticKeys.size >= 10) return 'allowance';
      // The new path requires the current acceptance-capable bridge. Existing
      // ErrorUtils callers alone retain old-binary attempt accounting below.
      const handledMethod = NativeEverframe.captureHandledException;
      const method = NativeEverframe.reportCrash;
      if (!ownsCapture()) return 'inactive';
      if (typeof handledMethod !== 'function' || typeof method !== 'function') return 'native-refused';
      if (applyFunction(method, NativeEverframe, [snapshot.payload]) !== true) return 'native-refused';
      automaticKeys.add(snapshot.key);
      if (snapshot.identity) snapshot.identity.accepted = true;
      return 'accepted';
    } catch { return 'capture-failed'; }
    finally { capturing = false; }
  }

  function capture(
    error: unknown,
    explicit: boolean,
    fatal: boolean,
    options?: CaptureExceptionOptions,
  ): void {
    if (!ownsCapture() || capturing) return;
    capturing = true;
    try {
      // Older native binaries may omit the distinct method or throw on lookup.
      let handledMethod: typeof NativeEverframe.captureHandledException | undefined;
      try {
        const method = NativeEverframe.captureHandledException;
        if (typeof method === 'function') handledMethod = method;
      } catch { /* automatic capture keeps its legacy path */ }
      if (explicit && !handledMethod) return;
      const identity = identityFor(error);
      if (!fatal && handledMethod && identity?.accepted) return;
      const facts = extractFacts(error);
      const keys = explicit ? handledKeys : automaticKeys;
      const key = captureKey(facts);
      if (!fatal && (keys.size >= 10 || keys.has(key))) return;
      const details = explicit
        ? normalizeCrashDetails(options, (value) => redactStringContent(value, {}), 'error')
        : undefined;
      const causeChain = extractCrashCauseChain(error, (value) => redactStringContent(value, {}), ownsCapture);
      if (!ownsCapture()) return;
      const payload = JSON.stringify({
        ...facts,
        ...(jsBundle ? { jsBundle } : {}),
        ...(details ? { details } : {}),
        ...(causeChain ? { causeChain } : {}),
        source: fatal ? 'crash' : 'error',
        mechanism: explicit ? 'captureException' : 'errorutils',
        handled: explicit,
        fatal,
        occurredAt: new Date().toISOString(),
      });
      if (!ownsCapture()) return;
      const legacyAttempt = !explicit && !handledMethod;
      // Preserve old-binary attempt accounting, including a failed lookup.
      if (!fatal && legacyAttempt) keys.add(key);
      const method = explicit ? handledMethod : NativeEverframe.reportCrash;
      // Bridge property reads may themselves reenter teardown.
      if (typeof method !== 'function' || !ownsCapture()) return;
      const accepted = applyFunction(method, NativeEverframe, [payload]) === true;
      if (!fatal && !legacyAttempt && accepted) {
        keys.add(key);
        if (identity) identity.accepted = true;
      }
    } catch {
      // Neither hostile thrown values nor a failed bridge may escape capture.
    } finally {
      capturing = false;
    }
  }

  try {
    const eu = opts.errorUtils ?? (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    if (eu) {
      const previous = eu.getGlobalHandler();
      // Host lookup can unmount this owner and install its successor before
      // returning. A stale controller must not publish or restore a handler.
      if (ownsCapture()) {
        const handler: ErrorHandlerCallback = (...args) => {
          capture(args[0], false, args[1] === true);
          // Inactive retained wrappers still chain the exact original arguments.
          previous?.(...args);
        };
        restore = () => {
          const installation = handlerInstallations.get(eu);
          const current = eu.getGlobalHandler();
          // The lookup may return a cached old wrapper after mounting a new
          // controller. Equality alone would disconnect that new controller.
          if (current === handler && handlerInstallations.get(eu) === installation) {
            eu.setGlobalHandler(previous);
          }
        };
        handlerInstallations.set(eu, {});
        eu.setGlobalHandler(handler);
      }
    }
  } catch {
    console.warn('[everframe] crash handler install threw');
  }
  return {
    prepareRejection,
    submitRejection,
    captureException(error, options) { capture(error, true, false, options); },
    dispose() {
      if (!active) return;
      active = false;
      try { restore?.(); } catch { console.warn('[everframe] crash handler teardown threw'); }
    },
  };
}

/** Adapter for internal consumers; mounted runtimes own the shared controller. */
export function installErrorHandler(opts: InstallErrorHandlerOptions): () => void {
  return createCaptureController(opts).dispose;
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { captureJsBundleMetadata, type JsBundleConfig } from './js-bundle.js';
import NativeTraceItX from './NativeTraceItX.js';
import { extractFacts } from './error-facts.js';
import { normalizeCrashDetails } from '@traceitx/protocol';
import { redactStringContent, type CaptureExceptionOptions } from '@traceitx/sdk-core';

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
  dispose(): void;
}

/** One mounted lifetime, independent allowances, weak first-accepted identity. */
export function createCaptureController(opts: InstallErrorHandlerOptions): CaptureController {
  const jsBundle = captureJsBundleMetadata(opts.jsBundle);
  const handledKeys = new Set<string>();
  const automaticKeys = new Set<string>();
  const acceptedObjects = new WeakSet<object>();
  let active = true;
  let capturing = false;
  let restore: (() => void) | undefined;
  const ownsCapture = () => active && (opts.isActive?.() ?? true);

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
      let handledMethod: typeof NativeTraceItX.captureHandledException | undefined;
      try {
        const method = NativeTraceItX.captureHandledException;
        if (typeof method === 'function') handledMethod = method;
      } catch { /* automatic capture keeps its legacy path */ }
      if (explicit && !handledMethod) return;
      const identity = (typeof error === 'object' && error !== null) || typeof error === 'function'
        ? error as object : undefined;
      if (!fatal && handledMethod && identity && acceptedObjects.has(identity)) return;
      const facts = extractFacts(error);
      const keys = explicit ? handledKeys : automaticKeys;
      const key = `${facts.exceptionType}:${(facts.framesRaw[0] ?? '').replace(/\d+/g, '#')}`;
      if (!fatal && (keys.size >= 10 || keys.has(key))) return;
      const details = explicit
        ? normalizeCrashDetails(options, (value) => redactStringContent(value, {}), 'error')
        : undefined;
      const payload = JSON.stringify({
        ...facts,
        ...(jsBundle ? { jsBundle } : {}),
        ...(details ? { details } : {}),
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
      const method = explicit ? handledMethod : NativeTraceItX.reportCrash;
      // Bridge property reads may themselves reenter teardown.
      if (typeof method !== 'function' || !ownsCapture()) return;
      const accepted = applyFunction(method, NativeTraceItX, [payload]) === true;
      if (!fatal && !legacyAttempt && accepted) {
        keys.add(key);
        if (identity) acceptedObjects.add(identity);
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
    console.warn('[traceitx] crash handler install threw');
  }
  return {
    captureException(error, options) { capture(error, true, false, options); },
    dispose() {
      if (!active) return;
      active = false;
      try { restore?.(); } catch { console.warn('[traceitx] crash handler teardown threw'); }
    },
  };
}

/** Adapter for internal consumers; mounted runtimes own the shared controller. */
export function installErrorHandler(opts: InstallErrorHandlerOptions): () => void {
  return createCaptureController(opts).dispose;
}

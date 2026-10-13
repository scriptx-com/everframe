// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { captureJsBundleMetadata, type JsBundleConfig } from './js-bundle.js';
import NativeEverframe from './NativeEverframe.js';
import { extractFacts, renderLabel } from './error-facts.js';
import { normalizeCrashDetails } from '@everframe/protocol';
import {
  extractCrashCauseChain,
  redactStringContent,
  type CaptureExceptionOptions,
} from '@everframe/sdk-core';
import {
  captureKey,
  exceedsValueShare,
  rejectionKey,
  type CaptureIdentity,
  type PreparedRejection,
  type RejectionOutcome,
} from './rejection-capture.js';

import {
  createErrorCaptureLedger,
  emptyErrorCaptureStatus,
  type ErrorCaptureStatus,
  type ErrorCaptureOutcome,
} from './error-capture-status.js';
import { reactNativeExceptionsManager, type ExceptionsManagerLike } from './exceptions-manager.js';

type ErrorHandlerCallback = (error: unknown, isFatal?: boolean) => void;
interface ErrorUtilsLike {
  getGlobalHandler: () => ErrorHandlerCallback;
  setGlobalHandler: (cb: ErrorHandlerCallback) => void;
}
// Shared across controllers: a host lookup can reentrantly install a new one.
const handlerInstallations = new WeakMap<ErrorUtilsLike, object>();
const exceptionsManagerInstallations = new WeakMap<ExceptionsManagerLike, object>();
// Resolve the intrinsic before host values can run during capture. Reading a
// bridge function's mutable `.call` after the final ownership guard could
// otherwise dispose/remount the owner and still invoke its stale payload.
const applyFunction = Reflect.apply;
// React Native's own title separator, so the report reads like RN's and the
// native layer can recognise RN's fatal wrapper of the same error.
const COMPONENT_STACK_PREFIX = '\n\nThis error is located at:';
const MAX_MESSAGE = 4096;
export interface InstallErrorHandlerOptions {
  jsBundle?: JsBundleConfig | undefined;
  /** Test seam. Defaults to the global ErrorUtils. */
  errorUtils?: ErrorUtilsLike;
  /** Test seam. Defaults to React Native's ExceptionsManager; null disables the hook. */
  exceptionsManager?: ExceptionsManagerLike | null;
  /** Runtime mount ownership, checked by automatic and explicit paths. */
  isActive?: () => boolean;
  /**
   * True while no runtime owns capture. React reports an uncaught render error
   * in the same commit that already unmounted the provider, so a disposed
   * controller still takes that one fatal unless a newer owner exists.
   */
  isUnowned?: () => boolean;
}
export interface CaptureController {
  getErrorCaptureStatus(): ErrorCaptureStatus;
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
  const ledger = createErrorCaptureLedger();
  const prepared = new WeakSet<PreparedRejection>();
  let active = true;
  let draining = false;
  let capturing = false;
  // Fatals the ErrorUtils wrapper already offered to capture. RN's ErrorUtils
  // handler forwards them to ExceptionsManager, synchronously or later.
  let offering = 0;
  const offered = new WeakSet<object>();
  let restore: (() => void) | undefined;
  let restoreExceptionsManager: (() => void) | undefined;
  const ownsCapture = () => active && (opts.isActive?.() ?? true);
  const ownsFatalTail = () => draining && (opts.isUnowned?.() ?? false);

  function identityFor(error: unknown): CaptureIdentity | undefined {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function')
      return undefined;
    let identity = identities.get(error);
    if (!identity) {
      identity = { accepted: false };
      identities.set(error, identity);
    }
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
      const facts = extractFacts(reason, (value) => {
        labelled = true;
        return renderLabel(value);
      });
      if (!ownsCapture()) return undefined;
      const causeChain = labelled
        ? undefined
        : extractCrashCauseChain(reason, (value) => redactStringContent(value, {}), ownsCapture);
      if (!ownsCapture()) return undefined;
      const payload = JSON.stringify({
        ...facts,
        ...(jsBundle ? { jsBundle } : {}),
        ...(causeChain ? { causeChain } : {}),
        source: 'error',
        mechanism: 'unhandledrejection',
        handled: false,
        fatal: false,
        occurredAt,
      });
      if (!ownsCapture()) return undefined;
      const snapshot: PreparedRejection = {
        payload,
        key: rejectionKey(facts),
        ...(identity ? { identity } : {}),
      };
      prepared.add(snapshot);
      return snapshot;
    } catch {
      return undefined;
    } finally {
      capturing = false;
    }
  }

  function submitRejection(snapshot: PreparedRejection): RejectionOutcome {
    if (!ownsCapture() || !prepared.has(snapshot)) return 'inactive';
    const finish = ledger.begin('rejection');
    if (capturing) {
      finish('reentrantSuppressed');
      return 'capture-failed';
    }
    capturing = true;
    let outcome: ErrorCaptureOutcome = 'captureFailed';
    try {
      if (snapshot.identity?.accepted || automaticKeys.has(snapshot.key)) {
        outcome = 'duplicateSuppressed';
        return 'duplicate';
      }
      if (automaticKeys.size >= 10 || exceedsValueShare(automaticKeys, snapshot.key)) {
        outcome = 'allowanceSuppressed';
        return 'allowance';
      }
      const method = NativeEverframe.reportCrash;
      if (!ownsCapture()) {
        outcome = 'inactiveAborted';
        return 'inactive';
      }
      if (typeof method !== 'function') {
        outcome = 'bridgeUnavailable';
        return 'native-refused';
      }
      if (applyFunction(method, NativeEverframe, [snapshot.payload]) !== true) {
        outcome = 'nativeRefused';
        return 'native-refused';
      }
      automaticKeys.add(snapshot.key);
      if (snapshot.identity) snapshot.identity.accepted = true;
      outcome = 'accepted';
      return 'accepted';
    } catch {
      return 'capture-failed';
    } finally {
      capturing = false;
      finish(outcome);
    }
  }

  function capture(
    error: unknown,
    explicit: boolean,
    fatal: boolean,
    options?: CaptureExceptionOptions,
    componentStack?: string,
    owns: () => boolean = ownsCapture,
  ): void {
    if (!owns()) return;
    const finish = ledger.begin(explicit ? 'handled' : 'errorUtils');
    if (capturing) {
      finish('reentrantSuppressed');
      return;
    }
    capturing = true;
    let outcome: ErrorCaptureOutcome = 'captureFailed';
    try {
      const method = explicit
        ? NativeEverframe.captureHandledException
        : NativeEverframe.reportCrash;
      // Bridge property reads may themselves reenter teardown.
      if (!owns()) {
        outcome = 'inactiveAborted';
        return;
      }
      if (typeof method !== 'function') {
        outcome = 'bridgeUnavailable';
        return;
      }
      const identity = identityFor(error);
      if (!fatal && identity?.accepted) {
        outcome = 'duplicateSuppressed';
        return;
      }
      const facts = extractFacts(error);
      // Exactly how RN titles a component error, so the native layer can match
      // RN's fatal wrapper and the dashboard can fold the component stack.
      if (componentStack !== undefined) {
        facts.message = `${facts.message}${COMPONENT_STACK_PREFIX}${componentStack}`.slice(
          0,
          MAX_MESSAGE,
        );
      }
      const keys = explicit ? handledKeys : automaticKeys;
      const key = captureKey(facts);
      if (!owns()) {
        outcome = 'inactiveAborted';
        return;
      }
      if (!fatal && keys.has(key)) {
        outcome = 'duplicateSuppressed';
        return;
      }
      if (!fatal && keys.size >= 10) {
        outcome = 'allowanceSuppressed';
        return;
      }
      const details = explicit
        ? normalizeCrashDetails(options, (value) => redactStringContent(value, {}), 'error')
        : undefined;
      const causeChain = extractCrashCauseChain(
        error,
        (value) => redactStringContent(value, {}),
        owns,
      );
      if (!owns()) {
        outcome = 'inactiveAborted';
        return;
      }
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
      if (!owns()) {
        outcome = 'inactiveAborted';
        return;
      }
      const accepted = applyFunction(method, NativeEverframe, [payload]) === true;
      outcome = accepted ? 'accepted' : 'nativeRefused';
      if (!fatal && accepted) {
        keys.add(key);
        if (identity) identity.accepted = true;
      }
    } catch {
      // Neither hostile thrown values nor a failed bridge may escape capture.
    } finally {
      capturing = false;
      finish(outcome);
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
          const owned = ownsCapture();
          capture(args[0], false, args[1] === true);
          if (!owned) {
            // Inactive retained wrappers still chain the exact original arguments.
            previous?.(...args);
            return;
          }
          // RN's own handler forwards to ExceptionsManager; that hook must not
          // report this fatal a second time.
          if (args[1] === true) markOffered(args[0]);
          offering++;
          try {
            previous?.(...args);
          } finally {
            offering--;
          }
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
  try {
    // React 19 reports an error no boundary caught through the root's
    // onUncaughtError, which calls ExceptionsManager.handleException(error,
    // true) and never the ErrorUtils handler above.
    const em =
      opts.exceptionsManager === undefined
        ? reactNativeExceptionsManager()
        : (opts.exceptionsManager ?? undefined);
    const original = em?.handleException;
    if (em && typeof original === 'function' && ownsCapture()) {
      const ownsUncaught = () => ownsCapture() || ownsFatalTail();
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const error = args[0];
        if (args[1] === true && offering === 0 && !wasOffered(error) && ownsUncaught()) {
          capture(error, false, true, undefined, componentStackOf(error), ownsUncaught);
        }
        return applyFunction(original, this, args);
      };
      const installation = {};
      restoreExceptionsManager = () => {
        if (
          em.handleException === wrapped &&
          exceptionsManagerInstallations.get(em) === installation
        ) {
          em.handleException = original;
        }
      };
      exceptionsManagerInstallations.set(em, installation);
      em.handleException = wrapped;
    }
  } catch {
    console.warn('[everframe] React error hook install threw');
  }

  function markOffered(error: unknown): void {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function')
      offered.add(error);
  }
  function wasOffered(error: unknown): boolean {
    return (
      ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
      offered.has(error)
    );
  }

  return {
    getErrorCaptureStatus() {
      return { ...emptyErrorCaptureStatus('active', 'none'), counters: ledger.snapshot() };
    },
    prepareRejection,
    submitRejection,
    captureException(error, options) {
      capture(error, true, false, options);
    },
    dispose() {
      if (!active) return;
      active = false;
      try {
        restore?.();
      } catch {
        console.warn('[everframe] crash handler teardown threw');
      }
      if (!restoreExceptionsManager) return;
      // The provider's cleanup runs in React's mutation phase; the uncaught
      // error that caused it is reported later in the same commit. Keep the
      // hook until the current task ends.
      draining = true;
      const finishDrain = () => {
        draining = false;
        try {
          restoreExceptionsManager?.();
        } catch {
          console.warn('[everframe] React error hook teardown threw');
        }
      };
      try {
        setTimeout(finishDrain, 0);
      } catch {
        finishDrain();
      }
    },
  };
}

/** React Native's root error handlers copy React's component stack onto the error. */
function componentStackOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'componentStack');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value.slice(0, MAX_MESSAGE)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Adapter for internal consumers; mounted runtimes own the shared controller. */
export function installErrorHandler(opts: InstallErrorHandlerOptions): () => void {
  return createCaptureController(opts).dispose;
}

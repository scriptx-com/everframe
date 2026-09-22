// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  MAX_CRASH_CAUSES,
  MAX_CRASH_CAUSE_STACK_SCAN_UNITS,
  createCrashCauseChainFitter,
  type CrashCauseChain,
  type CrashCauseChainFitter,
} from '@traceitx/protocol';

type OwnDataRead =
  | { kind: 'data'; value: unknown }
  | { kind: 'absent' }
  | { kind: 'lost' }
  | { kind: 'cancelled' };

type StackResult = 'continue' | 'stop';

type StackRead =
  | { kind: 'data'; value: string }
  | { kind: 'native'; getter: (this: unknown) => unknown }
  | { kind: 'absent' }
  | { kind: 'lost' }
  | { kind: 'cancelled' };

const numberToString = Number.prototype.toString;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const reflectApply = Reflect.apply;
const AmbientError = Error;

function captureNativeStackGetter(): ((this: unknown) => unknown) | undefined {
  try {
    const probe = new AmbientError();
    const descriptor = objectGetOwnPropertyDescriptor(probe, 'stack');
    return descriptor && !('value' in descriptor) && typeof descriptor.get === 'function'
      ? descriptor.get
      : undefined;
  } catch {
    return undefined;
  }
}

const nativeStackGetter = captureNativeStackGetter();

function safeOwned(stillOwned: () => boolean): boolean {
  try {
    return stillOwned();
  } catch {
    return false;
  }
}

function isIdentity(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function ownData(value: object, key: PropertyKey, stillOwned: () => boolean): OwnDataRead {
  if (!safeOwned(stillOwned)) return { kind: 'cancelled' };
  try {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!safeOwned(stillOwned)) return { kind: 'cancelled' };
    if (!descriptor) return { kind: 'absent' };
    if (!('value' in descriptor)) return { kind: 'lost' };
    return { kind: 'data', value: descriptor.value };
  } catch {
    return safeOwned(stillOwned) ? { kind: 'lost' } : { kind: 'cancelled' };
  }
}

function ownStack(value: object, stillOwned: () => boolean): StackRead {
  if (!safeOwned(stillOwned)) return { kind: 'cancelled' };
  try {
    const descriptor = objectGetOwnPropertyDescriptor(value, 'stack');
    if (!safeOwned(stillOwned)) return { kind: 'cancelled' };
    if (!descriptor) return { kind: 'absent' };
    if ('value' in descriptor) {
      return typeof descriptor.value === 'string'
        ? { kind: 'data', value: descriptor.value }
        : { kind: 'lost' };
    }
    return nativeStackGetter !== undefined && descriptor.get === nativeStackGetter
      ? { kind: 'native', getter: nativeStackGetter }
      : { kind: 'lost' };
  } catch {
    return safeOwned(stillOwned) ? { kind: 'lost' } : { kind: 'cancelled' };
  }
}

function safePrototype(value: object, stillOwned: () => boolean): object | null | undefined {
  if (!safeOwned(stillOwned)) return undefined;
  try {
    const prototype = objectGetPrototypeOf(value) as object | null;
    if (!safeOwned(stillOwned)) return undefined;
    return prototype;
  } catch {
    return undefined;
  }
}

function readType(
  value: object,
  stillOwned: () => boolean,
): { type: string; lost: boolean; cancelled: boolean } {
  let current: object | null = value;
  const seen = new Set<object>();
  let links = 0;
  let lost = false;
  while (current !== null) {
    if (seen.has(current)) return { type: 'Error', lost: true, cancelled: false };
    seen.add(current);
    const name = ownData(current, 'name', stillOwned);
    if (name.kind === 'cancelled') return { type: 'Error', lost, cancelled: true };
    if (name.kind === 'lost') lost = true;
    if (name.kind === 'data') {
      if (typeof name.value === 'string') {
        return { type: name.value.length > 0 ? name.value : 'Error', lost, cancelled: false };
      }
      lost = true;
    }
    if (links >= 4) break;
    const prototype = safePrototype(current, stillOwned);
    if (prototype === undefined) {
      return { type: 'Error', lost: safeOwned(stillOwned) ? true : lost, cancelled: !safeOwned(stillOwned) };
    }
    current = prototype;
    links += 1;
  }
  return { type: 'Error', lost, cancelled: false };
}

function feedStack(
  stack: string,
  exceptionType: string,
  fitter: CrashCauseChainFitter,
): StackResult {
  const scanEnd = Math.min(stack.length, MAX_CRASH_CAUSE_STACK_SCAN_UNITS);
  let cursor = 0;
  let sawFirstNonempty = false;
  let frameLines = 0;

  while (cursor < scanEnd) {
    let lineEnd = cursor;
    while (lineEnd < scanEnd && stack.charCodeAt(lineEnd) !== 10) lineEnd += 1;
    const line = stack.slice(cursor, lineEnd).trim();
    cursor = lineEnd < scanEnd ? lineEnd + 1 : scanEnd;
    if (line.length === 0) continue;

    if (!sawFirstNonempty) {
      sawFirstNonempty = true;
      if (line === exceptionType || line.startsWith(`${exceptionType}:`)) continue;
    }

    frameLines += 1;
    const appended = fitter.appendFrame({ raw: line });
    if (appended === 'exhausted' || appended === 'discarded') return 'stop';
    if (appended === 'frames_full') return 'continue';
    if (frameLines >= 33) {
      fitter.markFramesTruncated();
      return 'continue';
    }
  }

  if (stack.length > scanEnd) fitter.markFramesTruncated();
  return 'continue';
}

function terminalHeader(value: unknown): { message: string; lossy: boolean } {
  if (value === null) return { message: 'null', lossy: false };
  switch (typeof value) {
    case 'undefined': return { message: 'undefined', lossy: false };
    case 'string': return { message: value, lossy: false };
    case 'boolean': return { message: value ? 'true' : 'false', lossy: false };
    case 'number': return { message: numberToString.call(value), lossy: false };
    case 'bigint': return { message: '[bigint]', lossy: true };
    case 'symbol': return { message: '[symbol]', lossy: true };
    case 'function': return { message: '[function]', lossy: true };
    default: return { message: '[object]', lossy: true };
  }
}

/**
 * Observe only an Error-like root's own `cause` data-property and return an
 * owned, fitted snapshot. Host access is bounded and every callback boundary
 * rechecks the capture generation supplied by the caller.
 */
export function extractCrashCauseChain(
  error: unknown,
  redact: (value: string) => string,
  stillOwned: () => boolean,
): CrashCauseChain | undefined {
  if (!isIdentity(error) || !safeOwned(stillOwned)) return undefined;
  const fitter = createCrashCauseChainFitter(redact, stillOwned);

  try {
    const rootCause = ownData(error, 'cause', stillOwned);
    if (rootCause.kind === 'cancelled') return fitter.finish();
    if (rootCause.kind === 'absent') return undefined;
    if (rootCause.kind === 'lost') {
      fitter.markChainTruncated();
      return fitter.finish();
    }

    const visited = new Set<object>();
    visited.add(error);
    let current: unknown = rootCause.value;
    let acceptedCauses = 0;

    while (true) {
      if (!safeOwned(stillOwned)) return fitter.finish();
      if (isIdentity(current) && visited.has(current)) {
        fitter.markChainTruncated();
        return fitter.finish();
      }
      if (isIdentity(current)) visited.add(current);

      let errorLike = false;
      let headerLoss = false;
      let frameLoss = false;
      let message = '';
      let stack: string | undefined;
      let stackGetter: ((this: unknown) => unknown) | undefined;
      let exceptionType = 'UnhandledValue';

      if (isIdentity(current)) {
        const messageRead = ownData(current, 'message', stillOwned);
        if (messageRead.kind === 'cancelled') return fitter.finish();
        const stackRead = ownStack(current, stillOwned);
        if (stackRead.kind === 'cancelled') return fitter.finish();
        if (messageRead.kind === 'data' && typeof messageRead.value === 'string') {
          message = messageRead.value;
          errorLike = true;
        } else if (messageRead.kind !== 'absent') {
          headerLoss = true;
        }
        if (stackRead.kind === 'data') {
          stack = stackRead.value;
          errorLike = true;
        } else if (stackRead.kind === 'native') {
          stackGetter = stackRead.getter;
          errorLike = true;
        } else if (stackRead.kind !== 'absent') {
          frameLoss = true;
        }
        if (errorLike) {
          const type = readType(current, stillOwned);
          if (type.cancelled) return fitter.finish();
          exceptionType = type.type;
          headerLoss ||= type.lost;
        }
      }

      if (!errorLike) {
        const terminal = terminalHeader(current);
        const began = fitter.beginCause({
          exceptionType: 'UnhandledValue',
          message: terminal.message,
          framesTruncated: false,
        });
        if (began === 'accepted' && (terminal.lossy || headerLoss || frameLoss)) {
          fitter.markChainTruncated();
        }
        return fitter.finish();
      }

      const began = fitter.beginCause({ exceptionType, message, framesTruncated: frameLoss });
      if (began === 'exhausted' || began === 'discarded') return fitter.finish();
      if (headerLoss) fitter.markChainTruncated();
      acceptedCauses += 1;
      if (stackGetter !== undefined) {
        if (!safeOwned(stillOwned)) return fitter.finish();
        let materialized: unknown;
        let materializationFailed = false;
        try {
          materialized = reflectApply(stackGetter, current, []);
        } catch {
          materializationFailed = true;
        }
        if (!safeOwned(stillOwned)) return fitter.finish();
        if (!materializationFailed && typeof materialized === 'string') {
          stack = materialized;
        } else {
          fitter.markFramesTruncated();
        }
      }
      if (stack !== undefined && feedStack(stack, exceptionType, fitter) === 'stop') {
        return fitter.finish();
      }

      // `errorLike` can only become true inside the identity branch above.
      const next = ownData(current as object, 'cause', stillOwned);
      if (next.kind === 'cancelled') return fitter.finish();
      if (next.kind === 'absent') return fitter.finish();
      if (next.kind === 'lost') {
        fitter.markChainTruncated();
        return fitter.finish();
      }
      if (acceptedCauses >= MAX_CRASH_CAUSES) {
        fitter.markChainTruncated();
        return fitter.finish();
      }
      current = next.value;
    }
  } catch {
    return undefined;
  }
}

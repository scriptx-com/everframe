// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { Platform } from 'react-native';
import type { RejectionReason } from './promise-rejection-types.js';

interface HermesInspector {
  hasPromise(): boolean;
  getRuntimeProperties(): Record<string, unknown>;
  getFunctionLocation(fn: Function): Record<string, unknown>;
}
/** Internal environment seam; not exported through the package's public API. */
export interface AdapterEnvironment {
  promise: unknown;
  platform: unknown;
  isTV: unknown;
  rnVersion: unknown;
  hermes?: HermesInspector | undefined;
  functionSource(fn: Function): string;
  currentPromise?: () => unknown;
}
export interface AdapterOptions {
  onReject(promise: object, reason: unknown): void;
  onHandle(promise: object): void;
  isActive(): boolean;
  environment?: AdapterEnvironment;
}
export type AdapterResult =
  | { status: 'unsupported' | 'install-failed'; reason: RejectionReason }
  | { status: 'observing'; adapterId: string; previousCallbacksPresent: boolean;
      ownsHooks(): boolean; dispose(): void };

const installations = new WeakMap<Function, object>();
const apply = Reflect.apply;
const sourceOf = Function.prototype.toString;
function defaultEnvironment(): AdapterEnvironment {
  return {
    promise: globalThis.Promise, currentPromise: () => globalThis.Promise,
    platform: Platform.OS, isTV: Platform.isTV,
    rnVersion: Platform.constants?.reactNativeVersion,
    hermes: (globalThis as { HermesInternal?: HermesInspector }).HermesInternal,
    functionSource: (fn) => apply(sourceOf, fn, []) as string,
  };
}
function data(object: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && 'value' in descriptor ? descriptor : undefined;
}
function objectValue(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Candidate row: installed Android/iOS qualification is required before release. */
export function installHermesRejectionAdapter(options: AdapterOptions): AdapterResult {
  let dispose: (() => void) | undefined;
  const unsupported = (reason: RejectionReason): AdapterResult => ({ status: 'unsupported', reason });
  try {
    const env = options.environment ?? defaultEnvironment();
    if ((env.platform !== 'android' && env.platform !== 'ios') || env.isTV !== false)
      return unsupported('platform');
    const version = env.rnVersion as Record<string, unknown> | undefined;
    const hermes = env.hermes;
    if (!version || version.major !== 0 || version.minor !== 85 || version.patch !== 3 ||
        version.prerelease !== '0' || !hermes || hermes.hasPromise() !== true) return unsupported('runtime');
    const runtime = hermes.getRuntimeProperties();
    if (runtime['OSS Release Version'] !== '250829098.0.10' || runtime['Bytecode Version'] !== 98 ||
        runtime.Build !== 'Release' || runtime['Static Hermes'] !== true) return unsupported('runtime');
    const C = env.promise;
    if (typeof C !== 'function') return unsupported('promise-identity');
    const location = hermes.getFunctionLocation(C);
    if (location.isNative !== false || location.segmentID !== 0 || location.virtualOffset !== 1330 ||
        location.fileName !== 'InternalBytecode.js' || env.functionSource(C) !== 'function Promise(a0) { [bytecode] }')
      return unsupported('promise-identity');
    const prototype = data(C, 'prototype')?.value as unknown;
    if (!objectValue(prototype)) return unsupported('promise-identity');
    const then = data(prototype, 'then')?.value as unknown;
    if (typeof then !== 'function') return unsupported('promise-identity');
    const thenLocation = hermes.getFunctionLocation(then);
    if (thenLocation.isNative !== false || thenLocation.fileName !== 'InternalBytecode.js')
      return unsupported('promise-identity');
    const previousB = data(C, '_B'), previousC = data(C, '_C');
    const valid = (d: PropertyDescriptor | undefined): d is PropertyDescriptor => !!d && d.writable === true &&
      (d.value === null || typeof d.value === 'function');
    if (!valid(previousB) || !valid(previousC)) return unsupported('hook-shape');
    if (!options.isActive()) return { status: 'install-failed', reason: 'hook-install' };
    const token = {}, previousToken = installations.get(C);
    let alive = true, ready = false, probe: object | undefined, observed = false;
    function ownsHooks(): boolean {
      try {
        if (!alive || !options.isActive() || installations.get(C as Function) !== token) return false;
        const current = env.currentPromise ? env.currentPromise() : env.promise;
        const b = data(C as Function, '_B'), c = data(C as Function, '_C');
        return current === C && b?.value === handle && c?.value === reject &&
          alive && options.isActive() && installations.get(C as Function) === token;
      } catch { return false; }
    }
    function handle(this: unknown, ...args: unknown[]): unknown {
      try {
        if (ownsHooks()) {
          if (args[0] === probe) observed = true;
          if (ready && objectValue(args[0])) options.onHandle(args[0]);
        }
      } catch { /* SDK observation must not escape into Promise execution. */ }
      if (typeof previousB!.value === 'function') return apply(previousB!.value, this, args);
    }
    function reject(this: unknown, ...args: unknown[]): unknown {
      try {
        if (ready && ownsHooks() && objectValue(args[0])) options.onReject(args[0], args[1]);
      } catch { /* Prior callback exceptions remain observable below. */ }
      if (typeof previousC!.value === 'function') return apply(previousC!.value, this, args);
    }
    dispose = () => {
      if (!alive) return;
      alive = false; ready = false; probe = undefined;
      for (const [key, wrapper, previous] of [['_B', handle, previousB], ['_C', reject, previousC]] as const) {
        try {
          if (installations.get(C) !== token) break;
          const current = data(C, key);
          if (current?.value === wrapper && installations.get(C) === token)
            Object.defineProperty(C, key, previous);
        } catch { /* A host can freeze its hooks; retained wrappers are inert. */ }
      }
      if (installations.get(C) === token) {
        if (previousToken) installations.set(C, previousToken);
        else installations.delete(C);
      }
    };
    installations.set(C, token);
    Object.defineProperty(C, '_B', { ...previousB, value: handle });
    if (!options.isActive() || installations.get(C) !== token) { dispose(); return { status: 'install-failed', reason: 'hook-install' }; }
    Object.defineProperty(C, '_C', { ...previousC, value: reject });
    if (!ownsHooks()) { dispose(); return { status: 'install-failed', reason: 'hook-install' }; }
    // Function location and source alone also match a renamed bound Promise.
    // A fulfilled-only continuation proves that the engine invokes THIS pair's
    // handle hook. It preserves prior observers and creates no rejection.
    probe = Reflect.construct(C, [(resolve: (value?: unknown) => void) => resolve(undefined)]);
    apply(then, probe, [() => {}]);
    probe = undefined;
    if (!observed || !ownsHooks()) { dispose(); return unsupported('promise-identity'); }
    ready = true;
    return { status: 'observing', adapterId: 'hermes-250829098.0.10-rn-0.85.3-0',
      previousCallbacksPresent: previousB.value !== null || previousC.value !== null,
      ownsHooks, dispose };
  } catch {
    dispose?.();
    return { status: 'install-failed', reason: 'hook-install' };
  }
}

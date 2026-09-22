// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared native-event-emitter accessor. Extracted from `companion.ts` (spec
// 2026-09-17 setExtra-resolver) so `runtime.ts` can reuse the SAME emitter
// for the extra-resolver ask-and-wait round trip instead of duplicating the
// per-platform module-selection logic. `companion.ts` re-exports `getEmitter`
// so existing imports elsewhere keep working unchanged.
//
// Emitter selection:
//   • iOS — `TraceItXEventEmitter` (dedicated RCTEventEmitter subclass).
//   • Android — the default RCTDeviceEventEmitter (no module ref needed).
// Constructed lazily at first listener attachment so importing a module that
// uses this doesn't require NativeEventEmitter wiring before the
// TraceItXProvider has configured the native side.
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  type EventSubscription,
} from 'react-native';

/**
 * SDK-facing listener surface. React Native 0.87 intentionally types raw
 * native payloads as `Object[]`; each TraceItX event has a narrower bridge
 * contract, so the unchecked native boundary is centralized here instead of
 * repeated at every listener.
 */
export type TraceItXNativeEventEmitter = {
  addListener<Args extends readonly unknown[]>(
    eventType: string,
    listener: (...args: Args) => unknown,
  ): EventSubscription;
};

let _emitter: NativeEventEmitter | null = null;

/**
 * Resolve the platform's RN event emitter source. iOS hands listeners to a
 * dedicated `RCTEventEmitter` subclass (`TraceItXEventEmitter`); Android
 * uses the default `RCTDeviceEventEmitter` which `NativeEventEmitter`
 * routes to when constructed with no argument.
 */
export function getEmitter(): TraceItXNativeEventEmitter {
  if (_emitter !== null) return _emitter as unknown as TraceItXNativeEventEmitter;
  if (Platform.OS === 'ios') {
    // `NativeModules.TraceItXEventEmitter` is registered by
    // `TraceItXEventEmitter.swift`'s `RCT_EXPORT_MODULE`. If the host hasn't
    // linked the pod (or codegen didn't pick it up), NativeModules returns
    // an empty stub — NativeEventEmitter still works but events won't fire.
    // We log a one-time warning in that case so misconfigurations surface.
    const mod = NativeModules.TraceItXEventEmitter;
    if (mod === undefined && __DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        '[traceitx] TraceItXEventEmitter native module not found — companion events will not fire. Did the host run `pod install`?',
      );
    }
    _emitter = new NativeEventEmitter(mod);
  } else {
    // Android: passing no argument lands on the default device-event
    // emitter, which `RCTDeviceEventEmitter.emit(...)` writes to from the
    // Java/Kotlin module side.
    _emitter = new NativeEventEmitter();
  }
  return _emitter as unknown as TraceItXNativeEventEmitter;
}

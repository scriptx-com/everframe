// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { bounded, captureInteractionOperation } from './operation.js';
export type PermissionResult =
  | 'granted'
  | 'denied'
  | 'blocked'
  | 'limited'
  | 'unavailable'
  | 'unknown';
const results: readonly string[] = [
  'granted',
  'denied',
  'blocked',
  'limited',
  'unavailable',
  'unknown',
];
/** With no mapper, accepts only PermissionsAndroid.RESULTS strings. */
export async function observePermissionRequest<T>(
  permission: string,
  operation: () => Promise<T>,
  mapResult?: (result: T) => PermissionResult,
): Promise<T> {
  const capture =
    typeof permission === 'string' &&
    permission.length > 0 &&
    permission.length <= 128 &&
    bounded(permission, 128) === permission
      ? captureInteractionOperation()
      : undefined;
  const emit = (phase: 'requested' | 'result', result?: PermissionResult) =>
    capture?.emit({ type: 'permission', permission, phase, ...(result ? { result } : {}) });
  emit('requested');
  let value: T;
  try {
    value = await operation();
  } catch (error) {
    emit('result', 'unknown');
    throw error;
  }
  let result: PermissionResult = 'unknown';
  try {
    const mapped = mapResult
      ? mapResult(value)
      : value === 'never_ask_again'
        ? 'blocked'
        : value === 'granted' || value === 'denied'
          ? value
          : 'unknown';
    if (results.includes(mapped as string)) result = mapped as PermissionResult;
  } catch {
    /* Mapper errors do not change the operation's result. */
  }
  emit('result', result);
  return value;
}

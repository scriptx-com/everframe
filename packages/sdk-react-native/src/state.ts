// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** Small diagnostic labels, not personal data. */
export type StateValue = string | number | boolean;
export function validStateKey(key: unknown): key is string {
  if (typeof key !== 'string' || !key.length || key.length > 64 || key === '__proto__')
    return false;
  for (let i = 0; i < key.length; i++) {
    const unit = key.charCodeAt(i);
    if (unit < 32 || (unit >= 127 && unit <= 159)) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = key.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
export function validStateValue(value: unknown): value is StateValue {
  return (
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 256 && !/\p{Surrogate}/u.test(value))
  );
}

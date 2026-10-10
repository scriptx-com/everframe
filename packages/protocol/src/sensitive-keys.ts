// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Metadata keys whose values are never kept, whatever they contain. Shared by
// normalizeCrashDetails (crash-details.ts) and SDKs that project details
// themselves. Kept free of zod so a JavaScript-only SDK can import it without
// bundling the schema library.
export const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
] as const;

/** ASCII letters lowercased and digits kept; `X-API-Key`, `api_key` and `apiKey` all read `apikey`. */
function normalizedSensitiveKey(key: string): string {
  let normalized = '';
  for (let index = 0; index < key.length; index++) {
    const code = key.charCodeAt(index);
    if (code >= 0x30 && code <= 0x39) normalized += key[index]!;
    else if (code >= 0x41 && code <= 0x5a) normalized += String.fromCharCode(code + 0x20);
    else if (code >= 0x61 && code <= 0x7a) normalized += key[index]!;
  }
  return normalized;
}

/** True when a metadata key names a credential; its value is replaced by `[REDACTED]`. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizedSensitiveKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

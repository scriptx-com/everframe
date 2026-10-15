// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/** Reject authority delimiters concealed by the bundled parser for custom schemes. */
export function safeInteractionHost(host: string): boolean {
  try {
    // Literal colons/brackets support IPv6 and ports; encoded versions can
    // reinterpret a host as a different authority after native decoding.
    if (/%(?:3a|5b|5d)/iu.test(host)) return false;
    const decoded = decodeURIComponent(host);
    // A remaining percent can conceal a delimiter through another decode.
    return !/[/?#@\\%\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(decoded);
  } catch {
    return false;
  }
}

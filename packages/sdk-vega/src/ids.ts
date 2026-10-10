// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/**
 * RFC 4122 version 4 identifier from `Math.random`. Vega's Hermes has no
 * `crypto.getRandomValues`, and a report id only has to be unique per app:
 * the server deduplicates on (app, report id).
 */
export function uuidV4(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else {
      const nibble = Math.floor(random() * 16) & 15;
      out += (i === 19 ? (nibble & 3) | 8 : nibble).toString(16);
    }
  }
  return out;
}

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Byte-level absence check (spec §Privacy regression cases): a phrase must not
// appear in the raw output, in its CSS-unescaped form, or inside any decoded
// `data:` payload (base64 or percent-encoded). Returns the leaks found so both
// vitest and Playwright specs can assert on it.

function decodeCssEscapes(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) =>
    String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd),
  );
}

function decodeDataPayloads(text: string): string[] {
  const out: string[] = [];
  const re = /data:([^,"'\s)]*),([^"'\s)]*)/gi;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const meta = m[1] ?? '';
    const payload = m[2] ?? '';
    if (/;base64$/i.test(meta)) {
      out.push(Buffer.from(payload, 'base64').toString('utf8'));
    } else {
      try {
        out.push(decodeURIComponent(payload));
      } catch {
        out.push(payload);
      }
    }
  }
  return out;
}

export function findLeaks(text: string, phrases: readonly string[]): string[] {
  const unescaped = decodeCssEscapes(text);
  const views = [text, unescaped, ...decodeDataPayloads(text), ...decodeDataPayloads(unescaped)];
  const leaks: string[] = [];
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase();
    if (views.some((v) => v.toLowerCase().includes(needle))) leaks.push(phrase);
  }
  return leaks;
}

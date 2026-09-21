// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// UA-derived device facts for the companion announce `device` block (naming
// spec 2026-08-24 §1). TV platforms first — Tizen/webOS UAs would otherwise
// read as bare "Linux" — then desktop browsers as "<browser> <major>" +
// OS name. The SERVER composes the display name from these; this module
// never formats copy. Deliberately separate from capture/metadata.ts's
// parseUA (envelope semantics) so envelope metadata stays untouched.
//
// Field caps mirror the announce schema (model ≤80, os fields ≤40) so a
// pathological UA can never 400 the whole announce.

export interface CompanionDeviceFacts {
  platform: 'web';
  model: string | null;
  osName: string | null;
  osVersion: string | null;
}

const cap = (s: string | null, n: number): string | null =>
  s === null ? null : s.slice(0, n);

export function deriveDeviceFacts(ua: string): CompanionDeviceFacts {
  const none: CompanionDeviceFacts = {
    platform: 'web', model: null, osName: null, osVersion: null,
  };
  if (typeof ua !== 'string' || ua.length === 0) return none;

  // Samsung Tizen TVs: "(SMART-TV; LINUX; Tizen 7.0)"
  const tizen = /Tizen[ /]?(\d+(?:\.\d+)?)?/i.exec(ua);
  if (tizen) {
    return {
      platform: 'web', model: 'Samsung TV', osName: 'Tizen',
      osVersion: cap(tizen[1] ?? null, 40),
    };
  }
  // LG webOS TVs: "Web0S" (zero, historic quirk) or "webOS"
  if (/Web0S|webOS/i.test(ua)) {
    const v = /webOS(?:\.TV)?[ /-]?(\d+(?:\.\d+)?)/i.exec(ua);
    return {
      platform: 'web', model: 'LG TV', osName: 'webOS',
      osVersion: cap(v?.[1] ?? null, 40),
    };
  }

  // OS class. Order matters: Android before Linux (Android UAs contain
  // "Linux"), Edge before Chrome (Edge UAs contain "Chrome").
  let osName: string | null = null;
  if (/Android/i.test(ua)) osName = 'Android';
  else if (/iPhone|iPad/i.test(ua)) osName = 'iOS';
  else if (/Mac OS X|Macintosh/i.test(ua)) osName = 'macOS';
  else if (/Windows/i.test(ua)) osName = 'Windows';
  else if (/Linux|X11/i.test(ua)) osName = 'Linux';

  let model: string | null = null;
  const edge = /Edg\/(\d+)/.exec(ua);
  const chrome = /Chrome\/(\d+)/.exec(ua);
  const firefox = /Firefox\/(\d+)/.exec(ua);
  const safari = /Version\/(\d+).*Safari/.exec(ua);
  if (edge) model = `Edge ${edge[1]}`;
  else if (chrome) model = `Chrome ${chrome[1]}`;
  else if (firefox) model = `Firefox ${firefox[1]}`;
  else if (safari) model = `Safari ${safari[1]}`;

  if (model === null && osName === null) return none;
  return { platform: 'web', model: cap(model, 80), osName: cap(osName, 40), osVersion: null };
}

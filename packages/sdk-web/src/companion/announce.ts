// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The device's one authenticated HTTP hop before the relay socket opens
// (spec 2026-08-07). Browsers cannot set headers on a WS handshake, so the
// SDK key is proven here and spent as a ticket on /relay/tv/:ticket.
//
// EVERY failure returns null. A device that cannot announce falls back to
// plain /relay/tv and behaves exactly as it did before this feature existed:
// QR works, reporting works, it simply is not discoverable from the
// dashboard. Companion auth failing must never cost a team their reporting.
//
// SECURITY: never log the returned ticket.

import type { CompanionDeviceFacts } from './device-facts.js';

/** The announce `device` block (naming spec 2026-08-24): stable hashed id + raw facts. */
export interface AnnounceDeviceBlock extends CompanionDeviceFacts {
  id: string;
}

export interface AnnounceResult {
  ticket: string;
  /** Short display code the host renders beside (or instead of) the QR. */
  code: string;
  /**
   * Server-resolved display name (naming spec 2026-08-24) — a custom rename,
   * falling back to a host label, falling back to a server-composed default
   * from the `device` block. `null` when the response omitted it (older
   * server) or it was present but blank.
   */
  resolvedName: string | null;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Drops null device fact fields — the server schema wants them absent, not null. */
function toWireDevice(d: AnnounceDeviceBlock): Record<string, unknown> {
  return {
    id: d.id,
    platform: d.platform,
    ...(d.model !== null ? { model: d.model } : {}),
    ...(d.osName !== null ? { osName: d.osName } : {}),
    ...(d.osVersion !== null ? { osVersion: d.osVersion } : {}),
  };
}

export async function announce(opts: {
  endpoint: string;
  sdkKey: string;
  label?: string;
  /**
   * Advertises that this device will render an attach-PIN when the relay
   * pushes `attach.challenge` (spec 2026-08-19). Omitted (not sent as
   * `false`) when the host left it unset — the server treats an absent flag
   * the same as `false`.
   */
  supportsAttachPin?: boolean;
  /**
   * Device facts + stable id (naming spec 2026-08-24). Omitted entirely from
   * the wire body when not provided — old servers ignore an absent key.
   */
  device?: AnnounceDeviceBlock;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<AnnounceResult | null> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') return null;

  // A hung announce would stall the whole companion start. Bound it and fall
  // back rather than leaving the host with no QR at all.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const res = await doFetch(
      `${opts.endpoint.replace(/\/$/, '')}/api/companion/announce`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.sdkKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...(opts.label !== undefined ? { label: opts.label } : {}),
          ...(opts.supportsAttachPin ? { supportsAttachPin: true } : {}),
          ...(opts.device !== undefined ? { device: toWireDevice(opts.device) } : {}),
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<AnnounceResult>;
    if (typeof body.ticket !== 'string' || typeof body.code !== 'string') return null;
    // Present-but-blank is not a usable answer. `{"ticket":"","code":""}`
    // passes the typeof checks above, and a blank ticket composes the socket
    // URL `/relay/tv/` — which the relay rejects as a 4004 TERMINAL close, so
    // the device stops reporting entirely instead of taking the clean
    // ticketless fallback this contract promises. Fail closed. Mirrors the
    // `isBlank()` / `trimmingCharacters` guards in the Android and iOS ports.
    if (body.ticket.trim() === '' || body.code.trim() === '') return null;
    const resolvedName =
      typeof body.resolvedName === 'string' && body.resolvedName.trim() !== ''
        ? body.resolvedName
        : null;
    return { ticket: body.ticket, code: body.code, resolvedName };
  } catch {
    // Offline, aborted, CORS, malformed JSON — all the same answer.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

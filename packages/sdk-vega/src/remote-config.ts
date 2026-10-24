// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The negotiated `GET /api/config`. Vega reads only the quick-capture and
// device-linking blocks; everything else in the response is ignored.
import { isDeviceToken, parseOwner, type LinkOwner } from './link-token.js';
import { requestJson, type SendDeps } from './transport.js';

/** Capability tokens sent in `X-Everframe-SDK-Features`. */
export const SDK_FEATURES: readonly string[] = ['capturehotkey', 'devicelinking'];
export const FEATURES_HEADER = 'X-Everframe-SDK-Features';
export const CAPTURE_TOKEN_HEADER = 'X-Everframe-Capture-Token';
export const CONFIG_MAX_CHARS = 65_536;

export type LinkStatus =
  | { status: 'linked'; owner: LinkOwner; recording?: { id: string; expiresAt: number } }
  | { status: 'unlinked' };

export interface RemoteConfig {
  /** `captureHotkey.enabled`: the app's quick-capture switch. */
  quickCapture: boolean;
  /** `deviceLinking.enabled`. */
  linkingEnabled: boolean;
  /** Present only when the request carried a device token. */
  link?: LinkStatus;
}

const RECORDING_ID = /^[0-9A-Za-z-]{1,64}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function parseLink(raw: unknown): LinkStatus | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.status !== 'linked') return { status: 'unlinked' };
  const owner = parseOwner(raw.owner);
  if (!owner) return undefined;
  const link: LinkStatus = { status: 'linked', owner };
  const recording = raw.recording;
  if (isObject(recording) && typeof recording.id === 'string' && RECORDING_ID.test(recording.id)) {
    const expiresAt =
      typeof recording.expiresAt === 'string' ? Date.parse(recording.expiresAt) : NaN;
    if (Number.isFinite(expiresAt)) link.recording = { id: recording.id, expiresAt };
  }
  return link;
}

/** Lenient: unknown keys are ignored, a missing block reads as off. Null when not an object. */
export function parseRemoteConfig(raw: unknown): RemoteConfig | null {
  if (!isObject(raw)) return null;
  const hotkey = raw.captureHotkey;
  const linking = raw.deviceLinking;
  const config: RemoteConfig = {
    quickCapture: isObject(hotkey) && hotkey.enabled === true,
    linkingEnabled: isObject(linking) && linking.enabled === true,
  };
  if (isObject(linking) && 'link' in linking) {
    const link = parseLink(linking.link);
    if (link) config.link = link;
  }
  return config;
}

/**
 * `GET {apiBase}/api/config`. The device token goes in the capture-token
 * header only when it is a valid `evf_dev_` token; which token belongs to
 * this endpoint and key is decided by the caller. Null on anything but a 200
 * with a parseable object.
 */
export async function fetchRemoteConfig(
  deps: SendDeps,
  apiBase: string,
  sdkKey: string,
  token: string | null,
): Promise<RemoteConfig | null> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${sdkKey}`,
    [FEATURES_HEADER]: SDK_FEATURES.join(', '),
  };
  if (isDeviceToken(token)) headers[CAPTURE_TOKEN_HEADER] = token;
  const result = await requestJson(deps, {
    url: `${apiBase}/api/config`,
    method: 'GET',
    headers,
    maxChars: CONFIG_MAX_CHARS,
  });
  if (result.status !== 200) return null;
  return parseRemoteConfig(result.body);
}

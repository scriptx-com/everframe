// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Every string the device shows for linking and quick capture. The wording is
// shared with the other SDKs (real-device quick capture contract).
import { displayName, type LinkOwner } from './link-token.js';

export const DEFAULT_DEVICE_NAME = 'Vega device';
export const CAPTURED_TEAM = 'Captured · team device';
export const LINKED_TEAM = 'Linked as team device';
export const DEVICE_UNLINKED = 'This device was unlinked';
export const CAPTURE_FAILED = "Capture didn't upload";
export const BANNER_SUBLINE = "A teammate is linking a device. If that's not you, ignore this.";
export const RECORDING_STARTED = 'Recording remote keys for 10 seconds';
export const RECORDING_SENT = 'Keys sent to Everframe';

export const bannerTitle = (number: number): string => `Linking to Everframe · ${number}`;

/** The configured device model, cleaned, else `Vega device`. */
export function deviceLabel(model: string | undefined): string {
  if (typeof model !== 'string' || model.trim().length === 0) return DEFAULT_DEVICE_NAME;
  return displayName(model);
}

export function linkedToast(owner: LinkOwner): string {
  return owner.kind === 'team' ? LINKED_TEAM : `Linked to ${displayName(owner.name)}`;
}

/** `Captured · {name}`, `Captured · team device`, or the device name when unlinked. */
export function capturedToast(owner: LinkOwner | null, deviceName: string): string {
  if (!owner) return `Captured · ${deviceName}`;
  return owner.kind === 'team' ? CAPTURED_TEAM : `Captured · ${displayName(owner.name)}`;
}

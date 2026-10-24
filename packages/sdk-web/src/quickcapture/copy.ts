// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the TV's on-screen copy, verbatim from the
// contract. Owner names go through `ownerDisplayName`.
import { ownerDisplayName, type DeviceLinkOwner } from '../devicelink/token.js';

function modelName(deviceModel: string): string {
  const cleaned = String(deviceModel).replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : 'TV';
}

export const COPY = {
  bannerTitle(n: number): string {
    return `Linking to Everframe · ${n}`;
  },
  BANNER_SUBLINE: "A teammate is linking a device. If that's not you, ignore this.",
  captured(owner: DeviceLinkOwner | null, deviceModel: string): string {
    if (owner === null) return `Captured · ${modelName(deviceModel)}`;
    if (owner.kind === 'team') return 'Captured · team device';
    return `Captured · ${ownerDisplayName(owner.name)}`;
  },
  linked(owner: DeviceLinkOwner): string {
    if (owner.kind === 'team') return 'Linked as team device';
    return `Linked to ${ownerDisplayName(owner.name)}`;
  },
  UNLINKED: 'This device was unlinked',
  CAPTURE_REJECTED: "Capture didn't upload",
  CAPTURE_FAILED: 'Capture failed',
  RECORDING_STARTED: 'Recording remote keys for 10 seconds',
  RECORDING_SENT: 'Keys sent to Everframe',
} as const;

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: what the TV quick-capture runtime needs from the
// SDK instance that installed it. Types only, so the eager install seam can
// name it without pulling the lazy runtime into the always-loaded bundle.
import type { UserMetadata } from '@everframe/sdk-core';
import type { WebPlatformAdapter } from '../adapter.js';
import type { WebEverframeConfig } from '../internal/types.js';
import type { HostSdkName } from '../internal/sdk-identity.js';

export interface QuickCaptureHost {
  config: WebEverframeConfig;
  adapter: WebPlatformAdapter;
  /** Envelope `sdk.name`: `everframe-web` for `init()`, `everframe-react` for the Provider. */
  sdkName: HostSdkName;
  /** The host package's version, envelope `sdk.version`. */
  sdkVersion: string;
  /** The host's live `setUser` value. A getter: it changes on sign-in and sign-out. */
  getUser(): UserMetadata | null;
  /** The host's live `setExtra` value, if any. */
  getExtra(): string | undefined;
  /** True once the host pulled the kill switch on this client. */
  isKilled(): boolean;
}

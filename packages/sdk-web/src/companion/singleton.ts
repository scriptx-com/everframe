// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. Its documented surface stays here as
// deprecated no-op stubs until the next major: `start()` logs one warning per
// page and opens nothing, every state getter returns its idle value, and every
// subscribe function returns an unsubscribe without ever calling its handler.
'use client';

import type { z } from 'zod';
import type { relay } from '@everframe/protocol';
import { warnCompanionRemovedOnce } from './deprecation.js';

/**
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export type CompanionState = 'unpaired' | 'paired' | 'report_in_progress' | 'phone_disconnected';

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type CompanionStateHandler = (oldVal: CompanionState, newVal: CompanionState) => void;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type CompanionPairUrlHandler = (url: string | null) => void;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type CompanionCodeHandler = (code: string | null) => void;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type CompanionAttachedUserNameHandler = (name: string | null) => void;
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type CompanionResolvedNameHandler = (name: string | null) => void;

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export interface CompanionAttachChallenge {
  code: string;
  requestedByName: string;
  ttlMs: number;
}
/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type CompanionAttachChallengeHandler = (c: CompanionAttachChallenge | null) => void;

/**
 * The removed Companion observation surface. Every getter returns its idle
 * value and every `on*` returns an unsubscribe without calling its handler.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export interface CompanionAPI {
  /** Always `'unpaired'`. */
  getState(): CompanionState;
  /** Always `null`. */
  getPairUrl(): string | null;
  /** Always `null`. */
  getCode(): string | null;
  /** Always `null`. */
  getAttachedUserName(): string | null;
  /** Always `null`. */
  getResolvedName(): string | null;
  /** Always `null`. */
  getAttachChallenge(): CompanionAttachChallenge | null;
  /** Never calls `handler`. */
  onState(handler: CompanionStateHandler): () => void;
  /** Never calls `handler`. */
  onPairUrl(handler: CompanionPairUrlHandler): () => void;
  /** Never calls `handler`. */
  onCode(handler: CompanionCodeHandler): () => void;
  /** Never calls `handler`. */
  onAttachedUserName(handler: CompanionAttachedUserNameHandler): () => void;
  /** Never calls `handler`. */
  onResolvedName(handler: CompanionResolvedNameHandler): () => void;
  /** Never calls `handler`. */
  onAttachChallenge(handler: CompanionAttachChallengeHandler): () => void;
}

// Type-only compatibility: the argument shapes of the old `companion.start()`
// callbacks, so existing inline callbacks (`msg.title`, `ws.send(...)`) and
// callbacks annotated with these names keep compiling. Nothing produces these
// values any more; there is no runtime behind them.

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type ReportSubmit = z.infer<typeof relay.ReportSubmit>;

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type RelayMessage =
  | z.infer<typeof relay.PairCreated>
  | z.infer<typeof relay.PairBonded>
  | z.infer<typeof relay.PairExpired>
  | z.infer<typeof relay.PhoneDisconnected>
  | z.infer<typeof relay.ReportRequest>
  | z.infer<typeof relay.ReportAssembled>
  | z.infer<typeof relay.ReportDraftUpdate>
  | ReportSubmit
  | z.infer<typeof relay.ReportCompleted>
  | z.infer<typeof relay.ReportFailed>
  | z.infer<typeof relay.ReportRejected>
  | z.infer<typeof relay.ReportCancelled>;

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export interface RelayWSClient {
  start(): void;
  send(msg: RelayMessage): void;
  sendBinary(bytes: ArrayBuffer): void;
  stop(): void;
  getCompanionAttribution(): string | null;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export interface ReportCounts {
  logs: number;
  network: number;
  uiTreeNodes: number;
  breadcrumbs?: number;
}

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type AttachPinUiMode = 'builtin' | 'custom' | 'off';

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export type BadgePosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';

/** @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture. */
export interface CompanionBadgeOptions {
  enabled?: boolean;
  position?: BadgePosition;
}

/**
 * Every field is still accepted and ignored.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export interface CompanionStartOptions {
  endpoint?: string;
  sdkKey?: string;
  deviceLabel?: string;
  attachPinUi?: AttachPinUiMode;
  counts?: ReportCounts;
  /** Never called. */
  onReportRequest?: (correlationId: string, ws: RelayWSClient) => void;
  /** Never called. */
  onReportSubmit?: (msg: ReportSubmit) => void;
  companionDeviceId?: string | (() => string | Promise<string>);
  companionBadge?: CompanionBadgeOptions;
}

const noop = (): void => undefined;

const IDLE_API: CompanionAPI = Object.freeze({
  getState: (): CompanionState => 'unpaired',
  getPairUrl: (): string | null => null,
  getCode: (): string | null => null,
  getAttachedUserName: (): string | null => null,
  getResolvedName: (): string | null => null,
  getAttachChallenge: (): CompanionAttachChallenge | null => null,
  onState: (): (() => void) => noop,
  onPairUrl: (): (() => void) => noop,
  onCode: (): (() => void) => noop,
  onAttachedUserName: (): (() => void) => noop,
  onResolvedName: (): (() => void) => noop,
  onAttachChallenge: (): (() => void) => noop,
});

/**
 * Returns the idle Companion surface.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export function createCompanion(): CompanionAPI {
  return IDLE_API;
}

/**
 * Returns the idle Companion surface (the one `useCompanion()` reads).
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export function __getCompanionApi(): CompanionAPI {
  return IDLE_API;
}

/**
 * Logs the removal warning once per page. Opens no socket, starts no timer
 * and never throws.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export function start(_opts: CompanionStartOptions = {}): void {
  warnCompanionRemovedOnce();
}

/**
 * Does nothing.
 *
 * @deprecated Everframe Companion has been removed; this call does nothing. Link the device under Project settings → Devices in the dashboard and use quick capture.
 */
export function stop(): void {
  /* nothing to stop */
}

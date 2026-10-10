// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash envelope assembly without zod. sdk-core's buildCrashEnvelope runs the
// protocol's zod-based details normalizer, which would put about 500 KB of
// zod into every Vega app for one optional field. This file produces the same
// envelope shape (packages/sdk-core/src/crash/build.ts — keep the two in
// step) on top of sdk-core's zod-free buildEnvelope, and projects
// captureException details with a small bounded sanitizer. The server
// re-normalizes details at ingest, so this side only has to be safe and
// small, not exhaustive. Cause chains are not collected: Hermes 0.12 has no
// `new Error(message, { cause })`.
import { buildEnvelope, redactStringContent, type DeviceMetadata } from '@everframe/sdk-core';
import type { Breadcrumb, CrashDetails, CrashFrame, CrashPayload, JsBundleMetadata, ReportEnvelope } from '@everframe/protocol';
import { vegaFingerprint } from './bundle.js';
import type { VegaCaptureOptions, VegaUser } from './config.js';

const TITLE_MAX = 200;
const MAX_MESSAGE = 4096;
const MAX_RAW = 1024;
/** What a crash report cannot capture from a dying process (same list as sdk-core). */
const CRASH_EXCLUDED = ['screenshot', 'uiTree', 'focus', 'logs', 'network'];

const SEVERITIES = new Set(['info', 'warning', 'error']);
const MAX_CONTEXT = 256;
const MAX_KEY = 128;
const MAX_STRING = 1024;
const MAX_KEYS = 32;
const MAX_DETAILS_CHARS = 8192;
// Lone surrogates and NUL fail the protocol's text rule; drop the value instead.
const INVALID_TEXT = /[\u0000]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function ownValue(source: object, key: string): { present: boolean; value?: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return { present: false };
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false };
  }
}

/** Handled-error details: severity, a context label and flat metadata. */
export function projectDetails(
  options: VegaCaptureOptions | undefined,
  redact: (value: string) => string,
): CrashDetails {
  const details: CrashDetails = { severity: 'error' };
  if (!options || typeof options !== 'object') return details;
  let truncated = false;

  const severity = ownValue(options, 'severity');
  if (severity.present) {
    if (typeof severity.value === 'string' && SEVERITIES.has(severity.value)) {
      details.severity = severity.value as CrashDetails['severity'] & string;
    } else if (severity.value !== undefined) truncated = true;
  }

  const context = ownValue(options, 'context');
  if (typeof context.value === 'string') {
    const text = redact(context.value);
    if (!INVALID_TEXT.test(text)) {
      if (text.length > MAX_CONTEXT) truncated = true;
      details.context = text.slice(0, MAX_CONTEXT);
    } else truncated = true;
  } else if (context.present && context.value !== undefined) truncated = true;

  const metadata = ownValue(options, 'metadata');
  if (metadata.value && typeof metadata.value === 'object' && !Array.isArray(metadata.value)) {
    const out: Record<string, string | number | boolean | null> = {};
    let count = 0;
    let keys: string[] = [];
    try {
      keys = Object.keys(metadata.value);
    } catch {
      truncated = true;
    }
    for (const key of keys) {
      if (count >= MAX_KEYS) {
        truncated = true;
        break;
      }
      if (key.length === 0 || key.length > MAX_KEY || INVALID_TEXT.test(key) || key === '__proto__') {
        truncated = true;
        continue;
      }
      const entry = ownValue(metadata.value, key).value;
      if (typeof entry === 'string') {
        const text = redact(entry);
        if (INVALID_TEXT.test(text)) {
          truncated = true;
          continue;
        }
        if (text.length > MAX_STRING) truncated = true;
        out[key] = text.slice(0, MAX_STRING);
      } else if ((typeof entry === 'number' && Number.isFinite(entry)) || typeof entry === 'boolean' || entry === null) {
        out[key] = entry;
      } else {
        // Nested objects, arrays, functions and the like are not projected.
        truncated = true;
        continue;
      }
      count++;
    }
    if (count > 0) details.metadata = out;
  } else if (metadata.present && metadata.value !== undefined) truncated = true;

  if (JSON.stringify(details).length > MAX_DETAILS_CHARS) {
    delete details.metadata;
    truncated = true;
  }
  if (truncated) details.truncated = true;
  return details;
}

export interface VegaEnvelopeInput {
  reportId: string;
  occurredAt: string;
  exceptionType: string;
  message: string;
  /** Raw frames, build directory already stripped. */
  framesRaw: string[];
  mechanism: 'errorutils' | 'unhandledrejection' | 'captureException';
  fatal: boolean;
  handledOptions?: VegaCaptureOptions | undefined;
  jsBundle?: JsBundleMetadata | undefined;
  sdk: ReportEnvelope['sdk'];
  app: { name: string; version: string; build?: string };
  device: DeviceMetadata;
  breadcrumbs: Breadcrumb[];
  user: VegaUser | null;
}

export function buildVegaEnvelope(input: VegaEnvelopeInput): ReportEnvelope {
  const redact = (value: string) => redactStringContent(value, {});
  // Redaction can expand text past the caps; re-slice after it, as sdk-core does.
  const message = redact(input.message).slice(0, MAX_MESSAGE);
  const frames: CrashFrame[] = input.framesRaw.map((raw) => ({ raw: redact(raw).slice(0, MAX_RAW) }));
  const handled = input.mechanism === 'captureException';
  const crash: CrashPayload = {
    ...(input.jsBundle ? { jsBundle: input.jsBundle } : {}),
    exceptionType: input.exceptionType,
    message,
    frames,
    mechanism: input.mechanism,
    handled,
    fatal: input.fatal,
    occurredAt: input.occurredAt,
    fingerprint: vegaFingerprint(input.exceptionType, frames),
    ...(handled ? { details: projectDetails(input.handledOptions, redact) } : {}),
  };
  const envelope = buildEnvelope({
    reportId: input.reportId,
    submittedAt: input.occurredAt,
    sdk: input.sdk,
    reporter: {
      title: `${input.exceptionType}: ${message}`.slice(0, TITLE_MAX),
      description: '',
      ...(input.user ? { user: input.user } : {}),
    },
    draft: { title: '', description: '', excludedArtifacts: [...CRASH_EXCLUDED], annotations: [], redactions: [] },
    breadcrumbs: input.breadcrumbs,
    device: input.device,
    app: input.app,
    attachments: [],
  });
  envelope.source = input.fatal ? 'crash' : 'error';
  envelope.payload.crash = crash;
  envelope.captureControl.degradedReason = 'crash-capture';
  return envelope;
}

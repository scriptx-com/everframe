// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Crash-envelope assembly (spec 2026-07-18). SYNCHRONOUS + I/O-free by
// doctrine: callable inside an uncaught-error handler. Reuses buildEnvelope
// so captures/captureControl bookkeeping stays single-sourced; crash strings
// are redacted HERE (mask-before-bytes, same doctrine as crumb add-time)
// because applyRedaction does not know the crash channel.
import {
  normalizeCrashDetails,
  type Breadcrumb,
  type CrashCauseChain,
  type CrashFrame,
  type CrashPayload,
  type ReportEnvelope,
} from '@traceitx/protocol';
import type { DeviceMetadata } from '../types/platform.js';
import type { UserMetadata } from '../types/config.js';
import { buildEnvelope } from '../envelope-builder.js';
import { redactStringContent, type RedactionConfig } from '../redaction/index.js';
import { computeCrashFingerprint } from './fingerprint.js';
import { MAX_MESSAGE, MAX_RAW, type CrashFacts } from './extract.js';
import type { CaptureExceptionOptions } from './options.js';

const TITLE_MAX = 200;
/** Everything a crash report cannot safely capture in a dying/degraded state. */
const CRASH_EXCLUDED = ['screenshot', 'uiTree', 'focus', 'logs', 'network'];

export interface BuildCrashEnvelopeInput {
  facts: CrashFacts;
  /** Already-owned output from extractCrashCauseChain; do not fit or redact again. */
  causeChain?: CrashCauseChain;
  mechanism: string;
  source: 'crash' | 'error';
  handled?: boolean;
  fatal?: boolean;
  occurredAt: string;
  reportId: string;
  submittedAt: string;
  sdk: ReportEnvelope['sdk'];
  breadcrumbs: Breadcrumb[];
  device: DeviceMetadata;
  app: { name: string; version: string; build?: string };
  route?: string;
  redaction: RedactionConfig;
  captureOptions?: CaptureExceptionOptions;
  /**
   * Active `setUser` value at crash time, or null. A crash from a known
   * person is exactly as useful to attribute as a filed report, so this
   * follows the same path (spec 2026-08-12).
   */
  user?: UserMetadata | null;
}

export function buildCrashEnvelope(
  input: BuildCrashEnvelopeInput,
): { envelope: ReportEnvelope; fingerprint: string } {
  // Redaction replacements (e.g. SSN `123-45-6789` -> `[REDACTED:SSN]`, or
  // arbitrary-length web customRules substitutions) can EXPAND text past the
  // protocol caps that extract.ts already enforced pre-redaction. Re-slice
  // post-redaction so an expanding replacement can never grow the envelope
  // past what Zod's ReportEnvelope schema allows (message <= MAX_MESSAGE,
  // frames[].raw <= MAX_RAW) — otherwise the whole envelope is rejected.
  const message = redactStringContent(input.facts.message, input.redaction).slice(0, MAX_MESSAGE);
  // NOTE (adaptation): under this repo's `exactOptionalPropertyTypes: true`,
  // spreading `f: CrashFrame` (whose optional props like `function`/`file`
  // are declared `X | undefined` once spread into a fresh literal) is not
  // assignable back to CrashFrame's own optional-prop shape, nor to
  // computeCrashFingerprint's structurally-identical parameter type. Cast at
  // the boundary (same idiom as envelope-builder.ts:87-90) rather than
  // reshaping the frame or loosening the tsconfig.
  const frames = input.facts.frames.map((f) => ({
    ...f,
    raw: redactStringContent(f.raw, input.redaction).slice(0, MAX_RAW),
  })) as CrashFrame[];
  const fingerprint = computeCrashFingerprint(
    input.facts.exceptionType,
    frames as ReadonlyArray<{ raw: string; function?: string; file?: string }>,
  );
  const details = normalizeCrashDetails(
    input.captureOptions,
    (value) => redactStringContent(value, input.redaction),
    'error',
  );

  const crash: CrashPayload = {
    ...(input.causeChain ? { causeChain: input.causeChain } : {}),
    exceptionType: input.facts.exceptionType,
    message,
    frames,
    mechanism: input.mechanism,
    handled: input.handled ?? false,
    ...(input.fatal !== undefined ? { fatal: input.fatal } : {}),
    occurredAt: input.occurredAt,
    fingerprint,
    ...(details ? { details } : {}),
  };

  const envelope = buildEnvelope({
    reportId: input.reportId,
    submittedAt: input.submittedAt,
    sdk: input.sdk,
    reporter: {
      title: `${input.facts.exceptionType}: ${message}`.slice(0, TITLE_MAX),
      description: '',
      ...(input.user ? { user: input.user } : {}),
    },
    draft: {
      title: '',
      description: '',
      excludedArtifacts: [...CRASH_EXCLUDED],
      annotations: [],
      redactions: [],
    },
    breadcrumbs: input.breadcrumbs,
    device: input.device,
    app: input.app,
    ...(input.route ? { route: input.route } : {}),
    attachments: [],
  });

  envelope.source = input.source;
  envelope.payload.crash = crash;
  envelope.captureControl.degradedReason = 'crash-capture';
  return { envelope, fingerprint };
}

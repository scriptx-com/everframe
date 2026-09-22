// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  PROTOCOL_VERSION,
  type ReportEnvelope,
  type FocusedNode,
  type AttachmentRef,
  type Breadcrumb,
  type NetworkBodyEntry,
} from '@traceitx/protocol';
import type { LogEntry, NetworkEntry, DeviceMetadata, ReportDraft } from './types/platform.js';
import type { UserMetadata } from './types/config.js';
import { trimBreadcrumbs } from './breadcrumbs/trim.js';
import { deriveLogsFromBreadcrumbs, deriveNetworkFromBreadcrumbs } from './breadcrumbs/derive.js';
import { EXTRA_MAX_CHARS } from './extra-budget.js';

export interface BuildEnvelopeInput {
  reportId: string;
  submittedAt: string; // ISO 8601
  sdk: ReportEnvelope['sdk'];
  reporter: { title: string; description: string; user?: UserMetadata | null };
  draft: ReportDraft;
  focus?: FocusedNode | null;
  logs?: LogEntry[];
  network?: NetworkEntry[];
  /** Opt-in body channel (spec 2026-07-18 §6). Already redacted + capped. */
  networkBodies?: NetworkBodyEntry[];
  /** Canonical action-timeline chain (already frozen; trimmed here). */
  breadcrumbs?: Breadcrumb[];
  /** Server-config trim overrides (spec §6 byteBudget / consoleEntryCap). */
  breadcrumbTrim?: { byteBudget?: number; consoleEntryCap?: number };
  device: DeviceMetadata;
  app: { name: string; version: string; build?: string };
  route?: string;
  attachments: AttachmentRef[];
}

export function buildEnvelope(input: BuildEnvelopeInput): ReportEnvelope {
  const includedArtifacts: string[] = [];
  const excludedArtifacts: string[] = input.draft.excludedArtifacts ?? [];

  // Canonical chain: trim to budget (spec §4) unless the reporter excluded it.
  const breadcrumbs =
    input.breadcrumbs && input.breadcrumbs.length && !excludedArtifacts.includes('breadcrumbs')
      ? trimBreadcrumbs(input.breadcrumbs, input.breadcrumbTrim)
      : undefined;

  // Deprecation window (spec §1): legacy logs/network derived from the SAME
  // trimmed chain when not supplied directly. Derived arrays are already
  // budget-bound by trimBreadcrumbs — deliberately NO second trimLogs pass.
  const derivedLogs = breadcrumbs && !input.logs ? deriveLogsFromBreadcrumbs(breadcrumbs) : undefined;
  const derivedNetwork =
    breadcrumbs && !input.network ? deriveNetworkFromBreadcrumbs(breadcrumbs) : undefined;
  const logs = input.logs ?? (derivedLogs?.length ? derivedLogs : undefined);
  const network = input.network ?? (derivedNetwork?.length ? derivedNetwork : undefined);

  // Invariant (network-body-capture spec §10 test 8): every shipped
  // `payload.networkBodies[].ref` must match exactly one shipped
  // `kind === 'network'` crumb's `data.reqId`. Body capture and breadcrumb
  // capture are gated/evicted independently upstream (breadcrumbs may be
  // excluded or the configured `kinds` may omit `network`; the body ring and
  // the crumb ring trim on unrelated budgets) — so a body can outlive the
  // crumb that gave it request context. Filter HERE, after `breadcrumbs`
  // above has been trimmed to the final shipped chain, down to the reqIds
  // that actually made it onto the wire. A body without a shipped crumb
  // carries no request context for the reporter/backend, so it must never
  // upload — crumbs are the side that's authoritative here and are never
  // mutated to "rescue" an orphaned body.
  const shippedNetworkReqIds = new Set(
    (breadcrumbs ?? [])
      .filter((c) => c.kind === 'network')
      .map((c) => reqIdOf(c.data))
      .filter((id): id is number => id !== undefined)
  );
  const filteredBodies =
    input.networkBodies && !excludedArtifacts.includes('network')
      ? input.networkBodies.filter((b) => shippedNetworkReqIds.has(b.ref))
      : [];
  const networkBodies = filteredBodies.length ? filteredBodies : undefined;

  if (input.focus && !excludedArtifacts.includes('focus')) includedArtifacts.push('focus');
  if (breadcrumbs) includedArtifacts.push('breadcrumbs');
  if (logs && !excludedArtifacts.includes('logs')) includedArtifacts.push('logs');
  if (network && !excludedArtifacts.includes('network')) includedArtifacts.push('network');
  if (networkBodies) includedArtifacts.push('networkBodies');
  if (
    input.attachments.some((a) => a.kind === 'screenshot' || a.kind === 'annotated-screenshot')
  ) {
    if (!excludedArtifacts.includes('screenshot')) includedArtifacts.push('screenshot');
  }

  // ReportEnvelope's nested object types include `[x: string]: unknown` (from Zod's
  // .passthrough() inference). Our typed inputs (UserMetadata/DeviceMetadata) don't
  // declare an index signature, so we build the literal as `unknown` and cast at the
  // boundary — the Zod schema is the runtime contract; round-trip tests verify shape.
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    reportId: input.reportId,
    submittedAt: input.submittedAt,
    sdk: input.sdk,
    reporter: {
      title: input.reporter.title,
      description: input.reporter.description,
      ...(input.reporter.user ? { user: input.reporter.user } : {}),
    },
    captures: {
      screenshot: includedArtifacts.includes('screenshot'),
      // UI-tree capture was removed (spec 2026-08-29 follow-up): the SDK no
      // longer walks or ships a tree. The protocol schema still declares this
      // boolean REQUIRED, so it is emitted as a constant `false` rather than
      // dropped — omitting the key fails envelope validation at ingest.
      uiTree: false,
      focus: includedArtifacts.includes('focus'),
      logs: includedArtifacts.includes('logs'),
      network: includedArtifacts.includes('network'),
      breadcrumbs: includedArtifacts.includes('breadcrumbs'),
    },
    captureControl: {
      included: includedArtifacts,
      excluded: excludedArtifacts,
    },
    payload: {
      ...(input.focus ? { focus: input.focus } : {}),
      ...(breadcrumbs ? { breadcrumbs } : {}),
      ...(logs && includedArtifacts.includes('logs') ? { logs: logs as unknown[] } : {}),
      ...(network && includedArtifacts.includes('network') ? { network: network as unknown[] } : {}),
      ...(networkBodies ? { networkBodies } : {}),
      ...(input.draft.annotations.length ? { annotations: input.draft.annotations } : {}),
      ...(input.draft.redactions.length ? { redactions: input.draft.redactions } : {}),
      // Host-supplied free-form metadata (setExtra). Over-budget values are
      // OMITTED, not sliced: slicing serialized JSON leaves a fragment that
      // nothing can parse, so the consumer would get nothing anyway — but
      // silently, and with a corrupt field in the report to explain it.
      ...(input.draft.extra && input.draft.extra.length <= EXTRA_MAX_CHARS
        ? { extra: input.draft.extra }
        : {}),
    },
    context: {
      app: input.app,
      device: input.device,
      ...(input.route ? { route: input.route } : {}),
    },
    attachments: input.attachments,
  } as unknown as ReportEnvelope;

  return envelope;
}

/**
 * Extract a network crumb's `data.reqId` as a number, tolerant of a
 * string-ish value (mirrors the native SDKs' defensive numeric-coercion
 * read of this same field). `NetworkBodyEntry.ref` and the reqId minted by
 * the network patcher (`bc.nextReqId()`) are both plain `number`s, so this
 * is a straightforward comparison in the common case. Returns `undefined`
 * when the key is absent or not numeric.
 */
function reqIdOf(data: Record<string, unknown> | undefined): number | undefined {
  const raw = data?.['reqId'];
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

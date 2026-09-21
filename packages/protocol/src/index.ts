// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Re-exports use named-only `export { ... }` so each identifier carries both
// its value (Zod schema) and inferred type binding in a single declaration —
// adding a separate `export type` line for the same name would duplicate the
// identifier under verbatimModuleSyntax + dts emit.
export { PROTOCOL_VERSION } from './version.js';
export type { ProtocolVersion } from './version.js';
export { ReportEnvelope, SDKPlatform, FormFactor } from './envelope.js';
// Standalone tree schemas for legacy redaction and fixture tools. These are
// not fields in the report envelope or part of native video replay.
export { UINode, UITree } from './ui-tree.js';
export { FocusedNode } from './focus.js';
export { AttachmentRef, AttachmentKind, ReplayFormat } from './attachments.js';
export { Breadcrumb, BreadcrumbKind, BreadcrumbLevel } from './breadcrumb.js';
// PROTO-03 relay control-frame schema — namespaced to avoid collisions with
// envelope-side names (e.g. ReportAssembled, ReportSubmit are relay-specific
// control frames, distinct from any envelope payload concepts).
export * as relay from './relay/index.js';
// traceitx-vtree-v1 native session-replay blob contract — namespaced (mirrors
// relay) and referenced by the envelope via ReplayFormat, never nested in it.
export * as vtree from './vtree/index.js';
export * from './network-body.js';
export * from './crash.js';
export * from './crash-causes.js';
export * from './crash-details.js';
export {
  VitalsPlayerEventType, VitalsPlayerId, VitalsSample, VitalsPlayerEvent,
  VitalsCustomEntry, VitalsEntry, VitalsChunk, SessionSummaryDims,
  SessionSummary, VitalsIngestBody, VitalsIngestRequest,
  MAX_ENVELOPE_VITALS_ENTRIES, MAX_PLAYER_ID_LENGTH, MAX_CUSTOM_DATA_BYTES,
  MAX_CUSTOM_NAME_LENGTH, MAX_PLAYER_LIBRARY_LENGTH, MAX_PLAYER_EVENT_DATA_BYTES,
  utf8ByteLength,
} from './vitals.js';
export {
  ResourceSample, MAX_RESOURCE_SAMPLES, RESOURCE_SAMPLE_INTERVAL_MS,
  RESOURCE_WINDOW_PRESETS, DEFAULT_RESOURCE_WINDOW_SEC,
} from './resources.js';
export type { ResourceSampleT } from './resources.js';

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
export { safeWrap } from './safe-wrap.js';
export {
  __enableReplayTrace,
  __isReplayTraceEnabled,
  __getReplayTrace,
  __resetReplayTrace,
  __traceReplay,
  REPLAY_TRACE_MAX,
} from './debug/replay-trace.js';
export type { ReplayTraceEntry } from './debug/replay-trace.js';
export { createClient, __internalClientState, toTraceItXError, resolveClientExtra } from './client.js';
export type { TraceItXClient, ExtraResolver, ExtraState } from './client.js';
export { trimLogs, MAX_LOG_CHARS, TRIMMED_LOGS_MESSAGE } from './trim-logs.js';
export {
  createBreadcrumbBuffer,
  MAX_BREADCRUMBS,
} from './breadcrumbs/buffer.js';
export type { BreadcrumbBuffer, BreadcrumbBufferDeps, BreadcrumbInput } from './breadcrumbs/buffer.js';
export {
  trimBreadcrumbs,
  crumbCost,
  truncateMiddle,
  isTrimMarker,
  isStructural,
  BREADCRUMB_BYTE_BUDGET,
  CONSOLE_ENTRY_CAP,
  ENTRY_OVERHEAD,
  STACK_DIGEST_MAX_LINES,
  MAX_TRIMMED_ENTRIES,
} from './breadcrumbs/trim.js';
export type { TrimOptions } from './breadcrumbs/trim.js';
export { deriveLogsFromBreadcrumbs, deriveNetworkFromBreadcrumbs } from './breadcrumbs/derive.js';
export {
  createNetworkBodyBuffer,
  DEFAULT_BODY_TOTAL_BUDGET,
} from './capture/network-body-buffer.js';
export type { NetworkBodyBuffer } from './capture/network-body-buffer.js';
export type { AddBreadcrumbInput } from './client.js';
export { buildEnvelope } from './envelope-builder.js';
export type { BuildEnvelopeInput } from './envelope-builder.js';
export { budgetExtra, EXTRA_MAX_CHARS } from './extra-budget.js';
export { sampleAndWarn } from './displayname-heuristic.js';
export { projectUserMetadata } from './user-projection.js';
export {
  sha256Hex,
  computeCrashFingerprint,
  extractCrashFacts,
  extractCrashCauseChain,
  createCrashThrottle,
  buildCrashEnvelope,
} from './crash/index.js';
export type {
  CrashFacts,
  CrashThrottle,
  BuildCrashEnvelopeInput,
  CaptureExceptionOptions,
} from './crash/index.js';
export { applyRedaction, redactStringContent, luhnValid } from './redaction/index.js';
export type { RedactionConfig as RedactionEngineConfig } from './redaction/index.js';
export {
  gzipBytes,
  buildMultipart,
  PayloadTooLargeError,
  HARD_CAP_BYTES,
  GZIP_THRESHOLD,
  submitReport,
  DEFAULT_RETRY_SCHEDULE_MS,
} from './transport/index.js';
export type { MultipartParts, SubmitOptions, SubmitResult } from './transport/index.js';
export { createInMemoryOutbox } from './queue/outbox.js';
export {
  ensureDeviceToken,
  generateDeviceToken,
  isWellFormedDeviceToken,
  DEVICE_TOKEN_PREFIX,
  DEVICE_TOKEN_LENGTH,
  DEVICE_TOKEN_BYTES,
} from './reporter/device-token.js';
export { deriveInstallId, INSTALL_ID_DOMAIN_SEPARATOR } from './install-id.js';
export {
  createReporterApi,
  ReporterApiError,
  MESSAGE_BODY_MAX,
} from './reporter/api.js';
export type {
  ReporterApi,
  ReporterApiDeps,
  ReporterApiErrorCode,
  ThreadSummary,
  ThreadMessage,
  MessagePage,
  ListThreadsResult,
} from './reporter/api.js';
export {
  IdentityTokenHolder,
  IDENTITY_TOKEN_HEADER,
  IDENTITY_TOKEN_MAX_CHARS,
  presentableIdentityToken,
  IDENTITY_REFRESH_MARGIN_MS,
  IDENTITY_PROVIDER_TIMEOUT_MS,
  decodeSub,
} from './reporter/identity-token.js';
export type { IdentityTokenSource, IdentityTokenReader } from './reporter/identity-token.js';
export {
  createThreadClient,
  POLL_FLOOR_MS,
  MAX_SEND_ATTEMPTS,
  MESSAGE_FETCH_WINDOW,
  MESSAGE_FETCH_PAGE_HARD_CAP,
} from './reporter/thread-client.js';
export type {
  ThreadClient,
  ThreadClientState,
  ThreadClientDeps,
  ThreadDetail,
  ThreadTruncation,
  PendingMessage,
} from './reporter/thread-client.js';
export {
  createConfigProvider,
  DEFAULT_REPORT_HOTKEY_BINDING,
  ReplayConfigResponse,
  REPLAY_CONFIG_OFF,
  DEFAULT_CONFIG_TTL_MS,
  createReplayLifecycle,
  BreadcrumbsConfig,
  BREADCRUMBS_CONFIG_DEFAULT,
  getBreadcrumbsConfig,
  isRepliesEnabled,
  RepliesConfig,
  NetworkBodiesServerConfig,
  NETWORK_BODIES_CONFIG_DEFAULT,
  getNetworkBodiesConfig,
  isIdentityEnabled,
  IdentityConfig,
  CompanionBadgeServerConfig,
  getCompanionBadgeServerConfig,
  BrandingThemeServerConfig,
  BrandingServerConfig,
  getBrandingServerConfig,
  ResourcesServerConfig,
  getResourcesServerConfig,
} from './types/replay/index.js';
export type {
  ReplayConfig,
  ConfigProvider,
  ConfigProviderDeps,
  ReplayState,
  ReplayLifecycle,
  ReplayLifecycleDeps,
  NetworkBodiesConfig,
} from './types/replay/index.js';
export type * from './types/platform.js';
export type * from './types/config.js';
export type * from './types/redaction.js';
export { createVitalsCollector } from './vitals/collector.js';
export type { VitalsCollector, VitalsCollectorDeps } from './vitals/collector.js';
export { createSummaryAccumulator } from './vitals/summary.js';
export type { SummaryAccumulator } from './vitals/summary.js';
export { boundJson } from './vitals/bound-json.js';
export type { BoundedJson } from './vitals/bound-json.js';
export type {
  PlayerEmit, PlayerIntegration, PlayerIntegrationContext, PlayerSnapshot, PlayerStartupTimings,
} from './vitals/player-integration.js';
// Re-export protocol types so platform packages can import everything from sdk-core.
export * from '@traceitx/protocol';

// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Platform-neutral session-replay seam (sdk-core). DOM-free: owns the lifecycle
// state machine + fail-closed config policy; platform packages plug the recorder
// behind `PlatformAdapter.replay`.
export {
  createConfigProvider,
  DEFAULT_REPORT_HOTKEY_BINDING,
  ReplayConfigResponse,
  REPLAY_CONFIG_OFF,
  DEFAULT_CONFIG_TTL_MS,
  SDK_FEATURES_HEADER,
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
  CaptureHotkeyServerConfig,
  DeviceLinkOwnerWire,
  DeviceLinkStatusWire,
  DeviceLinkingServerConfig,
  CaptureGestureServerConfig,
  CAPTURE_TOKEN_HEADER,
} from './config-provider.js';
export type {
  ReplayConfig,
  ConfigProvider,
  ConfigProviderDeps,
  NetworkBodiesConfig,
} from './config-provider.js';
export { createReplayLifecycle, replaySamplingRate } from './lifecycle.js';
export type {
  ReplayState,
  ReplayLifecycle,
  ReplayLifecycleDeps,
  ReplaySessionKind,
} from './lifecycle.js';

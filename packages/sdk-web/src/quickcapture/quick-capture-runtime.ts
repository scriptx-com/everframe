// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the lazy runtime. Loaded by
// `install.ts` only on a Tizen or webOS TV, and only once the config arms the
// capture gesture. Owns the overlay, the device-link controller and the
// capture pipeline; `onGesture()` is the single entry point the remote
// binding (a later change) calls.
import type { ReplayConfig } from '@everframe/sdk-core';
import { INGEST_URL } from '../constants.js';
import {
  decideGesture,
  quickCaptureEnabled,
  type GestureDecision,
  type GestureInput,
} from '../devicelink/gesture-rule.js';
import { newLinkNonce } from '../devicelink/token.js';
import { quickCaptureDebug, type HelloDevice } from '../devicelink/tv-platform.js';
import { collectHelloDevice } from './hello-device.js';
import { createDeviceLinkController, type DeviceLinkController } from './device-link.js';
import type { QuickCaptureHost } from './host.js';
import { createDeviceLinkClient } from './link-client.js';
import { createOverlay } from './overlay.js';
import { createQuickCapture, type QuickCapture } from './pipeline.js';

export interface QuickCaptureRuntime {
  applyConfig(config: ReplayConfig, carriedToken: string | null): void;
  onGesture(): GestureDecision;
  teardown(): void;
}

const NOTHING: GestureDecision = { capture: false, sendHello: false, swallowKeys: false };

/** Test seam: the controller and pipeline behind a runtime. */
export interface QuickCaptureRuntimeInternals {
  link: DeviceLinkController;
  pipeline: QuickCapture;
}
const internals = new WeakMap<QuickCaptureRuntime, QuickCaptureRuntimeInternals>();
export function __runtimeInternalsForTesting(
  runtime: QuickCaptureRuntime,
): QuickCaptureRuntimeInternals | undefined {
  return internals.get(runtime);
}

export function startQuickCaptureRuntime(host: QuickCaptureHost): QuickCaptureRuntime {
  const adapter = host.adapter;
  const platform = adapter.__tvPlatform ?? 'tizen';
  const store = adapter.__deviceLinkStore;
  const debugBuild = quickCaptureDebug(host.config);
  let tornDown = false;
  let server: ReplayConfig | null = null;

  const overlay = createOverlay();
  const client = createDeviceLinkClient({ ingestUrl: INGEST_URL, sdkKey: host.config.sdkKey });

  let devicePromise: Promise<HelloDevice> | null = null;
  let deviceModel = platform === 'webos' ? 'LG TV' : 'Samsung TV';
  const device = (): Promise<HelloDevice> => {
    if (!devicePromise) {
      devicePromise = collectHelloDevice(platform, host.config.appVersion).then((d) => {
        deviceModel = d.model;
        return d;
      });
    }
    return devicePromise;
  };
  // Warm the facts so an unlinked debug toast names the real model.
  void device().catch(() => undefined);

  const timers = {
    set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clear: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  // A store always exists when this runs (install.ts checks); the fallback
  // keeps the type honest without a non-null assertion.
  const link = createDeviceLinkController({
    store: store ?? {
      scope: '',
      load: () => null,
      save: () => false,
      updateOwner: () => undefined,
      clear: () => false,
    },
    client,
    overlay,
    device,
    nonce: () => newLinkNonce(),
    now: () => Date.now(),
    timers,
    onLinkChanged: () => {
      if (!tornDown) adapter.__reevaluateReplay();
    },
    refreshConfig: () => {
      if (!tornDown) void adapter.__refreshConfigNow();
    },
  });

  const pipeline = createQuickCapture({
    host,
    link,
    overlay,
    deviceModel: () => deviceModel,
    debugBuild,
    isCurrent: () => !tornDown,
    now: () => Date.now(),
    beginAttempt: (attemptId, number, nonce) => link.beginAttempt(attemptId, number, nonce),
  });

  function input(): GestureInput {
    const cfg = server;
    return {
      quickCaptureEnabled: cfg !== null && quickCaptureEnabled(host.config, cfg, host.isKilled()),
      linkingEnabled: link.linkingEnabled,
      owner: link.owner,
      debugBuild,
    };
  }

  const runtime: QuickCaptureRuntime = {
    applyConfig(config: ReplayConfig, carriedToken: string | null): void {
      try {
        if (tornDown) return;
        server = config;
        link.applyConfig(config.deviceLinking, carriedToken);
      } catch {
        /* DEFE-02 */
      }
    },
    onGesture(): GestureDecision {
      try {
        if (tornDown) return NOTHING;
        const decision = decideGesture(input());
        if (decision.capture) void pipeline.capture();
        if (decision.sendHello) link.sendHello();
        return decision;
      } catch {
        return NOTHING;
      }
    },
    teardown(): void {
      if (tornDown) return;
      tornDown = true;
      try {
        link.teardown();
      } catch {
        /* DEFE-02 */
      }
      try {
        overlay.destroy();
      } catch {
        /* DEFE-02 */
      }
    },
  };
  internals.set(runtime, { link, pipeline });
  return runtime;
}

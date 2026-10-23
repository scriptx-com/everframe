// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture (web TVs): the eager install seam. It does
// nothing at all unless this is a Tizen or webOS engine and no local switch
// turns quick capture off. On a TV it watches the committed config and
// imports the runtime chunk the first time the capture gesture is armed;
// desktop browsers never load it and never make a new request.
import type { ReplayConfig } from '@everframe/sdk-core';
import {
  isGestureArmed,
  quickCaptureEnabled,
  type GestureDecision,
} from '../devicelink/gesture-rule.js';
import { quickCaptureDebug } from '../devicelink/tv-platform.js';
import type { QuickCaptureHost } from './host.js';
import type { QuickCaptureRuntime } from './quick-capture-runtime.js';

export interface QuickCaptureInstall {
  dispose(): void;
  /** Test seam: runs the gesture once the runtime is loaded; null when it never will be. */
  __onGestureForTesting(): Promise<GestureDecision | null>;
}

type RuntimeModule = typeof import('./quick-capture-runtime.js');

const NOOP: QuickCaptureInstall = {
  dispose: () => undefined,
  __onGestureForTesting: () => Promise.resolve(null),
};

function locallyOff(host: QuickCaptureHost): boolean {
  const c = host.config;
  return c.disabled === true || c.quickCapture?.disabled === true || c.reporter?.disabled === true;
}

export function installQuickCapture(
  host: QuickCaptureHost,
  load: () => Promise<RuntimeModule> = () => import('./quick-capture-runtime.js'),
): QuickCaptureInstall {
  try {
    const adapter = host.adapter;
    if (!adapter || !adapter.__tvPlatform || !adapter.__deviceLinkStore || locallyOff(host)) {
      return NOOP;
    }
    const store = adapter.__deviceLinkStore;
    let disposed = false;
    let runtime: QuickCaptureRuntime | null = null;
    let loading: Promise<void> | null = null;
    let last: { config: ReplayConfig; token: string | null } | null = null;
    let unsubscribe: () => void = () => undefined;

    const armed = (config: ReplayConfig): boolean => {
      try {
        return isGestureArmed({
          quickCaptureEnabled: quickCaptureEnabled(host.config, config, host.isKilled()),
          linkingEnabled: config.deviceLinking?.enabled === true,
          owner: store.load()?.owner ?? null,
          debugBuild: quickCaptureDebug(host.config),
        });
      } catch {
        return false;
      }
    };

    const stop = (): void => {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch {
        /* DEFE-02 */
      }
      const r = runtime;
      runtime = null;
      try {
        r?.teardown();
      } catch {
        /* DEFE-02 */
      }
    };

    const startLoad = (): void => {
      // The install ticket: a dispose() before the chunk resolves means the
      // runtime never starts.
      loading = load().then(
        (m) => {
          if (disposed || runtime) return;
          const r = m.startQuickCaptureRuntime(host);
          runtime = r;
          // The kill path tears the runtime down and ends this install.
          adapter.__registerQuickCaptureTeardown(stop);
          if (last) r.applyConfig(last.config, last.token);
        },
        () => {
          // A failed chunk load is retried on the next armed config.
          loading = null;
        },
      );
    };

    unsubscribe = adapter.__subscribeLiveConfig((config, token) => {
      try {
        if (disposed) return;
        last = { config, token };
        if (runtime) {
          runtime.applyConfig(config, token);
          return;
        }
        if (!loading && armed(config)) startLoad();
      } catch {
        /* DEFE-02 */
      }
    });

    return {
      dispose(): void {
        // The registered kill-path teardown stays: it is this same idempotent
        // stop(), and clearing it could clobber a newer install's.
        stop();
      },
      async __onGestureForTesting(): Promise<GestureDecision | null> {
        try {
          if (loading) await loading;
        } catch {
          /* fall through */
        }
        return runtime ? runtime.onGesture() : null;
      },
    };
  } catch {
    return NOOP;
  }
}

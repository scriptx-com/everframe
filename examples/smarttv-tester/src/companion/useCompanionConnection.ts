// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// App-level companion session on the SDK's singleton surface
// (`companion.start()` / `stop()` / `useCompanion()`). The singleton wires
// the full device-side contract — announce (dashboard discovery), report
// capture + submit through the companion host seam (mounted by
// TraceItXProvider in main.tsx), and the live-preview / multi-shot loops —
// so the tester exercises exactly what a production TV host would run.
import { useCallback, useEffect, useState } from 'react';
import { companion } from '@traceitx/react';

// Baked by vite `define` (see vite.config.ts). The typeof guards keep the
// module loadable where define didn't run (vitest).
export const SDK_KEY = typeof __TRACEITX_SDK_KEY__ !== 'undefined' ? __TRACEITX_SDK_KEY__ : '';
export const INGEST_OVERRIDE =
  typeof __TRACEITX_TESTER_INGEST_URL__ !== 'undefined' ? __TRACEITX_TESTER_INGEST_URL__ : '';

/** 'disconnected' | 'connecting' before the relay answers, then the SDK's own CompanionState. */
export type ConnectionStatus = 'disconnected' | 'connecting' | companion.CompanionState;

export interface CompanionConnection {
  status: ConnectionStatus;
  pairUrl: string | null;
  /** Short display code from the announce — shown beside the device on the dashboard. */
  code: string | null;
  error: string | null;
  connected: boolean;
  /**
   * Whether an SDK key was baked in — with one, connect() announces the
   * device to /api/companion/announce and it appears on the project's
   * companion page; without one the relay works but the device is invisible
   * to the dashboard.
   */
  discoverable: boolean;
  connect: () => void;
  disconnect: () => void;
}

export function useCompanionConnection(): CompanionConnection {
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = companion.useCompanion();

  const connect = useCallback(() => {
    setError(null);
    try {
      companion.start({
        deviceLabel: 'Smart-TV Tester',
        // The key makes the device discoverable (announce -> companion page);
        // the endpoint override beats the URL baked into @traceitx/react —
        // needed on a real TV, where localhost is the TV itself.
        ...(SDK_KEY ? { sdkKey: SDK_KEY } : {}),
        ...(INGEST_OVERRIDE ? { endpoint: INGEST_OVERRIDE } : {}),
      });
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const disconnect = useCallback(() => {
    companion.stop();
    setStarted(false);
  }, []);

  // Auto-connect on launch — a production TV host starts advertising on
  // boot (the RN sample does the same), so a freshly loaded tester should
  // appear on the dashboard without a remote in hand. The sidebar button
  // stays the manual Disconnect/Connect toggle. Also tears the socket down
  // when the app unmounts (stop() is a safe no-op when never started).
  useEffect(() => {
    connect();
    return () => companion.stop();
  }, [connect]);

  const status: ConnectionStatus = !started
    ? 'disconnected'
    : live.state === 'unpaired' && live.pairUrl === null
      ? 'connecting'
      : live.state;

  return {
    status,
    pairUrl: started ? live.pairUrl : null,
    code: started ? live.code : null,
    error,
    connected: started,
    discoverable: SDK_KEY !== '',
    connect,
    disconnect,
  };
}

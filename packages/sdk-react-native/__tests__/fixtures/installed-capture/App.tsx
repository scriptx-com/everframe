// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
// Installed acceptance only. Use a separately owned Debug host whose native
// ingest endpoint is loopback. Import the built public package, not src/.
import React, { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { captureException, TraceItXProvider, useTraceItX } from '@traceitx/react-native';

const config = {
  // Syntactically valid, nonsecret fixture key (native iOS validates length).
  apiKey: 'txx_live_00000000000000000000000000000000',
  appName: 'C1a installed acceptance',
  jsBundle: {
    buildId: `c1a-installed-debug-${Platform.OS}-20260914`,
    bundleName: Platform.OS === 'ios' ? 'main.jsbundle' : 'index.android.bundle',
  },
};

function Probes() {
  const hook = useTraceItX();
  const attempted = useRef(false);
  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;
    // Different exception types keep the two real frames in independent
    // normalized keys. Never replace Error.stack or manufacture crash JSON.
    try {
      const error = new Error('c1a-installed-top-level');
      error.name = 'C1aTopLevelProbeError';
      throw error;
    } catch (error) {
      captureException(error);
    }
    try {
      const error = new Error('c1a-installed-hook');
      error.name = 'C1aHookProbeError';
      throw error;
    } catch (error) {
      hook.captureException(error);
    }
  }, [hook]);
  return null;
}

export function App() {
  return <TraceItXProvider config={config}><Probes /></TraceItXProvider>;
}

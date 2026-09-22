// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// TraceItXProvider mounts the companion HOST SEAM — without it the phone's
// live view and shot requests are refused with capture_unavailable and a
// phone-driven submit degrades to report.failed("submit_unavailable"). The
// apiKey is the same Web SDK key the companion announces with.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TraceItXProvider } from '@traceitx/react';
import { App } from './App.js';
import { SDK_KEY } from './companion/useCompanionConnection.js';

const root = document.getElementById('root');
if (!root) throw new Error('smarttv-tester: missing #root');

createRoot(root).render(
  <StrictMode>
    <TraceItXProvider config={{ apiKey: SDK_KEY }}>
      <App />
    </TraceItXProvider>
  </StrictMode>,
);

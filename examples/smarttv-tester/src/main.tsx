// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// EverframeProvider starts the Web SDK for the tester: crashes, errors,
// breadcrumbs and session replay from a real TV browser.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EverframeProvider } from '@everframe/react';
import { App } from './App.js';
import { SDK_KEY } from './config.js';

const root = document.getElementById('root');
if (!root) throw new Error('smarttv-tester: missing #root');

createRoot(root).render(
  <StrictMode>
    <EverframeProvider config={{ sdkKey: SDK_KEY }}>
      <App />
    </EverframeProvider>
  </StrictMode>,
);

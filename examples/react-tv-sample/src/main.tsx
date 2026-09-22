// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('react-tv-sample: missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

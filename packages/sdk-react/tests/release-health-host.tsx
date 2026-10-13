// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { EverframeProvider } from '../src/provider.js';
const params = new URLSearchParams(location.search);
const config = {
  sdkKey: params.get('key')!,
  appVersion: '12.3.5-12-webos',
  debugBuild: params.has('debug'),
  reporter: { disabled: true },
};
function Ready() {
  useEffect(() => {
    Object.assign(window, { healthReady: true });
  }, []);
  return <span>Ready</span>;
}
let root = createRoot(document.getElementById('root')!);
const mount = () =>
  root.render(
    <StrictMode>
      <EverframeProvider config={config}>
        <Ready />
      </EverframeProvider>
    </StrictMode>,
  );
mount();
Object.assign(window, {
  remountHealthHost: () => {
    root.unmount();
    root = createRoot(document.getElementById('root')!);
    mount();
  },
});

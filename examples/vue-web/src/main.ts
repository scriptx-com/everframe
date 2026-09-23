// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { vSensitive } from './sensitive';
import './styles.css';

function mount(): ReturnType<typeof createApp> {
  const app = createApp(App);
  app.use(router).directive('sensitive', vSensitive).mount('#app');
  return app;
}

let app = mount();

// Spec hook: unmount and remount the whole app, so
// e2e/vue/mount.spec.ts can prove destroy()/init() do not accumulate hosts.
// This package is private and never ships.
(window as unknown as Record<string, unknown>)['__everframeRemount'] = (): void => {
  app.unmount();
  app = mount();
};

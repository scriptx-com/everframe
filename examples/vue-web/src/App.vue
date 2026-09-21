<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<script setup lang="ts">
import { onMounted, onUnmounted, provide, ref } from 'vue';
import { init, sensitiveRegistry, type TraceItXHandle } from '@traceitx/web';
import { TRACEITX_KEY } from './traceitx';
import SiteNav from './components/SiteNav.vue';
import ReportFab from './components/ReportFab.vue';

const handle = ref<TraceItXHandle | null>(null);
provide(TRACEITX_KEY, handle);

onMounted(() => {
  handle.value = init({
    apiKey: import.meta.env['VITE_TRACEITX_KEY'] ?? 'txx_live_test',
    appVersion: '0.0.1-vue',
  });
  // Spec hooks. Both are read by packages/sdk-web/e2e/vue/*.
  (window as unknown as Record<string, unknown>)['__traceitx'] = handle.value;
  (window as unknown as Record<string, unknown>)['__traceitxSensitive'] = sensitiveRegistry;
});

onUnmounted(() => {
  handle.value?.destroy();
  handle.value = null;
});
</script>

<template>
  <SiteNav />
  <RouterView />
  <ReportFab />
</template>

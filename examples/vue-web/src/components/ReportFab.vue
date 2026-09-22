<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<script setup lang="ts">
import { useTraceItX } from '../traceitx';

const traceitx = useTraceItX();

function open(): void {
  // Swallowed: open() rejects if the reporter is not mounted, and a spec that
  // ends with the dialog open would otherwise surface an unhandled rejection
  // that has nothing to do with what is under test.
  traceitx.value?.open().catch(() => {});
}
</script>

<template>
  <button class="report-fab" type="button" data-testid="traceitx-bubble" @click="open">
    Report a bug
  </button>
</template>

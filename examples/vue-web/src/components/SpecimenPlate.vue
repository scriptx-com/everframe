<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<!-- Deliberately simpler than the React example's 246-line generative plate.
     It is a capture target for the screenshot, not SDK surface. -->
<script setup lang="ts">
import type { Specimen } from '../data/specimens';

defineProps<{ specimen: Specimen }>();
</script>

<template>
  <svg
    class="plate"
    viewBox="0 0 120 120"
    role="img"
    :aria-label="`Plate of ${specimen.commonName}`"
  >
    <ellipse cx="60" cy="66" rx="30" ry="40" :fill="specimen.color" />
    <circle cx="60" cy="26" r="14" fill="#20241c" />
    <line x1="60" y1="30" x2="60" y2="104" stroke="#20241c" stroke-width="2" />
  </svg>
</template>

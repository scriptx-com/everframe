<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { SPECIMENS } from '../data/specimens';
import SpecimenPlate from '../components/SpecimenPlate.vue';

const order = ref<string>('all');
const orders = computed(() => ['all', ...new Set(SPECIMENS.map((s) => s.order))]);
const shown = computed(() =>
  order.value === 'all' ? SPECIMENS : SPECIMENS.filter((s) => s.order === order.value),
);
</script>

<template>
  <main class="shell">
    <h1>Specimens</h1>
    <!-- aria-label is what the SDK reads for a tap crumb's label: the chain is
         aria-label -> visible text -> tag#id -> tag. A filter chip labelled
         only by its short text lands in the trail as "tap all"; this makes it
         legible. See /docs/web/breadcrumbs/. -->
    <div class="card">
      <button
        v-for="o in orders"
        :key="o"
        type="button"
        :aria-label="`Filter specimens by order: ${o}`"
        :data-testid="`filter-${o}`"
        @click="order = o"
      >
        {{ o }}
      </button>
    </div>
    <ul>
      <li v-for="s in shown" :key="s.id" class="card">
        <RouterLink :to="`/specimens/${s.id}`" :data-testid="`specimen-link-${s.id}`">
          <SpecimenPlate :specimen="s" />
          {{ s.commonName }}
        </RouterLink>
      </li>
    </ul>
  </main>
</template>

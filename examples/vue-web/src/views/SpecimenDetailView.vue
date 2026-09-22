<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { getSpecimen } from '../data/specimens';
import SpecimenPlate from '../components/SpecimenPlate.vue';

const route = useRoute();
const specimen = computed(() => getSpecimen(String(route.params['id'])));

/** Cross-page write, so the report carries state set on another route. */
function logObservation(): void {
  const key = 'elytra.observations';
  const prev = JSON.parse(localStorage.getItem(key) ?? '[]') as string[];
  localStorage.setItem(key, JSON.stringify([...prev, String(route.params['id'])]));
}
</script>

<template>
  <main v-if="specimen" class="shell">
    <h1 data-testid="specimen-name">{{ specimen.commonName }}</h1>
    <SpecimenPlate :specimen="specimen" />
    <dl class="card">
      <dt>Latin name</dt><dd>{{ specimen.latinName }}</dd>
      <dt>Order</dt><dd>{{ specimen.order }}</dd>
      <dt>Size</dt><dd>{{ specimen.sizeMm }}</dd>
      <dt>Habitat</dt><dd>{{ specimen.habitat }}</dd>
      <dt>Season</dt><dd>{{ specimen.season }}</dd>
    </dl>
    <p>{{ specimen.note }}</p>
    <button type="button" data-testid="log-observation" @click="logObservation">
      Log an observation
    </button>
  </main>
  <main v-else class="shell"><h1>Unknown specimen</h1></main>
</template>

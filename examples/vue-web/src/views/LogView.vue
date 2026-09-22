<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<!-- DOM mutation fixture: adding and deleting entries gives session replay
     something to record beyond a static page. -->
<script setup lang="ts">
import { ref } from 'vue';

const entries = ref<string[]>(['Ladybird on the south hedge', 'Tiger beetle, sand path']);
const draft = ref('');

function add(): void {
  if (!draft.value.trim()) return;
  entries.value = [...entries.value, draft.value.trim()];
  draft.value = '';
}

function remove(i: number): void {
  entries.value = entries.value.filter((_, n) => n !== i);
}
</script>

<template>
  <main class="shell">
    <h1>Field log</h1>
    <div class="card">
      <label for="log-entry">New observation</label>
      <input id="log-entry" v-model="draft" data-testid="log-input" type="text" />
      <button type="button" data-testid="log-add" aria-label="Add observation" @click="add">
        Add
      </button>
    </div>
    <ul>
      <li v-for="(e, i) in entries" :key="e" class="card">
        {{ e }}
        <button
          type="button"
          :data-testid="`log-delete-${i}`"
          :aria-label="`Delete observation: ${e}`"
          @click="remove(i)"
        >
          Delete
        </button>
      </li>
    </ul>
  </main>
</template>

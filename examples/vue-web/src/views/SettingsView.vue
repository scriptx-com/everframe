<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<!-- The SDK surface beyond open(): setUser, setExtra, and the kill switch,
     wired to real controls. kill() is irreversible by design — nothing here
     offers an undo, because the SDK offers none. -->
<script setup lang="ts">
import { ref } from 'vue';
import { useTraceItX } from '../traceitx';

const traceitx = useTraceItX();
const name = ref('Ada Collector');
const email = ref('ada@example.com');
const extra = ref('{"plan":"field-team","build":"demo"}');
const status = ref<string | null>(null);
const killed = ref(false);

function applyUser(): void {
  traceitx.value?.setUser({ displayName: name.value, email: email.value });
  status.value = `setUser applied — the next report is attributed to ${name.value}.`;
}

function applyExtra(): void {
  traceitx.value?.setExtra(extra.value);
  status.value = 'setExtra applied — the string rides along with the next report.';
}

function killSdk(): void {
  traceitx.value?.kill();
  killed.value = true;
  status.value = 'SDK killed. Nothing is captured and nothing leaves the device until reload.';
}
</script>

<template>
  <main class="shell">
    <h1>Settings</h1>
    <p v-if="status" role="status" data-testid="settings-status" class="fixture-note">
      {{ status }}
    </p>

    <section class="card">
      <h2>Identity — setUser()</h2>
      <label for="user-name">Name</label>
      <input id="user-name" v-model="name" data-testid="user-name" type="text" />
      <label for="user-email">Email</label>
      <input id="user-email" v-model="email" data-testid="user-email" type="email" />
      <button type="button" data-testid="apply-user" @click="applyUser">Apply setUser</button>
    </section>

    <section class="card">
      <h2>Context — setExtra()</h2>
      <label for="extra-value">Extra (opaque string, capped at 2000 chars)</label>
      <input id="extra-value" v-model="extra" data-testid="extra-value" type="text" />
      <button type="button" data-testid="apply-extra" @click="applyExtra">Apply setExtra</button>
    </section>

    <section class="card">
      <h2>Consent — kill()</h2>
      <p>
        Stops this instance capturing or submitting anything further. A reporter that is
        already open discards on Send. There is no undo — reload the page.
      </p>
      <button type="button" data-testid="kill-sdk" :disabled="killed" @click="killSdk">
        Kill the SDK
      </button>
    </section>
  </main>
</template>

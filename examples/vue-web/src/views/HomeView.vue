<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
<!--
  Home ("Field desk") — the e2e anchor page. These fixtures MUST survive any
  redesign; packages/sdk-web/e2e/vue/* assert them:
    - data-testid="home-heading" with the literal "Everframe Web SDK Example"
    - data-testid="cc-number" / "bearer-token" with the canonical PII strings
    - the two masking surfaces, and the password input
  The strings are byte-identical to examples/react-web so a divergence between
  the two SDKs shows up as a failing assertion.
-->
<script setup lang="ts">
import { getSpecimen } from '../data/specimens';
import SpecimenPlate from '../components/SpecimenPlate.vue';
import { useEverframe } from '../everframe';

const hero = getSpecimen('everframe-001');
const everframe = useEverframe();
</script>

<template>
  <main class="shell">
    <p data-testid="home-heading">Everframe Web SDK Example</p>
    <h1>A field catalog built to be broken</h1>
    <p>
      Elytra is a small insect field guide that exists so the Everframe reporter has
      something real to capture: pages to navigate, lists to mutate, images to
      screenshot, and seeded PII to redact. File a bug about a bug — the report button
      is in the corner of every page, or press Cmd/Ctrl+Shift+B.
    </p>
    <SpecimenPlate v-if="hero" :specimen="hero" />
    <button type="button" data-testid="open-via-handle" @click="everframe?.open().catch(() => {})">
      Open reporter via handle.open()
    </button>

    <section class="card">
      <span class="fixture-note">
        fixture · seeded PII — every value below must be redacted from the report envelope
      </span>
      <h2>Collector profile</h2>
      <dl>
        <dt>Card on file</dt>
        <dd class="pii-value" data-testid="cc-number">Test card: 4111-1111-1111-1111</dd>
        <dt>Session token</dt>
        <dd class="pii-value" data-testid="bearer-token">
          Auth: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake-signature
        </dd>
      </dl>
      <div>
        <label for="member-password">Member password (input type=password)</label>
        <input
          id="member-password"
          data-testid="password-input"
          type="password"
          value="hunter2"
        />
      </div>

      <!-- Surface 1 of 2: the attribute. Scanned from the live DOM at capture
           time, so it works in any template with nothing imported. -->
      <p data-everframe-sensitive data-testid="sensitive-attr-block">
        Marked with the data-everframe-sensitive attribute
      </p>

      <!-- Surface 2 of 2: the registry, through the v-sensitive directive.
           This is the one that must unregister on unmount. -->
      <p v-sensitive data-testid="sensitive-block">
        User-provided sensitive content (registered via sensitiveRegistry)
      </p>
    </section>
  </main>
</template>

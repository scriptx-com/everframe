// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `v-sensitive` — the idiomatic Vue equivalent of @everframe/react's
// <Sensitive> wrapper, over the same registry.
//
// The unmounted hook is the whole point. The data-everframe-sensitive ATTRIBUTE
// needs no cleanup because it is re-scanned from the live DOM at capture time;
// the REGISTRY holds whatever it is given, so a host that never calls
// removeRef leaks a reference to a detached node and keeps a stale rect in the
// mask plan. See /docs/web/sensitive/.
import { sensitiveRegistry } from '@everframe/web';
import type { Directive } from 'vue';

export const vSensitive: Directive<HTMLElement> = {
  mounted(el) {
    sensitiveRegistry.addRef(el);
  },
  unmounted(el) {
    sensitiveRegistry.removeRef(el);
  },
};

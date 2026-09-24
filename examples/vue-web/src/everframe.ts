// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { inject, type InjectionKey, type Ref } from 'vue';
import type { Everframe } from '@everframe/web';

export const EVERFRAME_KEY: InjectionKey<Ref<Everframe | null>> = Symbol('everframe');

/**
 * The handle, or null before App.vue's onMounted has run. A ref rather than
 * the handle itself so a component that renders before mount does not capture
 * a permanent null.
 */
export function useEverframe(): Ref<Everframe | null> {
  const handle = inject(EVERFRAME_KEY);
  if (!handle) throw new Error('useEverframe() called outside the Everframe provider');
  return handle;
}

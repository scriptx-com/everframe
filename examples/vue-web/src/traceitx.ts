// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { inject, type InjectionKey, type Ref } from 'vue';
import type { TraceItXHandle } from '@traceitx/web';

export const TRACEITX_KEY: InjectionKey<Ref<TraceItXHandle | null>> = Symbol('traceitx');

/**
 * The handle, or null before App.vue's onMounted has run. A ref rather than
 * the handle itself so a component that renders before mount does not capture
 * a permanent null.
 */
export function useTraceItX(): Ref<TraceItXHandle | null> {
  const handle = inject(TRACEITX_KEY);
  if (!handle) throw new Error('useTraceItX() called outside the TraceItX provider');
  return handle;
}

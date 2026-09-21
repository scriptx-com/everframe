// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';

/**
 * Escape-key layer stack for the reporter UI.
 *
 * The reporter renders stacked dismissible layers — the reporter modal, the
 * fullscreen annotation overlay on top of it, and the discard-confirm modal on
 * top of that. A single capture-phase `keydown` listener routes Escape to the
 * TOP layer only, then `preventDefault()` + `stopImmediatePropagation()` so the
 * host app's own Escape handlers (and the browser default) never see the event.
 *
 * LIFO semantics give the behaviour we want for free:
 *   - annotation overlay open  → Escape "goes back" to the modal (pops overlay)
 *   - reporter modal only       → Escape closes the modal
 *   - discard-confirm open      → Escape dismisses the confirm first
 *
 * Capture phase + stopImmediatePropagation means we win over host-app listeners
 * registered later on `window`; preventDefault suppresses any browser default.
 */
type EscapeHandler = () => void;

const stack: EscapeHandler[] = [];
let listening = false;

function handleKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (!top) return;
  // Preempt the host app + browser default. stopImmediatePropagation also
  // blocks any other (later-registered) keydown listener on window.
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  try {
    top();
  } catch {
    /* swallow — DEFE-02: a layer's close handler must never throw out here */
  }
}

/**
 * Push an Escape handler onto the top of the layer stack. Returns an
 * unsubscribe function — call it on layer unmount/close. Installs the shared
 * capture listener on first push and removes it when the stack drains.
 */
export function pushEscapeHandler(handler: EscapeHandler): () => void {
  stack.push(handler);
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown, true);
    listening = true;
  }
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const i = stack.lastIndexOf(handler);
    if (i !== -1) stack.splice(i, 1);
    if (stack.length === 0 && listening && typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKeydown, true);
      listening = false;
    }
  };
}

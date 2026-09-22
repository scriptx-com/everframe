// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';

// jsdom 25/29 PointerEvent + hasPointerCapture + scrollIntoView polyfills
// Source: Phase 02.1 plan 10 — admin-spa-screens-and-receiver-contract-PLAN; Radix-style
// primitives (which the reporter modal will use in plan 06) silently bail without these.
if (typeof window !== 'undefined') {
  // PointerEvent polyfill
  if (!(globalThis as Record<string, unknown>).PointerEvent) {
    class PointerEventPolyfill extends MouseEvent {
      public pointerId: number;
      public pointerType: string;
      public isPrimary: boolean;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 1;
        this.pointerType = params.pointerType ?? 'mouse';
        this.isPrimary = params.isPrimary ?? true;
      }
    }
    (globalThis as Record<string, unknown>).PointerEvent = PointerEventPolyfill;
  }

  // hasPointerCapture / setPointerCapture / releasePointerCapture
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
  }

  // scrollIntoView
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }

  // URL.createObjectURL / revokeObjectURL — used by screenshot preview (plan 03 + 06)
  if (!URL.createObjectURL) {
    URL.createObjectURL = (_b: Blob) => `blob:test-${Math.random().toString(36).slice(2)}`;
  }
  if (!URL.revokeObjectURL) {
    URL.revokeObjectURL = (_u: string) => undefined;
  }

  // ResizeObserver shim (used by Tooltip primitive in plan 06)
  if (!(globalThis as Record<string, unknown>).ResizeObserver) {
    (globalThis as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // matchMedia shim (used by prefers-reduced-motion + prefers-color-scheme detection)
  if (!window.matchMedia) {
    window.matchMedia = (q: string) =>
      ({
        matches: false,
        media: q,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
}

// Phase-1 lock — vi.spyOn must be paired with restoreAllMocks afterEach
afterEach(() => {
  vi.restoreAllMocks();
});

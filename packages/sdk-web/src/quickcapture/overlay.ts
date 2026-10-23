// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Real-device quick capture: the matching-number banner and the toasts on a
// TV, in plain DOM (no React, no stylesheet, no shadow root). Lazy chunk only.
//
// One host, `div#everframe-quick-capture`, kept out of every capture path:
// `data-everframe-skip-capture` (screenshot clone filter and TV snapshot) and
// `rr-block` (replay). It is re-appended as the last child of `<body>` on
// every show so it stays above the reporter host, never takes focus, and
// lets every pointer event through. Text goes in through `textContent` only.
import { COPY } from './copy.js';

export interface Overlay {
  showBanner(number: number): void;
  hideBanner(): void;
  toast(text: string): void;
  destroy(): void;
}

export const OVERLAY_HOST_ID = 'everframe-quick-capture';
export const TOAST_MS = 3_000;

const PILL_STYLE: Record<string, string> = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  webkitTransform: 'translateX(-50%)',
  maxWidth: '80%',
  boxSizing: 'border-box',
  padding: '14px 28px',
  borderRadius: '999px',
  background: 'rgba(17, 17, 17, 0.92)',
  color: '#ffffff',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  textAlign: 'center',
  boxShadow: '0 4px 24px rgba(0, 0, 0, 0.35)',
  pointerEvents: 'none',
};

function applyStyle(el: HTMLElement, style: Record<string, string>): void {
  const target = el.style as unknown as Record<string, string>;
  for (const key in style) {
    if (Object.prototype.hasOwnProperty.call(style, key)) target[key] = style[key]!;
  }
}

export function createOverlay(doc?: Document): Overlay {
  const d: Document | null = doc ?? (typeof document !== 'undefined' ? document : null);
  let destroyed = false;
  let host: HTMLDivElement | null = null;
  let banner: HTMLDivElement | null = null;
  let toastEl: HTMLDivElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureHost(): HTMLDivElement | null {
    if (!d) return null;
    if (!host) {
      host = d.createElement('div');
      host.id = OVERLAY_HOST_ID;
      host.setAttribute('data-everframe-skip-capture', 'true');
      host.className = 'rr-block';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      applyStyle(host, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        zIndex: '2147483647',
        pointerEvents: 'none',
        margin: '0',
        padding: '0',
        border: '0',
        background: 'transparent',
      });
    }
    return host;
  }

  /** Re-append as the last child of `<body>`, above anything added since. */
  function raise(): void {
    const h = ensureHost();
    const body = d?.body;
    if (!h || !body) return;
    if (body.lastElementChild !== h) body.appendChild(h);
  }

  function detachIfEmpty(): void {
    if (host && !banner && !toastEl && host.parentNode) {
      host.parentNode.removeChild(host);
    }
  }

  function removeEl(el: HTMLElement | null): void {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function clearToastTimer(): void {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  return {
    showBanner(number: number): void {
      try {
        if (destroyed || !d) return;
        const h = ensureHost();
        if (!h) return;
        removeEl(banner);
        const pill = d.createElement('div');
        applyStyle(pill, { ...PILL_STYLE, top: '5%' });
        const title = d.createElement('div');
        applyStyle(title, { fontSize: '28px', fontWeight: '600', lineHeight: '1.3' });
        title.textContent = COPY.bannerTitle(number);
        const sub = d.createElement('div');
        applyStyle(sub, { fontSize: '18px', lineHeight: '1.4', marginTop: '4px', opacity: '0.85' });
        sub.textContent = COPY.BANNER_SUBLINE;
        pill.appendChild(title);
        pill.appendChild(sub);
        h.appendChild(pill);
        banner = pill;
        raise();
      } catch {
        /* DEFE-02: never throws into the host */
      }
    },

    hideBanner(): void {
      try {
        removeEl(banner);
        banner = null;
        detachIfEmpty();
      } catch {
        /* never throws */
      }
    },

    toast(text: string): void {
      try {
        if (destroyed || !d) return;
        const h = ensureHost();
        if (!h) return;
        clearToastTimer();
        removeEl(toastEl);
        const pill = d.createElement('div');
        applyStyle(pill, { ...PILL_STYLE, bottom: '5%', fontSize: '22px', fontWeight: '500' });
        pill.textContent = String(text);
        h.appendChild(pill);
        toastEl = pill;
        raise();
        toastTimer = setTimeout(() => {
          try {
            toastTimer = null;
            removeEl(toastEl);
            toastEl = null;
            detachIfEmpty();
          } catch {
            /* never throws */
          }
        }, TOAST_MS);
      } catch {
        /* never throws */
      }
    },

    destroy(): void {
      try {
        destroyed = true;
        clearToastTimer();
        removeEl(banner);
        removeEl(toastEl);
        banner = null;
        toastEl = null;
        if (host) removeEl(host);
        host = null;
      } catch {
        /* never throws */
      }
    },
  };
}

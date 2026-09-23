// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

/** Attribute screenshot.ts's `filterNode` uses to drop nodes from a capture. */
const SKIP_CAPTURE_ATTR = 'data-everframe-skip-capture';

export interface HostElement {
  host: HTMLElement;
  /** The shadow root, or the host element itself when shadow DOM is opted out. */
  root: ShadowRoot | HTMLElement;
  remove(): void;
}

/**
 * One tagged host element, with an open shadow root unless `useShadow` is
 * `false`.
 *
 * `data-everframe-skip-capture` on the HOST is the entire capture-exclusion
 * story: `filterNode` drops the host and the whole shadow subtree goes with
 * it, so the reporter never photographs itself. Measured in the spike at 0 of
 * 1,024,000 pixels differing between a clean capture and one taken with the
 * dialog open — strictly better than tagging each portal individually. The
 * tag stays on the host in the light-DOM (opt-out) case too, so capture
 * exclusion doesn't regress for hosts that can't use shadow DOM.
 *
 * `mode: 'open'` rather than `'closed'` so host-page e2e tests and our own
 * support tooling can inspect the tree; nothing about isolation depends on it.
 *
 * `useShadow = false` is the escape hatch for hosts whose tooling cannot
 * pierce shadow roots: `root` becomes the host element itself, so callers
 * render straight into the light DOM. Opting out gives up style isolation, so
 * the stylesheet has to go to the document instead — init() decides that from
 * the same flag.
 */
export function createHostElement(doc: Document = document, useShadow = true): HostElement {
  const host = doc.createElement('div');
  host.id = 'everframe-host';
  host.setAttribute(SKIP_CAPTURE_ATTR, 'true');

  // Codex round-2 finding 4 (P2) — `doc.body` is NULL for a plain,
  // non-deferred `<script>` in `<head>`: the parser has not reached `<body>`
  // yet. Appending unconditionally threw a TypeError out of `init()`, so a
  // host that called it from the head — which is where people put script tags
  // — got a crash instead of a handle.
  //
  // The original reporter was the IIFE script-tag build, which is gone: the
  // no-bundler path is now a `<script type="module">`, and modules are
  // DEFERRED, so `<body>` always exists by the time one runs. This is still
  // load-bearing, for the ESM entry — a bundler is free to emit a blocking
  // classic `<script>` into `<head>` (and any consumer may hand-write one),
  // and `init()` must not be the thing that breaks when it does.
  //
  // `init()` is documented as returning a handle SYNCHRONOUSLY (its callers
  // immediately do `tx.setIdentityToken(...)`, and the microtask-deferred
  // outbox drain is timed against exactly that), so waiting for `<body>`
  // before returning is not an option. Mount into `documentElement` — the one
  // element that always exists once parsing has begun — and RELOCATE into
  // `<body>` the moment the parser creates it. Everything downstream is
  // unaffected either way: the shadow root, the portal target, the branding
  // host and the skip-capture attribute all travel with the element, and
  // `remove()` still just removes it.
  //
  // Relocation is not cosmetic. An element parented to `<html>` sits outside
  // the body box: UA styles, host page CSS scoped under `body`, and stacking
  // against the page's own fixed layers all behave differently there, and it
  // is not where anyone's DOM tooling looks for it.
  let stopWatching: (() => void) | null = null;
  if (doc.body) {
    doc.body.appendChild(host);
  } else {
    doc.documentElement.appendChild(host);
    const relocate = (): void => {
      if (!doc.body) return;
      stopWatching?.();
      // Only if still parented where we put it — a host that moved the
      // element itself keeps it where they put it.
      if (host.parentNode === doc.documentElement) doc.body.appendChild(host);
    };
    // A MutationObserver on `<html>` fires as soon as the parser inserts
    // `<body>`, which is far earlier than DOMContentLoaded (that waits out
    // the whole document, deferred scripts included) — the FAB and any
    // reporter opened in between would otherwise render from outside the body
    // box. DOMContentLoaded is kept as the fallback for an environment with
    // no MutationObserver.
    const observer =
      typeof MutationObserver === 'function' ? new MutationObserver(relocate) : null;
    observer?.observe(doc.documentElement, { childList: true });
    doc.addEventListener('DOMContentLoaded', relocate);
    stopWatching = () => {
      stopWatching = null;
      observer?.disconnect();
      doc.removeEventListener('DOMContentLoaded', relocate);
    };
    // Guard against the body arriving between the null check above and the
    // observer being armed.
    relocate();
  }

  const root = useShadow ? host.attachShadow({ mode: 'open' }) : host;
  return {
    host,
    root,
    // `destroy()` must not leave a live observer (or a DOMContentLoaded
    // listener) behind holding a detached element for the life of the page.
    remove: () => {
      stopWatching?.();
      host.remove();
    },
  };
}

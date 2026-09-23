// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { REPORTER_CSS } from './reporter.css.js';

let injectedTargets = new WeakSet<Document | ShadowRoot>();

/**
 * Inject reporter CSS into target (document or shadow root) with optional CSP nonce.
 * Idempotent — second call with same target is a no-op (Plan 03-06 lock).
 *
 * Per UI-SPEC §"Style Isolation": nonce is set on BOTH the IDL property and the attribute
 * because browsers diverge on which the CSP enforcer reads at insertion time (mirrors the
 * applyNonceToFreshStyles pattern from plan 03-03).
 */
export function injectReporterStyles(target: Document | ShadowRoot, nonce?: string): void {
  if (injectedTargets.has(target)) return;
  // Prefer the target's own document for createElement so shadow-root injections still
  // resolve correctly (createElement on the wrong document yields a HierarchyRequestError).
  const ownerDocument: Document =
    target instanceof Document
      ? target
      : (target.ownerDocument ?? (typeof document !== 'undefined' ? document : (null as unknown as Document)));
  if (!ownerDocument || typeof ownerDocument.createElement !== 'function') return;
  const styleEl = ownerDocument.createElement('style');
  styleEl.dataset['everframeStyles'] = 'reporter';
  if (nonce) {
    styleEl.nonce = nonce;
    styleEl.setAttribute('nonce', nonce);
  }
  styleEl.textContent = REPORTER_CSS;
  const root: Node = target instanceof Document ? target.head : target;
  root.appendChild(styleEl);
  injectedTargets.add(target);
}

export function __resetStyleInjectorForTesting(): void {
  injectedTargets = new WeakSet();
}

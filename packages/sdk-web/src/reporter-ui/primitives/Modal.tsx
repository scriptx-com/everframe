// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
'use client';
import { createPortal } from 'react-dom';
import { useEffect, useRef, type ReactNode, type JSX } from 'react';
import { pushEscapeHandler } from './escapeStack.js';
import { activeElementFor, deepActiveElement } from './active-element.js';
import { useReporterThemeVars } from '../../branding/use-theme-vars.js';
import { resolvePortalTarget } from '../portal-target.js';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
  /** Keeps children mounted (so their state survives) but visually hides the
   * modal — used while the area-capture overlay is up so its escapeStack
   * layer + focus trap don't compete with a hidden dialog underneath. */
  hidden?: boolean;
  /** Narrow confirm-style dialog (400px) instead of the full composer width. */
  compact?: boolean;
  /**
   * Hold the on-open focus move. The dialog still renders; focus simply stays
   * wherever the host page had it until this flips back to `false`, at which
   * point the normal first-interactive-element focus happens.
   *
   * Exists for ONE reason — the screenshot. `captureScreenshot` clones the
   * live DOM and copies each node's COMPUTED style, so whatever is focused at
   * clone time is what the shot shows. Focusing the dialog first blurred the
   * user's element before the clone ran, which cost the report both the focus
   * ring and, far worse, any host-page UI that closes on blur: an open
   * combobox, autocomplete, menu or popover collapsed in the instant between
   * the trigger and the capture, so the exact state the user was trying to
   * report was never in the screenshot. Most visible on the hotkey trigger,
   * where the user's focus is otherwise still perfectly intact when the
   * reporter opens (the FAB's own mousedown has already blurred it).
   *
   * The cost is a short window in which the dialog is up but focus is not in
   * it. ReporterDialog bounds that window — see FOCUS_HOLD_CEILING_MS there.
   */
  deferAutoFocus?: boolean;
}

function focusableElementsIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * Modal primitive — portal + backdrop + focus trap + Esc handler. UI-SPEC §"Reporter modal"
 * focus management contract: on open the first interactive element receives focus; Tab
 * cycles through interactive elements; Esc fires onClose; focus restored to whatever was
 * active before mount.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  labelledBy,
  hidden = false,
  compact = false,
  deferAutoFocus = false,
}: ModalProps): JSX.Element | null {
  const modalRef = useRef<HTMLDivElement | null>(null);
  const titleIdRef = useRef<string>(`txx-modal-title-${Math.random().toString(36).slice(2)}`);
  const titleId = labelledBy ?? titleIdRef.current;
  // Mirror onClose into a ref so the keydown effect doesn't have to depend on it. Without
  // this, the focus-on-open effect re-runs on every parent re-render that produces a new
  // onClose closure (e.g. typing into a sibling input creates a fresh handleClose), which
  // forces focus back to the first input mid-typing.
  const onCloseRef = useRef(onClose);
  /** Guards the focus-in below to once per open transition. */
  const didAutoFocusRef = useRef(false);
  /** What was focused when this open transition began — see the two effects below. */
  const prevActiveRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Snapshot-and-restore — keyed on `open` ALONE so the snapshot is taken once
  // per open transition. Deliberately NOT merged with the focus-in effect
  // below: that one also depends on `deferAutoFocus`, and a shared effect
  // would re-run its cleanup when the hold lifts, firing a spurious
  // focus/blur pair at the host element — the very thing the hold exists to
  // avoid, since that is what collapses a blur-sensitive dropdown.
  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;
    // Codex round-3 finding 5 (P2) — resolved through `deepActiveElement()`,
    // NOT `activeElementFor(modalRef.current)`.
    //
    // The trap below and this line need different resolutions and used to
    // share one. The Tab trap asks "what is focused INSIDE the modal?", so it
    // is right to resolve against the modal's own root. Restore asks "what was
    // focused before we opened?", and that is almost always an element of the
    // HOST PAGE's light DOM — against the reporter's shadow root it resolved
    // to `shadowRoot.activeElement`, i.e. `null`, and closing the vanilla
    // reporter dropped the user's focus on the floor instead of returning it.
    //
    // `deepActiveElement()` is correct in both worlds (see its doc): light-DOM
    // focus resolves to itself, shadow-DOM focus unwraps to the real element.
    const prevActive = deepActiveElement() as HTMLElement | null;
    prevActiveRef.current = prevActive;
    didAutoFocusRef.current = false;
    return () => {
      try {
        prevActive?.focus?.();
      } catch {
        /* swallow — DEFE-02 */
      }
    };
  }, [open]);

  // Focus-in — the first interactive element of the dialog, once the caller
  // stops holding it back (`deferAutoFocus`). `didAutoFocusRef` makes it
  // once-per-open even if the hold flips more than once.
  useEffect(() => {
    if (!open || deferAutoFocus) return;
    if (typeof document === 'undefined') return;
    if (didAutoFocusRef.current) return;
    didAutoFocusRef.current = true;
    // A held focus-in is a LATE focus-in, and by the time the hold lifts the
    // user may have already put focus somewhere deliberately — clicked into
    // the dialog's description field, or back onto the host page. Yanking it
    // to the title input then is the same class of bug this hold exists to
    // fix, only pointed at the user instead of the screenshot. So the move
    // only happens while focus is still exactly where it was when the dialog
    // opened. In the undeferred case this is trivially true (the effect runs
    // in the same commit as the snapshot), so nothing changes there.
    if (deepActiveElement() !== prevActiveRef.current) return;
    queueMicrotask(() => {
      if (!modalRef.current) return;
      const focusable = focusableElementsIn(modalRef.current);
      const target =
        focusable.find((el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ??
        focusable[0];
      target?.focus();
    });
  }, [open, deferAutoFocus]);

  // Escape — routed through the shared layer stack (escapeStack) so the topmost
  // open layer handles it (e.g. the annotation overlay "goes back" instead of
  // this modal closing), and so the host app's own Escape listeners don't also
  // fire (the stack's capture listener preventDefaults + stopImmediatePropagation).
  useEffect(() => {
    if (!open) return;
    return pushEscapeHandler(() => onCloseRef.current());
  }, [open]);

  // Tab-trap keydown listener — uses onCloseRef so it doesn't re-bind on parent re-render.
  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = focusableElementsIn(modalRef.current);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        const active = activeElementFor(modalRef.current);
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Resolved --txx-* theme overrides (branding spec 2026-08-25) — called
  // BEFORE the early return below so hook order stays stable regardless of
  // `open`. {} when unentitled, so the spread below is a no-op by default.
  const themeVars = useReporterThemeVars();

  if (!open) return null;
  const portalTarget = resolvePortalTarget();
  if (!portalTarget) return null;
  return createPortal(
    <div
      className="txx-root"
      data-traceitx-skip-capture="true"
      style={{
        ...(themeVars as import('react').CSSProperties),
        ...(hidden ? { visibility: 'hidden' as const } : {}),
      }}
    >
      <div className="txx-backdrop" onClick={onClose}>
        <div
          ref={modalRef}
          className={compact ? 'txx-modal txx-modal-compact' : 'txx-modal'}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="txx-modal-header">
            <span id={titleId} className="txx-modal-title">
              {title}
            </span>
          </div>
          <div className="txx-modal-body">{children}</div>
          {footer ? <div className="txx-modal-footer">{footer}</div> : null}
        </div>
      </div>
    </div>,
    portalTarget,
  );
}

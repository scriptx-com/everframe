// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
/**
 * Single source of truth for reporter widget CSS. Inlined as a TypeScript template literal
 * to sidestep tsup raw-CSS loader configuration (Plan 03-06 decision: REPORTER_CSS const
 * over `import css from './reporter.css?raw'`).
 *
 * Visual language: the admin "Quiet instrument" pass (Phase 15). Tokens mirror
 * the shared product design tokens plus the amber accent override in
 * the dashboard theme — flat surfaces, tonal depth (bg → bg-2 → bg-3),
 * soft dividers, no glow/lift. OKLCH sources are precomputed to sRGB hex offline because
 * the SDK renders inside arbitrary host pages and must not depend on oklch()/color-mix()
 * support. Native phone modals (Android BrandTokens.kt / iOS BrandTokens.swift) still ship
 * the earlier bento-duo-blue palette; the divergence is intentional until the native
 * quiet-instrument pass lands.
 */
export const REPORTER_CSS = `.txx-root, :host {
  /* Surfaces — admin charcoal-blue ramp (hue 262). Depth comes from the
   * tonal ramp, not cast shadows. */
  --txx-bg: #0D0F13;          /* Bg    — oklch(0.17 0.008 262): inset wells, overlay floor */
  --txx-bg-2: #15171C;        /* Bg2   — oklch(0.205 0.010 262): modal surface */
  --txx-bg-3: #1D2126;        /* Bg3   — oklch(0.245 0.012 262): chips, bars, toasts */
  --txx-surface: #1D2126;     /* elevated panels (area-capture bar, size badge) */
  --txx-border: #303338;      /* Hair  — oklch(0.32 0.010 262) */
  --txx-divider: rgba(241, 245, 252, 0.08);  /* admin --divider-soft */
  --txx-row-hover: rgba(241, 245, 252, 0.04);
  --txx-text: #F1F5FC;        /* Ink   — oklch(0.97 0.010 262) */
  --txx-text-muted: #B6BBC3;  /* Ink2  — oklch(0.79 0.013 262) */
  --txx-text-faint: #81868F;  /* Ink3  — oklch(0.62 0.015 262) */
  --txx-accent: #F2AF48;      /* Accent — amber/gold, oklch(0.80 0.14 75) */
  --txx-accent-hover: #F3B55A;/* accent mixed 8% toward ink (admin primary hover) */
  --txx-accent-2: #F4CA84;    /* lighter gold — pending / warn, oklch(0.86 0.10 80) */
  --txx-accent-fg: #0D0F13;   /* dark text on amber — holds AA */
  --txx-ring: rgba(242, 175, 72, 0.22);        /* soft 3px focus ring */
  --txx-border-focus: rgba(242, 175, 72, 0.45);
  --txx-destructive: #9570FF; /* Hot — oklch(0.66 0.22 290): Discard / Clear */
  --txx-destructive-fg: #ffffff;
  --txx-status-success-bg: rgba(242, 175, 72, 0.12);
  --txx-status-success-fg: #F2AF48;
  --txx-status-warning-bg: rgba(244, 202, 132, 0.14);
  --txx-status-warning-fg: #F4CA84;
  --txx-status-info-bg: rgba(182, 187, 195, 0.12);
  --txx-status-info-fg: #B6BBC3;
  --txx-status-degraded-bg: rgba(244, 202, 132, 0.14);
  --txx-status-degraded-fg: #F4CA84;
  --txx-error: #9570FF;       /* validation == destructive (admin aria-invalid mapping; no red in the palette) */
  --txx-space-xs: 4px;
  --txx-space-sm: 8px;
  --txx-space-md: 16px;
  --txx-space-lg: 24px;
  --txx-space-xl: 32px;
  --txx-space-2xl: 48px;
  /* Inter Variable first — hosts that load the brand font get it for free;
   * everyone else falls back to the system stack. The SDK never fetches fonts. */
  --txx-font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --txx-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --txx-text-body: 14px;
  --txx-text-label: 13px;
  --txx-text-heading: 16px;
  --txx-leading-body: 1.5;
  --txx-leading-label: 1.4;
  --txx-leading-heading: 1.4;
  --txx-weight-regular: 400;
  --txx-weight-medium: 500;
  --txx-weight-semibold: 600;
  --txx-modal-max-width: 780px;
  --txx-modal-min-width: 320px;
  --txx-modal-max-height: calc(100vh - 96px);
  --txx-radius-sm: 4px;
  --txx-radius-md: 8px;       /* controls (admin --radius-control) */
  --txx-radius-lg: 10px;      /* cards / inset panels (admin --radius-card) */
  --txx-radius-modal: 18px;   /* dialog surface (marketing quiet --r-card) */
  --txx-radius-full: 9999px;  /* chips / dots only */
  --txx-z-backdrop: 2147483645;
  --txx-z-modal: 2147483646;
  --txx-z-toast: 2147483647;
  --txx-z-confirm: 2147483647;
  --txx-z-annotate-overlay: 2147483647;
  --txx-z-fab: 2147483644;
  --txx-modal-grad-top: #1B1E24;  /* modal gradient top — bg-2 nudged ~2% lighter */
  --txx-modal-border: rgba(241, 245, 252, 0.1);
  --txx-accent-grad-top: #F5B655;        /* primary button gradient — accent family */
  --txx-accent-grad-bottom: #EFA83D;
  --txx-accent-grad-top-hover: #F7BF69;
  --txx-accent-grad-bottom-hover: #F2AF48;
  --txx-destructive-border: rgba(149, 112, 255, 0.5);
  --txx-destructive-hover-bg: rgba(149, 112, 255, 0.1);
  --txx-destructive-ring: rgba(149, 112, 255, 0.25);
  --txx-accent-glow: rgba(242, 175, 72, 0.2);              /* modal box-shadow accent glow */
  --txx-accent-bg-soft: rgba(242, 175, 72, 0.14);          /* inbox "mine" message tint */
  --txx-destructive-ring-soft: rgba(149, 112, 255, 0.22);  /* validation-error focus ring */
  --txx-destructive-bg-soft: rgba(149, 112, 255, 0.12);    /* error notice bg / hover tint */
  box-sizing: border-box;
  font-family: var(--txx-font-sans);
  color: var(--txx-text);
}
.txx-root *, .txx-root *::before, .txx-root *::after { box-sizing: inherit; }

/* Modal — lit-from-above raised surface (marketing quiet --surface-raised):
 * soft top-lit gradient + inset sheen + deep layered shadow instead of a
 * flat fill with hard borders. Backdrop is a dark glass scrim. */
.txx-backdrop {
  position: fixed; inset: 0; background: rgba(9, 10, 13, 0.7);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: var(--txx-z-backdrop);
  display: flex; align-items: center; justify-content: center;
}
.txx-modal {
  position: relative;
  max-width: var(--txx-modal-max-width); min-width: var(--txx-modal-min-width); width: 100%;
  max-height: var(--txx-modal-max-height);
  background: linear-gradient(180deg, var(--txx-modal-grad-top) 0%, var(--txx-bg-2) 60%);
  border-radius: var(--txx-radius-modal);
  border: 1px solid var(--txx-modal-border);
  box-shadow:
    inset 0 1px 0 rgba(241, 245, 252, 0.06),
    0 40px 90px -24px rgba(0, 0, 0, 0.6),
    0 30px 60px -30px var(--txx-accent-glow);
  z-index: var(--txx-z-modal);
  display: flex; flex-direction: column;
  animation: txx-modal-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes txx-modal-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media (prefers-reduced-motion: reduce) { .txx-modal { animation: none; } }
.txx-modal-compact { max-width: 400px; }
.txx-modal-header {
  padding: 20px var(--txx-space-lg) 0;
  display: flex; align-items: center; justify-content: space-between;
}
.txx-modal-title {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: 15px; font-weight: var(--txx-weight-semibold);
  line-height: var(--txx-leading-heading); letter-spacing: -0.01em;
  color: var(--txx-text);
}
/* Amber diamond — the TraceItX marker. The one brand glyph in the window. */
.txx-modal-title::before {
  content: ""; width: 8px; height: 8px; flex: 0 0 auto;
  border-radius: 2px; background: var(--txx-accent);
  transform: rotate(45deg);
}
.txx-modal-body { padding: 18px var(--txx-space-lg) var(--txx-space-lg); overflow-y: auto; flex: 1 1 auto; }
.txx-modal-footer {
  height: 64px; padding: 0 var(--txx-space-lg);
  display: flex; align-items: center; justify-content: flex-end; gap: var(--txx-space-sm);
  border-top: 1px solid var(--txx-divider);
}

/* Context manifest — footer-left line naming the auto-captured artifacts
 * (console, network, UI state, device info). The quiet counterpart to the
 * removed include-toggles card: web reports always ship full context, so the
 * manifest states what's attached instead of asking. */
.txx-manifest {
  display: inline-flex; align-items: center; gap: var(--txx-space-sm);
  min-width: 0;
  font-size: 12px; line-height: var(--txx-leading-label);
  color: var(--txx-text-faint);
}
.txx-manifest-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.txx-manifest-dot {
  width: 6px; height: 6px; border-radius: var(--txx-radius-full);
  background: var(--txx-accent); flex: 0 0 auto;
  animation: txx-pulse 2.4s ease-in-out infinite;
}
@keyframes txx-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .txx-manifest-dot { animation: none; } }
@media (max-width: 480px) { .txx-manifest { display: none; } }
/* Footer-left group — watermark + manifest share the left slot; the GROUP
 * (not .txx-manifest) owns the margin-right:auto push so either child alone
 * still pins left. */
.txx-footer-left {
  display: inline-flex; align-items: center; gap: var(--txx-space-md);
  margin-right: auto; min-width: 0;
}
/* "Powered by TraceItX" — free-plan watermark (branding spec 2026-08-25).
 * Deliberately NOT hidden under 480px: the manifest hides there, the
 * watermark must stay visible at every width. */
.txx-watermark {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0;
  font-size: 11px; line-height: var(--txx-leading-label);
  color: var(--txx-text-faint); text-decoration: none;
}
.txx-watermark:hover { color: var(--txx-text-muted); }
.txx-watermark-mark { fill: var(--txx-accent); flex: 0 0 auto; }
.txx-watermark span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* Composer — two panes: chromeless fields left, media column right.
 * The dialog is a focused issue composer, not a settings form: no boxed
 * label/input rows, no letterboxed hero well. */
.txx-composer {
  display: grid; grid-template-columns: 320px minmax(0, 1fr);
  gap: var(--txx-space-lg); align-items: start;
}
@media (max-width: 719px) { .txx-composer { grid-template-columns: minmax(0, 1fr); } }
/* Media anchors the left pane; the form stays first in the DOM so the
 * open-focus and tab order start at the title field. */
.txx-composer-form { min-width: 0; order: 2; }
.txx-composer-media { min-width: 0; order: 1; }
.txx-composer-media .txx-annotate-thumb,
.txx-composer-media .txx-capture-pending { margin-bottom: var(--txx-space-sm); }
.txx-composer-media .txx-shot-strip { margin: 0 0 4px; }

/* Chromeless composer fields — labels stay in the DOM for screen readers
 * but are visually hidden; placeholders carry the affordance. The negative
 * margin keeps text flush with the column while giving the keyboard focus
 * ring breathing room. */
.txx-composer-form .txx-field { gap: 0; margin-bottom: var(--txx-space-xs); }
.txx-composer-form .txx-field:first-child {
  border-bottom: 1px solid var(--txx-divider);
  padding-bottom: 4px; margin-bottom: var(--txx-space-sm);
}
.txx-composer-form .txx-field-label {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.txx-composer-form .txx-input, .txx-composer-form .txx-textarea {
  background: transparent; border: none; box-shadow: none;
  border-radius: var(--txx-radius-sm);
  padding: 6px 8px; margin: 0 -8px; width: calc(100% + 16px);
  caret-color: var(--txx-accent);
}
.txx-composer-form .txx-input {
  font-size: 17px; font-weight: var(--txx-weight-semibold); letter-spacing: -0.01em;
}
.txx-composer-form .txx-textarea { min-height: 148px; resize: none; }
.txx-composer-form .txx-input:focus-visible, .txx-composer-form .txx-textarea:focus-visible {
  border: none; box-shadow: 0 0 0 3px var(--txx-ring);
}
.txx-composer-form .txx-input-error { box-shadow: inset 0 -1px 0 var(--txx-error); }
.txx-composer-form .txx-input-error:focus-visible {
  box-shadow: inset 0 -1px 0 var(--txx-error), 0 0 0 3px var(--txx-destructive-ring-soft);
}
.txx-composer-form .txx-helper-error { margin-top: 0; }

/* Buttons — solid amber primary, hairline secondary. Flat: no gradient,
 * no glow, no hover lift (admin [data-variant] overrides). */
.txx-btn {
  display: inline-flex; align-items: center; gap: var(--txx-space-xs);
  height: 36px; padding: 0 var(--txx-space-md);
  border-radius: 10px; border: 1px solid transparent;
  font-size: var(--txx-text-label); font-weight: var(--txx-weight-semibold); line-height: var(--txx-leading-label);
  cursor: pointer; background: transparent; color: var(--txx-text);
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}
.txx-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.txx-btn:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-btn-primary {
  background: linear-gradient(180deg, var(--txx-accent-grad-top) 0%, var(--txx-accent-grad-bottom) 100%);
  color: var(--txx-accent-fg);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.txx-btn-primary:hover:not(:disabled) { background: linear-gradient(180deg, var(--txx-accent-grad-top-hover) 0%, var(--txx-accent-grad-bottom-hover) 100%); }
.txx-btn-primary:focus-visible { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 0 0 3px var(--txx-ring); }
.txx-btn-secondary { border-color: var(--txx-border); color: var(--txx-text); }
.txx-btn-secondary:hover:not(:disabled) { background: var(--txx-row-hover); }
.txx-btn-outline-destructive { border-color: var(--txx-destructive-border); color: var(--txx-destructive); background: transparent; }
.txx-btn-outline-destructive:hover:not(:disabled) { background: var(--txx-destructive-hover-bg); }
.txx-btn-outline-destructive:focus-visible { box-shadow: 0 0 0 3px var(--txx-destructive-ring); }
.txx-btn-icon { width: 32px; height: 32px; padding: 0; justify-content: center; }
.txx-btn-sm { height: 32px; padding: 0 var(--txx-space-sm); }
@media (pointer: coarse) { .txx-btn { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .txx-btn { transition: none; } }

/* Form fields */
.txx-field { display: flex; flex-direction: column; gap: var(--txx-space-xs); margin-bottom: var(--txx-space-md); }
.txx-field-label { font-size: var(--txx-text-label); font-weight: var(--txx-weight-medium); color: var(--txx-text-muted); }
.txx-input, .txx-textarea {
  font: inherit; color: var(--txx-text);
  background: rgba(13, 15, 19, 0.55); /* Bg inset well against the Bg2 surface */
  border: 1px solid var(--txx-border); border-radius: var(--txx-radius-md);
  padding: var(--txx-space-sm) var(--txx-space-md);
  width: 100%;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.txx-input::placeholder, .txx-textarea::placeholder { color: var(--txx-text-faint); }
.txx-input:focus-visible, .txx-textarea:focus-visible {
  outline: 2px solid transparent; outline-offset: 2px;
  border-color: var(--txx-border-focus);
  box-shadow: 0 0 0 3px var(--txx-ring);
}
.txx-input-error { border-color: var(--txx-error); }
.txx-input-error:focus-visible { border-color: var(--txx-error); box-shadow: 0 0 0 3px var(--txx-destructive-ring-soft); }
.txx-helper-error { font-size: var(--txx-text-label); color: var(--txx-error); margin-top: var(--txx-space-xs); }
.txx-textarea { min-height: 72px; resize: vertical; }
@media (prefers-reduced-motion: reduce) { .txx-input, .txx-textarea { transition: none; } }

/* Switch (replaces verb-pair Toggle) — track + thumb */
.txx-switch {
  position: relative;
  width: 36px; height: 20px; flex: 0 0 36px;
  border-radius: var(--txx-radius-full);
  background: var(--txx-border); border: none; padding: 0;
  cursor: pointer; transition: background 150ms ease;
}
.txx-switch:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-switch:disabled { cursor: not-allowed; opacity: 0.7; }
.txx-switch-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: var(--txx-radius-full);
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  transition: transform 150ms ease;
}
.txx-switch-on { background: var(--txx-accent); }
.txx-switch-on .txx-switch-thumb { transform: translateX(16px); }
@media (prefers-reduced-motion: reduce) {
  .txx-switch, .txx-switch-thumb { transition: none; }
}

/* Toast — solid quiet surface with a status dot. Tinted-translucent chips are
 * illegible over arbitrary host pages; the toast floats outside the modal. */
.txx-toast {
  position: fixed; top: 16px; right: 16px;
  padding: var(--txx-space-sm) var(--txx-space-md);
  border-radius: var(--txx-radius-lg);
  max-width: 400px;
  z-index: var(--txx-z-toast);
  display: inline-flex; align-items: center; gap: var(--txx-space-sm);
  background: var(--txx-bg-3); color: var(--txx-text);
  border: 1px solid var(--txx-border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.28);
  animation: txx-toast-in 200ms cubic-bezier(0.22, 1, 0.36, 1);
  cursor: pointer;
}
@keyframes txx-toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .txx-toast { animation: none; } }
.txx-toast::before {
  content: ""; width: 8px; height: 8px; border-radius: var(--txx-radius-full);
  flex: 0 0 auto; background: var(--txx-text-faint);
}
.txx-toast-success::before { background: var(--txx-accent); }
.txx-toast-warning::before { background: var(--txx-accent-2); }
.txx-toast-error::before { background: var(--txx-destructive); }
.txx-toast-info::before { background: var(--txx-text-faint); }

/* Notice strip */
.txx-notice { display: flex; align-items: flex-start; gap: var(--txx-space-sm); padding: var(--txx-space-sm) var(--txx-space-md); border-radius: var(--txx-radius-md); }
.txx-notice-degraded { background: var(--txx-status-degraded-bg); color: var(--txx-status-degraded-fg); }
.txx-notice-error { background: var(--txx-destructive-bg-soft); color: var(--txx-destructive); }

/* Capture stage (in-modal launcher for the fullscreen overlay) — a FIXED
 * height dotted canvas the screenshot floats on, like a design-tool
 * artboard. Fixed height keeps the modal geometry stable no matter which
 * screenshot is selected (portrait crop, landscape page, tiny area grab).
 * Annotation itself happens in the fullscreen editor. */
.txx-annotate-thumb {
  position: relative; display: block; width: 100%; height: 240px;
  border: 1px solid rgba(241, 245, 252, 0.06); border-radius: 12px;
  background-color: var(--txx-bg);
  background-image: radial-gradient(rgba(241, 245, 252, 0.07) 1px, transparent 1px);
  background-size: 14px 14px;
  padding: 0; cursor: pointer; overflow: hidden;
  margin-bottom: var(--txx-space-md);
}
.txx-annotate-thumb:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-annotate-thumb:hover .txx-annotate-thumb-overlay { background: rgba(0,0,0,0.65); }
.txx-annotate-thumb-img {
  position: absolute; inset: 14px;
  width: calc(100% - 28px); height: calc(100% - 28px);
  object-fit: contain;
  filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.55));
}
/* Waiting state shares the stage geometry so capture completing doesn't
 * reflow the modal. */
.txx-capture-pending {
  display: flex; align-items: center; justify-content: center;
  height: 240px; margin: 0 0 var(--txx-space-md);
  border: 1px solid rgba(241, 245, 252, 0.06); border-radius: 12px;
  background-color: var(--txx-bg);
  background-image: radial-gradient(rgba(241, 245, 252, 0.07) 1px, transparent 1px);
  background-size: 14px 14px;
  color: var(--txx-text-muted); font-size: var(--txx-text-label);
}
.txx-annotate-thumb-overlay {
  position: absolute; inset: 0; display: inline-flex; align-items: center; justify-content: center;
  gap: var(--txx-space-sm);
  background: rgba(0,0,0,0.45); color: #fff;
  font-size: var(--txx-text-label); font-weight: var(--txx-weight-semibold);
  opacity: 0; transition: opacity 150ms ease;
}
.txx-annotate-thumb:hover .txx-annotate-thumb-overlay,
.txx-annotate-thumb:focus-visible .txx-annotate-thumb-overlay { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .txx-annotate-thumb-overlay { transition: none; } }

/* Fullscreen annotate overlay — rendered inside .txx-root, so tokens resolve.
 * Quiet-instrument treatment: flat Bg floor, sentence-case sans bar label
 * (mono-uppercase eyebrow retired with the admin restyle), amber Done, and a
 * neutral-shadow canvas frame instead of the old cyan glow. */
.txx-annotate-overlay {
  position: fixed; inset: 0; z-index: var(--txx-z-annotate-overlay);
  background: var(--txx-bg); color: var(--txx-text);
  display: flex; flex-direction: column;
}
.txx-annotate-overlay-bar {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  padding: 14px 14px 14px;
  padding-top: max(env(safe-area-inset-top, 0px), 14px);
}
.txx-annotate-overlay-bar-left { justify-self: start; }
.txx-annotate-overlay-bar-center {
  font-size: var(--txx-text-label); font-weight: var(--txx-weight-medium);
  color: var(--txx-text-muted);
}
.txx-annotate-overlay-bar-right { justify-self: end; }
.txx-annotate-cancel {
  background: transparent; border: none; padding: 6px 0;
  color: var(--txx-text-muted); font-size: 15px; font: inherit; cursor: pointer;
}
.txx-annotate-cancel:hover { color: var(--txx-text); }
.txx-annotate-cancel:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--txx-ring); border-radius: var(--txx-radius-sm); }
.txx-annotate-done {
  display: inline-flex; align-items: center;
  background: linear-gradient(180deg, var(--txx-accent-grad-top) 0%, var(--txx-accent-grad-bottom) 100%);
  color: var(--txx-accent-fg); border: none;
  padding: 8px 16px; border-radius: 10px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
  font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background 150ms ease;
}
.txx-annotate-done:hover { background: linear-gradient(180deg, var(--txx-accent-grad-top-hover) 0%, var(--txx-accent-grad-bottom-hover) 100%); }
.txx-annotate-done:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-annotate-overlay-stage {
  flex: 1 1 auto; min-height: 0;
  padding: 0 14px 22px;
  overflow: auto;
  display: flex; flex-direction: column; align-items: center;
  gap: 14px;
}
/* Canvas frame: white surface, hairline border, neutral ambient shadow —
 * the screenshot is the subject; the frame stays quiet. */
.txx-annotate-canvas-frame {
  border-radius: var(--txx-radius-lg);
  border: 1px solid var(--txx-border);
  background: #FFFFFF;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28), 0 24px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  display: flex; flex-direction: column; align-items: center;
}

/* Bottom palette bar — sits below the canvas. Bg3 surface, hairline border,
 * calm rounded-rect (the 22px pill went with the bento look). Active tool is
 * a solid amber chip with dark glyph. */
.txx-annotation-toolbar {
  display: inline-flex; gap: 8px; padding: 10px 12px;
  background: rgba(29, 33, 38, 0.94); /* Bg3 alpha */
  border: 1px solid var(--txx-border);
  border-radius: 12px;
  flex-wrap: wrap; justify-content: center; align-items: center;
}
.txx-annotation-subtoolbar {
  display: inline-flex; gap: 8px; padding: 8px 12px;
  background: rgba(29, 33, 38, 0.94);
  border: 1px solid var(--txx-border);
  border-radius: 10px;
  flex-wrap: wrap; justify-content: center; align-items: center;
}
.txx-palette-sep {
  width: 1px; height: 20px; background: rgba(241, 245, 252, 0.1);
  flex: 0 0 auto;
}
.txx-tool-btn {
  width: 36px; height: 36px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--txx-text);
  border: none; border-radius: var(--txx-radius-full); cursor: pointer;
}
.txx-tool-btn:hover { background: rgba(241, 245, 252, 0.06); }
.txx-tool-btn:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-tool-btn:disabled { color: rgba(129, 134, 143, 0.5); cursor: not-allowed; }
.txx-tool-btn:disabled:hover { background: transparent; }
.txx-tool-btn-active { background: var(--txx-accent); color: var(--txx-accent-fg); }
.txx-tool-btn-active:hover { background: var(--txx-accent); }
.txx-tool-glyph {
  display: inline-block; line-height: 1; font-size: 18px; font-weight: 500;
  font-feature-settings: "ss01" 0, "calt" 0;
}
.txx-tool-clear {
  background: transparent; border: none; padding: 6px 10px;
  color: var(--txx-destructive); font: inherit; font-size: 14px; cursor: pointer;
  border-radius: var(--txx-radius-md);
}
.txx-tool-clear:hover { background: var(--txx-destructive-bg-soft); }
.txx-tool-clear:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--txx-destructive-ring); }
.txx-swatch {
  width: 28px; height: 28px; border-radius: var(--txx-radius-full);
  border: 1px solid rgba(241, 245, 252, 0.18); cursor: pointer; padding: 0;
  flex: 0 0 auto;
}
/* Ink ring, not amber — an amber selection ring would collide with warm
 * swatch colors and misread as "this swatch is amber". */
.txx-swatch-selected { outline: 2px solid var(--txx-text); outline-offset: 1px; }
.txx-thickness {
  min-width: 32px; height: 28px; padding: 0 var(--txx-space-xs);
  border: 1px solid rgba(241, 245, 252, 0.18); border-radius: 6px;
  background: transparent; color: var(--txx-text); cursor: pointer; font-size: 12px;
  flex: 0 0 auto;
}
.txx-thickness-selected { outline: 2px solid var(--txx-accent); outline-offset: 1px; }
@media (pointer: coarse) {
  .txx-tool-btn { width: 44px; height: 44px; }
  .txx-swatch { width: 32px; height: 32px; }
  .txx-thickness { min-width: 36px; height: 32px; font-size: 13px; }
}

/* "Include in this report" section — single card with toggle rows, no
 * preview body. Mirrors Android IncludeCard.kt and iOS IncludeCard.
 * No expander, no chevron, no per-row preview: the count chip is the
 * only context the user needs; previews live in admin downstream. */
.txx-include-label {
  display: block;
  font-family: var(--txx-font-mono);
  font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--txx-text-faint); font-weight: 500;
  padding: 4px;
  margin-top: var(--txx-space-md);
}
.txx-include-card {
  background: rgba(29, 33, 38, 0.5); /* Bg3 alpha 0.5 */
  border: 1px solid var(--txx-border);
  border-radius: var(--txx-radius-lg);
  overflow: hidden;
}
.txx-include-row {
  display: flex; align-items: center; gap: var(--txx-space-sm);
  width: 100%;
  padding: 12px 14px;
  background: transparent;
  color: var(--txx-text); text-align: left;
}
.txx-include-row + .txx-include-row { border-top: 1px solid var(--txx-divider); }
.txx-include-row-name {
  flex: 1 1 auto; font-size: 14.5px; font-weight: 500; color: var(--txx-text);
}
.txx-include-row-count {
  display: inline-flex; align-items: center;
  padding: 3px 8px; border-radius: var(--txx-radius-full);
  background: rgba(13, 15, 19, 0.6);
  border: 1px solid var(--txx-border);
  color: var(--txx-text-faint);
  font-family: var(--txx-font-mono); font-size: 11px;
  margin-right: 4px;
}
.txx-canvas-loading { padding: var(--txx-space-lg); color: var(--txx-text-muted); font-size: var(--txx-text-label); }

.txx-text-editor {
  position: absolute;
  min-width: 80px;
  min-height: 1.4em;
  padding: 0;
  margin: 0;
  background: transparent;
  border: 1px dashed var(--txx-accent);
  outline: none;
  resize: none;
  overflow: hidden;
  white-space: pre;
  z-index: 3;
}

.txx-shot-strip {
  display: flex;
  gap: 8px;
  align-items: stretch;
  margin: 10px 0 4px;
  overflow-x: auto;
  padding: 2px;
}
.txx-shot-thumb {
  position: relative;
  flex: 0 0 auto;
  border: 1px solid rgba(241, 245, 252, 0.1);
  border-radius: 10px;
  overflow: hidden;
}
.txx-shot-thumb-active {
  border-color: var(--txx-accent);
  box-shadow: 0 0 0 1px var(--txx-accent);
}
.txx-shot-thumb-btn {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  width: 84px;
  height: 56px;
}
.txx-shot-thumb-btn:focus-visible { outline: 2px solid transparent; box-shadow: inset 0 0 0 2px var(--txx-border-focus); }
.txx-shot-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.txx-shot-delete {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  line-height: 16px;
  border-radius: 50%;
  border: 0;
  background: rgba(13, 15, 19, 0.75);
  color: var(--txx-text);
  cursor: pointer;
  font-size: 13px;
}
.txx-shot-delete:hover { background: var(--txx-destructive); }
.txx-shot-delete:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 2px var(--txx-ring); }
.txx-shot-add {
  flex: 0 0 auto;
  width: 84px;
  height: 58px;
  border: 1px dashed rgba(241, 245, 252, 0.16);
  border-radius: 10px;
  background: none;
  color: var(--txx-text-faint);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.txx-shot-add:hover:not(:disabled) { border-color: var(--txx-border-focus); color: var(--txx-accent); }
.txx-shot-add:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-shot-add:disabled { opacity: 0.5; cursor: default; }
.txx-shot-add-label { font-size: 11px; }

/* user-select: none is not cosmetic here, and it matters more than it does on
   our own surfaces: this overlay is a sibling of the HOST page's DOM, not a
   separate document, so a drag that anchors a native text selection extends
   through the customer's own content — and gets painted in whatever colour
   THEIR ::selection rule uses. The selection then outlives the gesture (it
   persists until something clears it), leaving their app looking washed in a
   colour with no cue that a selection is involved. The -webkit- prefix is
   included because this ships into third-party pages, so it cannot assume a
   modern engine the way an app we build and target ourselves can.

   NB: no backticks anywhere in this file — the whole stylesheet is one TS
   template literal, and a stray backtick in a CSS comment terminates it. */
.txx-area-capture {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  cursor: crosshair;
  background: rgba(13, 15, 19, 0.35);
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.txx-area-capture-bar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: center;
  background: var(--txx-surface);
  border: 1px solid var(--txx-border);
  border-radius: var(--txx-radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  padding: 8px 12px;
  cursor: default;
}
.txx-area-capture-hint { color: var(--txx-text-muted); font-size: 12px; }
.txx-area-capture-btn {
  border: 1px solid var(--txx-border);
  background: var(--txx-bg-2);
  color: var(--txx-text);
  border-radius: var(--txx-radius-md);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.txx-area-capture-btn:hover { border-color: var(--txx-border-focus); }
.txx-area-capture-btn:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-area-capture-selection {
  position: absolute;
  border: 1.5px dashed var(--txx-accent);
  /* The huge shadow re-dims everything OUTSIDE the selection while the
     selection itself shows the page at full brightness. */
  box-shadow: 0 0 0 100vmax rgba(13, 15, 19, 0.5);
  pointer-events: none;
}
.txx-area-capture-size {
  position: absolute;
  right: 0;
  bottom: -22px;
  background: var(--txx-surface);
  color: var(--txx-text);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--txx-border);
}

/* Reporter FAB — the feature's entire ambient footprint: a small floating
 * button with an unread dot. Sits BELOW the backdrop z-index so any open
 * modal covers it. */
.txx-fab-wrap { position: fixed; right: 16px; bottom: 16px; z-index: var(--txx-z-fab); }
.txx-fab {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; border-radius: var(--txx-radius-full);
  background: var(--txx-accent); color: var(--txx-accent-fg);
  border: 1px solid var(--txx-border); cursor: pointer; position: relative;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.txx-fab:focus-visible { outline: 2px solid var(--txx-ring); outline-offset: 2px; }
.txx-fab-dot {
  position: absolute; top: -2px; right: -2px; width: 12px; height: 12px;
  border-radius: var(--txx-radius-full); background: var(--txx-destructive);
  border: 2px solid var(--txx-bg);
}

/* Inbox — "Your reports" thread list (Task 10) + thread detail (Task 11).
 * Rows are plain buttons (full-width, left-aligned) so the whole row is one
 * hit target and the list stays keyboard-navigable without extra tabindex
 * plumbing. */
.txx-inbox-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; }
.txx-inbox-list > li { margin: 0; padding: 0; }
.txx-inbox-list > li + li { border-top: 1px solid var(--txx-divider); }
.txx-inbox-row {
  display: flex; align-items: center; gap: var(--txx-space-sm);
  width: 100%;
  padding: 12px 4px;
  background: transparent; border: none;
  color: var(--txx-text); text-align: left;
  font-family: inherit; font-size: var(--txx-text-body);
  cursor: pointer;
}
.txx-inbox-row:hover { background: var(--txx-bg-2); }
.txx-inbox-row:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--txx-ring); }
.txx-inbox-row-title {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-weight: var(--txx-weight-medium);
}
.txx-inbox-chip {
  flex: 0 0 auto;
  display: inline-flex; align-items: center;
  padding: 3px 8px; border-radius: var(--txx-radius-full);
  font-size: 11px; font-weight: var(--txx-weight-medium);
}
.txx-inbox-chip-open { background: var(--txx-status-success-bg); color: var(--txx-status-success-fg); }
.txx-inbox-chip-closed { background: var(--txx-status-info-bg); color: var(--txx-status-info-fg); }
.txx-inbox-unread-dot {
  flex: 0 0 auto; width: 8px; height: 8px;
  border-radius: var(--txx-radius-full); background: var(--txx-accent);
}
.txx-inbox-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--txx-space-md);
  padding: var(--txx-space-xl);
  text-align: center;
  color: var(--txx-text-muted);
}
.txx-inbox-loading { padding: var(--txx-space-lg); color: var(--txx-text-muted); font-size: var(--txx-text-label); }

/* Inbox — thread detail (Task 11): messages + composer + optimistic states. */
.txx-inbox-thread { display: flex; flex-direction: column; gap: var(--txx-space-md); }
.txx-inbox-back {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: var(--txx-space-xs);
  background: transparent; border: none; cursor: pointer;
  color: var(--txx-text-muted); font-family: inherit; font-size: var(--txx-text-label);
  padding: 2px 0;
}
.txx-inbox-back:hover { color: var(--txx-text); }
.txx-inbox-back:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--txx-ring); border-radius: var(--txx-radius-sm); }
.txx-inbox-truncated-notice {
  margin: 0; padding-bottom: var(--txx-space-xs);
  text-align: center; color: var(--txx-text-faint); font-size: var(--txx-text-label);
}
.txx-inbox-msgs {
  display: flex; flex-direction: column; gap: var(--txx-space-sm);
  overflow-y: auto;
  min-height: 160px; max-height: 360px;
  padding: 2px;
}
.txx-inbox-msg {
  max-width: 80%;
  padding: var(--txx-space-sm) var(--txx-space-md);
  border-radius: var(--txx-radius-lg);
  display: flex; flex-direction: column; gap: 2px;
}
.txx-inbox-msg-theirs { align-self: flex-start; background: var(--txx-bg-2); }
/* Accent tint (--txx-accent-bg-soft), same family as --txx-ring/--txx-status-success-bg. */
.txx-inbox-msg-mine { align-self: flex-end; background: var(--txx-accent-bg-soft); }
.txx-inbox-msg-author { font-size: 12px; font-weight: var(--txx-weight-medium); color: var(--txx-text-muted); }
.txx-inbox-msg-body {
  margin: 0; font-size: var(--txx-text-body); line-height: var(--txx-leading-body);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.txx-inbox-msg-time { font-size: 11px; color: var(--txx-text-faint); }
.txx-inbox-pending { opacity: 0.75; }
.txx-inbox-composer {
  display: flex; flex-direction: column; gap: var(--txx-space-sm);
  border-top: 1px solid var(--txx-divider); padding-top: var(--txx-space-md);
}
.txx-inbox-composer > .txx-btn { align-self: flex-end; }
.txx-inbox-cooldown { margin: 0; font-size: var(--txx-text-label); color: var(--txx-status-warning-fg); }
.txx-inbox-closed-notice {
  margin: 0; padding: var(--txx-space-md) 0; text-align: center;
  border-top: 1px solid var(--txx-divider);
  color: var(--txx-text-muted); font-size: var(--txx-text-label);
}
.txx-inbox-delete-error { margin: 0; font-size: var(--txx-text-label); color: var(--txx-error); }
.txx-inbox-thread-actions {
  display: flex; justify-content: space-between; gap: var(--txx-space-sm);
  padding-top: var(--txx-space-sm);
}
` as const;

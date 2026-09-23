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
export const REPORTER_CSS = `.everframe-root, :host {
  /* Surfaces — admin charcoal-blue ramp (hue 262). Depth comes from the
   * tonal ramp, not cast shadows. */
  --everframe-bg: #0D0F13;          /* Bg    — oklch(0.17 0.008 262): inset wells, overlay floor */
  --everframe-bg-2: #15171C;        /* Bg2   — oklch(0.205 0.010 262): modal surface */
  --everframe-bg-3: #1D2126;        /* Bg3   — oklch(0.245 0.012 262): chips, bars, toasts */
  --everframe-surface: #1D2126;     /* elevated panels (area-capture bar, size badge) */
  --everframe-border: #303338;      /* Hair  — oklch(0.32 0.010 262) */
  --everframe-divider: rgba(241, 245, 252, 0.08);  /* admin --divider-soft */
  --everframe-row-hover: rgba(241, 245, 252, 0.04);
  --everframe-text: #F1F5FC;        /* Ink   — oklch(0.97 0.010 262) */
  --everframe-text-muted: #B6BBC3;  /* Ink2  — oklch(0.79 0.013 262) */
  --everframe-text-faint: #81868F;  /* Ink3  — oklch(0.62 0.015 262) */
  --everframe-accent: #F2AF48;      /* Accent — amber/gold, oklch(0.80 0.14 75) */
  --everframe-accent-hover: #F3B55A;/* accent mixed 8% toward ink (admin primary hover) */
  --everframe-accent-2: #F4CA84;    /* lighter gold — pending / warn, oklch(0.86 0.10 80) */
  --everframe-accent-fg: #0D0F13;   /* dark text on amber — holds AA */
  --everframe-ring: rgba(242, 175, 72, 0.22);        /* soft 3px focus ring */
  --everframe-border-focus: rgba(242, 175, 72, 0.45);
  --everframe-destructive: #9570FF; /* Hot — oklch(0.66 0.22 290): Discard / Clear */
  --everframe-destructive-fg: #ffffff;
  --everframe-status-success-bg: rgba(242, 175, 72, 0.12);
  --everframe-status-success-fg: #F2AF48;
  --everframe-status-warning-bg: rgba(244, 202, 132, 0.14);
  --everframe-status-warning-fg: #F4CA84;
  --everframe-status-info-bg: rgba(182, 187, 195, 0.12);
  --everframe-status-info-fg: #B6BBC3;
  --everframe-status-degraded-bg: rgba(244, 202, 132, 0.14);
  --everframe-status-degraded-fg: #F4CA84;
  --everframe-error: #9570FF;       /* validation == destructive (admin aria-invalid mapping; no red in the palette) */
  --everframe-space-xs: 4px;
  --everframe-space-sm: 8px;
  --everframe-space-md: 16px;
  --everframe-space-lg: 24px;
  --everframe-space-xl: 32px;
  --everframe-space-2xl: 48px;
  /* Inter Variable first — hosts that load the brand font get it for free;
   * everyone else falls back to the system stack. The SDK never fetches fonts. */
  --everframe-font-sans: "Inter Variable", "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --everframe-font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --everframe-text-body: 14px;
  --everframe-text-label: 13px;
  --everframe-text-heading: 16px;
  --everframe-leading-body: 1.5;
  --everframe-leading-label: 1.4;
  --everframe-leading-heading: 1.4;
  --everframe-weight-regular: 400;
  --everframe-weight-medium: 500;
  --everframe-weight-semibold: 600;
  --everframe-modal-max-width: 780px;
  --everframe-modal-min-width: 320px;
  --everframe-modal-max-height: calc(100vh - 96px);
  --everframe-radius-sm: 4px;
  --everframe-radius-md: 8px;       /* controls (admin --radius-control) */
  --everframe-radius-lg: 10px;      /* cards / inset panels (admin --radius-card) */
  --everframe-radius-modal: 18px;   /* dialog surface (marketing quiet --r-card) */
  --everframe-radius-full: 9999px;  /* chips / dots only */
  --everframe-z-backdrop: 2147483645;
  --everframe-z-modal: 2147483646;
  --everframe-z-toast: 2147483647;
  --everframe-z-confirm: 2147483647;
  --everframe-z-annotate-overlay: 2147483647;
  --everframe-z-fab: 2147483644;
  --everframe-modal-grad-top: #1B1E24;  /* modal gradient top — bg-2 nudged ~2% lighter */
  --everframe-modal-border: rgba(241, 245, 252, 0.1);
  --everframe-accent-grad-top: #F5B655;        /* primary button gradient — accent family */
  --everframe-accent-grad-bottom: #EFA83D;
  --everframe-accent-grad-top-hover: #F7BF69;
  --everframe-accent-grad-bottom-hover: #F2AF48;
  --everframe-destructive-border: rgba(149, 112, 255, 0.5);
  --everframe-destructive-hover-bg: rgba(149, 112, 255, 0.1);
  --everframe-destructive-ring: rgba(149, 112, 255, 0.25);
  --everframe-accent-glow: rgba(242, 175, 72, 0.2);              /* modal box-shadow accent glow */
  --everframe-accent-bg-soft: rgba(242, 175, 72, 0.14);          /* inbox "mine" message tint */
  --everframe-destructive-ring-soft: rgba(149, 112, 255, 0.22);  /* validation-error focus ring */
  --everframe-destructive-bg-soft: rgba(149, 112, 255, 0.12);    /* error notice bg / hover tint */
  box-sizing: border-box;
  font-family: var(--everframe-font-sans);
  color: var(--everframe-text);
}
.everframe-root *, .everframe-root *::before, .everframe-root *::after { box-sizing: inherit; }

/* Modal — lit-from-above raised surface (marketing quiet --surface-raised):
 * soft top-lit gradient + inset sheen + deep layered shadow instead of a
 * flat fill with hard borders. Backdrop is a dark glass scrim. */
.everframe-backdrop {
  position: fixed; inset: 0; background: rgba(9, 10, 13, 0.7);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: var(--everframe-z-backdrop);
  display: flex; align-items: center; justify-content: center;
}
.everframe-modal {
  position: relative;
  max-width: var(--everframe-modal-max-width); min-width: var(--everframe-modal-min-width); width: 100%;
  max-height: var(--everframe-modal-max-height);
  background: linear-gradient(180deg, var(--everframe-modal-grad-top) 0%, var(--everframe-bg-2) 60%);
  border-radius: var(--everframe-radius-modal);
  border: 1px solid var(--everframe-modal-border);
  box-shadow:
    inset 0 1px 0 rgba(241, 245, 252, 0.06),
    0 40px 90px -24px rgba(0, 0, 0, 0.6),
    0 30px 60px -30px var(--everframe-accent-glow);
  z-index: var(--everframe-z-modal);
  display: flex; flex-direction: column;
  animation: everframe-modal-in 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes everframe-modal-in { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@media (prefers-reduced-motion: reduce) { .everframe-modal { animation: none; } }
.everframe-modal-compact { max-width: 400px; }
.everframe-modal-header {
  padding: 20px var(--everframe-space-lg) 0;
  display: flex; align-items: center; justify-content: space-between;
}
.everframe-modal-title {
  display: inline-flex; align-items: center; gap: 10px;
  font-size: 15px; font-weight: var(--everframe-weight-semibold);
  line-height: var(--everframe-leading-heading); letter-spacing: -0.01em;
  color: var(--everframe-text);
}
/* Amber diamond — the Everframe marker. The one brand glyph in the window. */
.everframe-modal-title::before {
  content: ""; width: 8px; height: 8px; flex: 0 0 auto;
  border-radius: 2px; background: var(--everframe-accent);
  transform: rotate(45deg);
}
.everframe-modal-body { padding: 18px var(--everframe-space-lg) var(--everframe-space-lg); overflow-y: auto; flex: 1 1 auto; }
.everframe-modal-footer {
  height: 64px; padding: 0 var(--everframe-space-lg);
  display: flex; align-items: center; justify-content: flex-end; gap: var(--everframe-space-sm);
  border-top: 1px solid var(--everframe-divider);
}

/* Context manifest — footer-left line naming the auto-captured artifacts
 * (console, network, UI state, device info). The quiet counterpart to the
 * removed include-toggles card: web reports always ship full context, so the
 * manifest states what's attached instead of asking. */
.everframe-manifest {
  display: inline-flex; align-items: center; gap: var(--everframe-space-sm);
  min-width: 0;
  font-size: 12px; line-height: var(--everframe-leading-label);
  color: var(--everframe-text-faint);
}
.everframe-manifest-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.everframe-manifest-dot {
  width: 6px; height: 6px; border-radius: var(--everframe-radius-full);
  background: var(--everframe-accent); flex: 0 0 auto;
  animation: everframe-pulse 2.4s ease-in-out infinite;
}
@keyframes everframe-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .everframe-manifest-dot { animation: none; } }
@media (max-width: 480px) { .everframe-manifest { display: none; } }
/* Footer-left group — watermark + manifest share the left slot; the GROUP
 * (not .everframe-manifest) owns the margin-right:auto push so either child alone
 * still pins left. */
.everframe-footer-left {
  display: inline-flex; align-items: center; gap: var(--everframe-space-md);
  margin-right: auto; min-width: 0;
}
/* "Powered by Everframe" — free-plan watermark (branding spec 2026-08-25).
 * Deliberately NOT hidden under 480px: the manifest hides there, the
 * watermark must stay visible at every width. */
.everframe-watermark {
  display: inline-flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0;
  font-size: 11px; line-height: var(--everframe-leading-label);
  color: var(--everframe-text-faint); text-decoration: none;
}
.everframe-watermark:hover { color: var(--everframe-text-muted); }
.everframe-watermark-mark { fill: var(--everframe-accent); flex: 0 0 auto; }
.everframe-watermark span { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

/* Composer — two panes: chromeless fields left, media column right.
 * The dialog is a focused issue composer, not a settings form: no boxed
 * label/input rows, no letterboxed hero well. */
.everframe-composer {
  display: grid; grid-template-columns: 320px minmax(0, 1fr);
  gap: var(--everframe-space-lg); align-items: start;
}
@media (max-width: 719px) { .everframe-composer { grid-template-columns: minmax(0, 1fr); } }
/* Media anchors the left pane; the form stays first in the DOM so the
 * open-focus and tab order start at the title field. */
.everframe-composer-form { min-width: 0; order: 2; }
.everframe-composer-media { min-width: 0; order: 1; }
.everframe-composer-media .everframe-annotate-thumb,
.everframe-composer-media .everframe-capture-pending { margin-bottom: var(--everframe-space-sm); }
.everframe-composer-media .everframe-shot-strip { margin: 0 0 4px; }

/* Chromeless composer fields — labels stay in the DOM for screen readers
 * but are visually hidden; placeholders carry the affordance. The negative
 * margin keeps text flush with the column while giving the keyboard focus
 * ring breathing room. */
.everframe-composer-form .everframe-field { gap: 0; margin-bottom: var(--everframe-space-xs); }
.everframe-composer-form .everframe-field:first-child {
  border-bottom: 1px solid var(--everframe-divider);
  padding-bottom: 4px; margin-bottom: var(--everframe-space-sm);
}
.everframe-composer-form .everframe-field-label {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.everframe-composer-form .everframe-input, .everframe-composer-form .everframe-textarea {
  background: transparent; border: none; box-shadow: none;
  border-radius: var(--everframe-radius-sm);
  padding: 6px 8px; margin: 0 -8px; width: calc(100% + 16px);
  caret-color: var(--everframe-accent);
}
.everframe-composer-form .everframe-input {
  font-size: 17px; font-weight: var(--everframe-weight-semibold); letter-spacing: -0.01em;
}
.everframe-composer-form .everframe-textarea { min-height: 148px; resize: none; }
.everframe-composer-form .everframe-input:focus-visible, .everframe-composer-form .everframe-textarea:focus-visible {
  border: none; box-shadow: 0 0 0 3px var(--everframe-ring);
}
.everframe-composer-form .everframe-input-error { box-shadow: inset 0 -1px 0 var(--everframe-error); }
.everframe-composer-form .everframe-input-error:focus-visible {
  box-shadow: inset 0 -1px 0 var(--everframe-error), 0 0 0 3px var(--everframe-destructive-ring-soft);
}
.everframe-composer-form .everframe-helper-error { margin-top: 0; }

/* Buttons — solid amber primary, hairline secondary. Flat: no gradient,
 * no glow, no hover lift (admin [data-variant] overrides). */
.everframe-btn {
  display: inline-flex; align-items: center; gap: var(--everframe-space-xs);
  height: 36px; padding: 0 var(--everframe-space-md);
  border-radius: 10px; border: 1px solid transparent;
  font-size: var(--everframe-text-label); font-weight: var(--everframe-weight-semibold); line-height: var(--everframe-leading-label);
  cursor: pointer; background: transparent; color: var(--everframe-text);
  transition: background 150ms ease, border-color 150ms ease, color 150ms ease, box-shadow 150ms ease;
}
.everframe-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.everframe-btn:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-btn-primary {
  background: linear-gradient(180deg, var(--everframe-accent-grad-top) 0%, var(--everframe-accent-grad-bottom) 100%);
  color: var(--everframe-accent-fg);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.everframe-btn-primary:hover:not(:disabled) { background: linear-gradient(180deg, var(--everframe-accent-grad-top-hover) 0%, var(--everframe-accent-grad-bottom-hover) 100%); }
.everframe-btn-primary:focus-visible { box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25), 0 0 0 3px var(--everframe-ring); }
.everframe-btn-secondary { border-color: var(--everframe-border); color: var(--everframe-text); }
.everframe-btn-secondary:hover:not(:disabled) { background: var(--everframe-row-hover); }
.everframe-btn-outline-destructive { border-color: var(--everframe-destructive-border); color: var(--everframe-destructive); background: transparent; }
.everframe-btn-outline-destructive:hover:not(:disabled) { background: var(--everframe-destructive-hover-bg); }
.everframe-btn-outline-destructive:focus-visible { box-shadow: 0 0 0 3px var(--everframe-destructive-ring); }
.everframe-btn-icon { width: 32px; height: 32px; padding: 0; justify-content: center; }
.everframe-btn-sm { height: 32px; padding: 0 var(--everframe-space-sm); }
@media (pointer: coarse) { .everframe-btn { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .everframe-btn { transition: none; } }

/* Form fields */
.everframe-field { display: flex; flex-direction: column; gap: var(--everframe-space-xs); margin-bottom: var(--everframe-space-md); }
.everframe-field-label { font-size: var(--everframe-text-label); font-weight: var(--everframe-weight-medium); color: var(--everframe-text-muted); }
.everframe-input, .everframe-textarea {
  font: inherit; color: var(--everframe-text);
  background: rgba(13, 15, 19, 0.55); /* Bg inset well against the Bg2 surface */
  border: 1px solid var(--everframe-border); border-radius: var(--everframe-radius-md);
  padding: var(--everframe-space-sm) var(--everframe-space-md);
  width: 100%;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.everframe-input::placeholder, .everframe-textarea::placeholder { color: var(--everframe-text-faint); }
.everframe-input:focus-visible, .everframe-textarea:focus-visible {
  outline: 2px solid transparent; outline-offset: 2px;
  border-color: var(--everframe-border-focus);
  box-shadow: 0 0 0 3px var(--everframe-ring);
}
.everframe-input-error { border-color: var(--everframe-error); }
.everframe-input-error:focus-visible { border-color: var(--everframe-error); box-shadow: 0 0 0 3px var(--everframe-destructive-ring-soft); }
.everframe-helper-error { font-size: var(--everframe-text-label); color: var(--everframe-error); margin-top: var(--everframe-space-xs); }
.everframe-textarea { min-height: 72px; resize: vertical; }
@media (prefers-reduced-motion: reduce) { .everframe-input, .everframe-textarea { transition: none; } }

/* Switch (replaces verb-pair Toggle) — track + thumb */
.everframe-switch {
  position: relative;
  width: 36px; height: 20px; flex: 0 0 36px;
  border-radius: var(--everframe-radius-full);
  background: var(--everframe-border); border: none; padding: 0;
  cursor: pointer; transition: background 150ms ease;
}
.everframe-switch:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-switch:disabled { cursor: not-allowed; opacity: 0.7; }
.everframe-switch-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: var(--everframe-radius-full);
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  transition: transform 150ms ease;
}
.everframe-switch-on { background: var(--everframe-accent); }
.everframe-switch-on .everframe-switch-thumb { transform: translateX(16px); }
@media (prefers-reduced-motion: reduce) {
  .everframe-switch, .everframe-switch-thumb { transition: none; }
}

/* Toast — solid quiet surface with a status dot. Tinted-translucent chips are
 * illegible over arbitrary host pages; the toast floats outside the modal. */
.everframe-toast {
  position: fixed; top: 16px; right: 16px;
  padding: var(--everframe-space-sm) var(--everframe-space-md);
  border-radius: var(--everframe-radius-lg);
  max-width: 400px;
  z-index: var(--everframe-z-toast);
  display: inline-flex; align-items: center; gap: var(--everframe-space-sm);
  background: var(--everframe-bg-3); color: var(--everframe-text);
  border: 1px solid var(--everframe-border);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.28);
  animation: everframe-toast-in 200ms cubic-bezier(0.22, 1, 0.36, 1);
  cursor: pointer;
}
@keyframes everframe-toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .everframe-toast { animation: none; } }
.everframe-toast::before {
  content: ""; width: 8px; height: 8px; border-radius: var(--everframe-radius-full);
  flex: 0 0 auto; background: var(--everframe-text-faint);
}
.everframe-toast-success::before { background: var(--everframe-accent); }
.everframe-toast-warning::before { background: var(--everframe-accent-2); }
.everframe-toast-error::before { background: var(--everframe-destructive); }
.everframe-toast-info::before { background: var(--everframe-text-faint); }

/* Notice strip */
.everframe-notice { display: flex; align-items: flex-start; gap: var(--everframe-space-sm); padding: var(--everframe-space-sm) var(--everframe-space-md); border-radius: var(--everframe-radius-md); }
.everframe-notice-degraded { background: var(--everframe-status-degraded-bg); color: var(--everframe-status-degraded-fg); }
.everframe-notice-error { background: var(--everframe-destructive-bg-soft); color: var(--everframe-destructive); }

/* Capture stage (in-modal launcher for the fullscreen overlay) — a FIXED
 * height dotted canvas the screenshot floats on, like a design-tool
 * artboard. Fixed height keeps the modal geometry stable no matter which
 * screenshot is selected (portrait crop, landscape page, tiny area grab).
 * Annotation itself happens in the fullscreen editor. */
.everframe-annotate-thumb {
  position: relative; display: block; width: 100%; height: 240px;
  border: 1px solid rgba(241, 245, 252, 0.06); border-radius: 12px;
  background-color: var(--everframe-bg);
  background-image: radial-gradient(rgba(241, 245, 252, 0.07) 1px, transparent 1px);
  background-size: 14px 14px;
  padding: 0; cursor: pointer; overflow: hidden;
  margin-bottom: var(--everframe-space-md);
}
.everframe-annotate-thumb:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-annotate-thumb:hover .everframe-annotate-thumb-overlay { background: rgba(0,0,0,0.65); }
.everframe-annotate-thumb-img {
  position: absolute; inset: 14px;
  width: calc(100% - 28px); height: calc(100% - 28px);
  object-fit: contain;
  filter: drop-shadow(0 10px 28px rgba(0, 0, 0, 0.55));
}
/* Waiting state shares the stage geometry so capture completing doesn't
 * reflow the modal. */
.everframe-capture-pending {
  display: flex; align-items: center; justify-content: center;
  height: 240px; margin: 0 0 var(--everframe-space-md);
  border: 1px solid rgba(241, 245, 252, 0.06); border-radius: 12px;
  background-color: var(--everframe-bg);
  background-image: radial-gradient(rgba(241, 245, 252, 0.07) 1px, transparent 1px);
  background-size: 14px 14px;
  color: var(--everframe-text-muted); font-size: var(--everframe-text-label);
}
.everframe-annotate-thumb-overlay {
  position: absolute; inset: 0; display: inline-flex; align-items: center; justify-content: center;
  gap: var(--everframe-space-sm);
  background: rgba(0,0,0,0.45); color: #fff;
  font-size: var(--everframe-text-label); font-weight: var(--everframe-weight-semibold);
  opacity: 0; transition: opacity 150ms ease;
}
.everframe-annotate-thumb:hover .everframe-annotate-thumb-overlay,
.everframe-annotate-thumb:focus-visible .everframe-annotate-thumb-overlay { opacity: 1; }
@media (prefers-reduced-motion: reduce) { .everframe-annotate-thumb-overlay { transition: none; } }

/* Fullscreen annotate overlay — rendered inside .everframe-root, so tokens resolve.
 * Quiet-instrument treatment: flat Bg floor, sentence-case sans bar label
 * (mono-uppercase eyebrow retired with the admin restyle), amber Done, and a
 * neutral-shadow canvas frame instead of the old cyan glow. */
.everframe-annotate-overlay {
  position: fixed; inset: 0; z-index: var(--everframe-z-annotate-overlay);
  background: var(--everframe-bg); color: var(--everframe-text);
  display: flex; flex-direction: column;
}
.everframe-annotate-overlay-bar {
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  padding: 14px 14px 14px;
  padding-top: max(env(safe-area-inset-top, 0px), 14px);
}
.everframe-annotate-overlay-bar-left { justify-self: start; }
.everframe-annotate-overlay-bar-center {
  font-size: var(--everframe-text-label); font-weight: var(--everframe-weight-medium);
  color: var(--everframe-text-muted);
}
.everframe-annotate-overlay-bar-right { justify-self: end; }
.everframe-annotate-cancel {
  background: transparent; border: none; padding: 6px 0;
  color: var(--everframe-text-muted); font-size: 15px; font: inherit; cursor: pointer;
}
.everframe-annotate-cancel:hover { color: var(--everframe-text); }
.everframe-annotate-cancel:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--everframe-ring); border-radius: var(--everframe-radius-sm); }
.everframe-annotate-done {
  display: inline-flex; align-items: center;
  background: linear-gradient(180deg, var(--everframe-accent-grad-top) 0%, var(--everframe-accent-grad-bottom) 100%);
  color: var(--everframe-accent-fg); border: none;
  padding: 8px 16px; border-radius: 10px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.25);
  font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background 150ms ease;
}
.everframe-annotate-done:hover { background: linear-gradient(180deg, var(--everframe-accent-grad-top-hover) 0%, var(--everframe-accent-grad-bottom-hover) 100%); }
.everframe-annotate-done:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-annotate-overlay-stage {
  flex: 1 1 auto; min-height: 0;
  padding: 0 14px 22px;
  overflow: auto;
  display: flex; flex-direction: column; align-items: center;
  gap: 14px;
}
/* Canvas frame: white surface, hairline border, neutral ambient shadow —
 * the screenshot is the subject; the frame stays quiet. */
.everframe-annotate-canvas-frame {
  border-radius: var(--everframe-radius-lg);
  border: 1px solid var(--everframe-border);
  background: #FFFFFF;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28), 0 24px 48px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  display: flex; flex-direction: column; align-items: center;
}

/* Bottom palette bar — sits below the canvas. Bg3 surface, hairline border,
 * calm rounded-rect (the 22px pill went with the bento look). Active tool is
 * a solid amber chip with dark glyph. */
.everframe-annotation-toolbar {
  display: inline-flex; gap: 8px; padding: 10px 12px;
  background: rgba(29, 33, 38, 0.94); /* Bg3 alpha */
  border: 1px solid var(--everframe-border);
  border-radius: 12px;
  flex-wrap: wrap; justify-content: center; align-items: center;
}
.everframe-annotation-subtoolbar {
  display: inline-flex; gap: 8px; padding: 8px 12px;
  background: rgba(29, 33, 38, 0.94);
  border: 1px solid var(--everframe-border);
  border-radius: 10px;
  flex-wrap: wrap; justify-content: center; align-items: center;
}
.everframe-palette-sep {
  width: 1px; height: 20px; background: rgba(241, 245, 252, 0.1);
  flex: 0 0 auto;
}
.everframe-tool-btn {
  width: 36px; height: 36px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; color: var(--everframe-text);
  border: none; border-radius: var(--everframe-radius-full); cursor: pointer;
}
.everframe-tool-btn:hover { background: rgba(241, 245, 252, 0.06); }
.everframe-tool-btn:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-tool-btn:disabled { color: rgba(129, 134, 143, 0.5); cursor: not-allowed; }
.everframe-tool-btn:disabled:hover { background: transparent; }
.everframe-tool-btn-active { background: var(--everframe-accent); color: var(--everframe-accent-fg); }
.everframe-tool-btn-active:hover { background: var(--everframe-accent); }
.everframe-tool-glyph {
  display: inline-block; line-height: 1; font-size: 18px; font-weight: 500;
  font-feature-settings: "ss01" 0, "calt" 0;
}
.everframe-tool-clear {
  background: transparent; border: none; padding: 6px 10px;
  color: var(--everframe-destructive); font: inherit; font-size: 14px; cursor: pointer;
  border-radius: var(--everframe-radius-md);
}
.everframe-tool-clear:hover { background: var(--everframe-destructive-bg-soft); }
.everframe-tool-clear:focus-visible { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 3px var(--everframe-destructive-ring); }
.everframe-swatch {
  width: 28px; height: 28px; border-radius: var(--everframe-radius-full);
  border: 1px solid rgba(241, 245, 252, 0.18); cursor: pointer; padding: 0;
  flex: 0 0 auto;
}
/* Ink ring, not amber — an amber selection ring would collide with warm
 * swatch colors and misread as "this swatch is amber". */
.everframe-swatch-selected { outline: 2px solid var(--everframe-text); outline-offset: 1px; }
.everframe-thickness {
  min-width: 32px; height: 28px; padding: 0 var(--everframe-space-xs);
  border: 1px solid rgba(241, 245, 252, 0.18); border-radius: 6px;
  background: transparent; color: var(--everframe-text); cursor: pointer; font-size: 12px;
  flex: 0 0 auto;
}
.everframe-thickness-selected { outline: 2px solid var(--everframe-accent); outline-offset: 1px; }
@media (pointer: coarse) {
  .everframe-tool-btn { width: 44px; height: 44px; }
  .everframe-swatch { width: 32px; height: 32px; }
  .everframe-thickness { min-width: 36px; height: 32px; font-size: 13px; }
}

/* "Include in this report" section — single card with toggle rows, no
 * preview body. Mirrors Android IncludeCard.kt and iOS IncludeCard.
 * No expander, no chevron, no per-row preview: the count chip is the
 * only context the user needs; previews live in admin downstream. */
.everframe-include-label {
  display: block;
  font-family: var(--everframe-font-mono);
  font-size: 10.5px; letter-spacing: 1.5px; text-transform: uppercase;
  color: var(--everframe-text-faint); font-weight: 500;
  padding: 4px;
  margin-top: var(--everframe-space-md);
}
.everframe-include-card {
  background: rgba(29, 33, 38, 0.5); /* Bg3 alpha 0.5 */
  border: 1px solid var(--everframe-border);
  border-radius: var(--everframe-radius-lg);
  overflow: hidden;
}
.everframe-include-row {
  display: flex; align-items: center; gap: var(--everframe-space-sm);
  width: 100%;
  padding: 12px 14px;
  background: transparent;
  color: var(--everframe-text); text-align: left;
}
.everframe-include-row + .everframe-include-row { border-top: 1px solid var(--everframe-divider); }
.everframe-include-row-name {
  flex: 1 1 auto; font-size: 14.5px; font-weight: 500; color: var(--everframe-text);
}
.everframe-include-row-count {
  display: inline-flex; align-items: center;
  padding: 3px 8px; border-radius: var(--everframe-radius-full);
  background: rgba(13, 15, 19, 0.6);
  border: 1px solid var(--everframe-border);
  color: var(--everframe-text-faint);
  font-family: var(--everframe-font-mono); font-size: 11px;
  margin-right: 4px;
}
.everframe-canvas-loading { padding: var(--everframe-space-lg); color: var(--everframe-text-muted); font-size: var(--everframe-text-label); }

.everframe-text-editor {
  position: absolute;
  min-width: 80px;
  min-height: 1.4em;
  padding: 0;
  margin: 0;
  background: transparent;
  border: 1px dashed var(--everframe-accent);
  outline: none;
  resize: none;
  overflow: hidden;
  white-space: pre;
  z-index: 3;
}

.everframe-shot-strip {
  display: flex;
  gap: 8px;
  align-items: stretch;
  margin: 10px 0 4px;
  overflow-x: auto;
  padding: 2px;
}
.everframe-shot-thumb {
  position: relative;
  flex: 0 0 auto;
  border: 1px solid rgba(241, 245, 252, 0.1);
  border-radius: 10px;
  overflow: hidden;
}
.everframe-shot-thumb-active {
  border-color: var(--everframe-accent);
  box-shadow: 0 0 0 1px var(--everframe-accent);
}
.everframe-shot-thumb-btn {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  cursor: pointer;
  width: 84px;
  height: 56px;
}
.everframe-shot-thumb-btn:focus-visible { outline: 2px solid transparent; box-shadow: inset 0 0 0 2px var(--everframe-border-focus); }
.everframe-shot-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.everframe-shot-delete {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  line-height: 16px;
  border-radius: 50%;
  border: 0;
  background: rgba(13, 15, 19, 0.75);
  color: var(--everframe-text);
  cursor: pointer;
  font-size: 13px;
}
.everframe-shot-delete:hover { background: var(--everframe-destructive); }
.everframe-shot-delete:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 2px var(--everframe-ring); }
.everframe-shot-add {
  flex: 0 0 auto;
  width: 84px;
  height: 58px;
  border: 1px dashed rgba(241, 245, 252, 0.16);
  border-radius: 10px;
  background: none;
  color: var(--everframe-text-faint);
  cursor: pointer;
  font-size: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
.everframe-shot-add:hover:not(:disabled) { border-color: var(--everframe-border-focus); color: var(--everframe-accent); }
.everframe-shot-add:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-shot-add:disabled { opacity: 0.5; cursor: default; }
.everframe-shot-add-label { font-size: 11px; }

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
.everframe-area-capture {
  position: fixed;
  inset: 0;
  z-index: 2147483600;
  cursor: crosshair;
  background: rgba(13, 15, 19, 0.35);
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.everframe-area-capture-bar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: center;
  background: var(--everframe-surface);
  border: 1px solid var(--everframe-border);
  border-radius: var(--everframe-radius-lg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.4);
  padding: 8px 12px;
  cursor: default;
}
.everframe-area-capture-hint { color: var(--everframe-text-muted); font-size: 12px; }
.everframe-area-capture-btn {
  border: 1px solid var(--everframe-border);
  background: var(--everframe-bg-2);
  color: var(--everframe-text);
  border-radius: var(--everframe-radius-md);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.everframe-area-capture-btn:hover { border-color: var(--everframe-border-focus); }
.everframe-area-capture-btn:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-area-capture-selection {
  position: absolute;
  border: 1.5px dashed var(--everframe-accent);
  /* The huge shadow re-dims everything OUTSIDE the selection while the
     selection itself shows the page at full brightness. */
  box-shadow: 0 0 0 100vmax rgba(13, 15, 19, 0.5);
  pointer-events: none;
}
.everframe-area-capture-size {
  position: absolute;
  right: 0;
  bottom: -22px;
  background: var(--everframe-surface);
  color: var(--everframe-text);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--everframe-border);
}

/* Reporter FAB — the feature's entire ambient footprint: a small floating
 * button with an unread dot. Sits BELOW the backdrop z-index so any open
 * modal covers it. */
.everframe-fab-wrap { position: fixed; right: 16px; bottom: 16px; z-index: var(--everframe-z-fab); }
.everframe-fab {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; border-radius: var(--everframe-radius-full);
  background: var(--everframe-accent); color: var(--everframe-accent-fg);
  border: 1px solid var(--everframe-border); cursor: pointer; position: relative;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.everframe-fab:focus-visible { outline: 2px solid var(--everframe-ring); outline-offset: 2px; }
.everframe-fab-dot {
  position: absolute; top: -2px; right: -2px; width: 12px; height: 12px;
  border-radius: var(--everframe-radius-full); background: var(--everframe-destructive);
  border: 2px solid var(--everframe-bg);
}

/* Inbox — "Your reports" thread list (Task 10) + thread detail (Task 11).
 * Rows are plain buttons (full-width, left-aligned) so the whole row is one
 * hit target and the list stays keyboard-navigable without extra tabindex
 * plumbing. */
.everframe-inbox-list { display: flex; flex-direction: column; list-style: none; margin: 0; padding: 0; }
.everframe-inbox-list > li { margin: 0; padding: 0; }
.everframe-inbox-list > li + li { border-top: 1px solid var(--everframe-divider); }
.everframe-inbox-row {
  display: flex; align-items: center; gap: var(--everframe-space-sm);
  width: 100%;
  padding: 12px 4px;
  background: transparent; border: none;
  color: var(--everframe-text); text-align: left;
  font-family: inherit; font-size: var(--everframe-text-body);
  cursor: pointer;
}
.everframe-inbox-row:hover { background: var(--everframe-bg-2); }
.everframe-inbox-row:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--everframe-ring); }
.everframe-inbox-row-title {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  font-weight: var(--everframe-weight-medium);
}
.everframe-inbox-chip {
  flex: 0 0 auto;
  display: inline-flex; align-items: center;
  padding: 3px 8px; border-radius: var(--everframe-radius-full);
  font-size: 11px; font-weight: var(--everframe-weight-medium);
}
.everframe-inbox-chip-open { background: var(--everframe-status-success-bg); color: var(--everframe-status-success-fg); }
.everframe-inbox-chip-closed { background: var(--everframe-status-info-bg); color: var(--everframe-status-info-fg); }
.everframe-inbox-unread-dot {
  flex: 0 0 auto; width: 8px; height: 8px;
  border-radius: var(--everframe-radius-full); background: var(--everframe-accent);
}
.everframe-inbox-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--everframe-space-md);
  padding: var(--everframe-space-xl);
  text-align: center;
  color: var(--everframe-text-muted);
}
.everframe-inbox-loading { padding: var(--everframe-space-lg); color: var(--everframe-text-muted); font-size: var(--everframe-text-label); }

/* Inbox — thread detail (Task 11): messages + composer + optimistic states. */
.everframe-inbox-thread { display: flex; flex-direction: column; gap: var(--everframe-space-md); }
.everframe-inbox-back {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: var(--everframe-space-xs);
  background: transparent; border: none; cursor: pointer;
  color: var(--everframe-text-muted); font-family: inherit; font-size: var(--everframe-text-label);
  padding: 2px 0;
}
.everframe-inbox-back:hover { color: var(--everframe-text); }
.everframe-inbox-back:focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px var(--everframe-ring); border-radius: var(--everframe-radius-sm); }
.everframe-inbox-truncated-notice {
  margin: 0; padding-bottom: var(--everframe-space-xs);
  text-align: center; color: var(--everframe-text-faint); font-size: var(--everframe-text-label);
}
.everframe-inbox-msgs {
  display: flex; flex-direction: column; gap: var(--everframe-space-sm);
  overflow-y: auto;
  min-height: 160px; max-height: 360px;
  padding: 2px;
}
.everframe-inbox-msg {
  max-width: 80%;
  padding: var(--everframe-space-sm) var(--everframe-space-md);
  border-radius: var(--everframe-radius-lg);
  display: flex; flex-direction: column; gap: 2px;
}
.everframe-inbox-msg-theirs { align-self: flex-start; background: var(--everframe-bg-2); }
/* Accent tint (--everframe-accent-bg-soft), same family as --everframe-ring/--everframe-status-success-bg. */
.everframe-inbox-msg-mine { align-self: flex-end; background: var(--everframe-accent-bg-soft); }
.everframe-inbox-msg-author { font-size: 12px; font-weight: var(--everframe-weight-medium); color: var(--everframe-text-muted); }
.everframe-inbox-msg-body {
  margin: 0; font-size: var(--everframe-text-body); line-height: var(--everframe-leading-body);
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.everframe-inbox-msg-time { font-size: 11px; color: var(--everframe-text-faint); }
.everframe-inbox-pending { opacity: 0.75; }
.everframe-inbox-composer {
  display: flex; flex-direction: column; gap: var(--everframe-space-sm);
  border-top: 1px solid var(--everframe-divider); padding-top: var(--everframe-space-md);
}
.everframe-inbox-composer > .everframe-btn { align-self: flex-end; }
.everframe-inbox-cooldown { margin: 0; font-size: var(--everframe-text-label); color: var(--everframe-status-warning-fg); }
.everframe-inbox-closed-notice {
  margin: 0; padding: var(--everframe-space-md) 0; text-align: center;
  border-top: 1px solid var(--everframe-divider);
  color: var(--everframe-text-muted); font-size: var(--everframe-text-label);
}
.everframe-inbox-delete-error { margin: 0; font-size: var(--everframe-text-label); color: var(--everframe-error); }
.everframe-inbox-thread-actions {
  display: flex; justify-content: space-between; gap: var(--everframe-space-sm);
  padding-top: var(--everframe-space-sm);
}
` as const;

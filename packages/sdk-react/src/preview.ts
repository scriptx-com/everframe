// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `@traceitx/react/preview` — INTERNAL subpath entry for the TraceItX admin
// dashboard's branding editor (spec follow-on to 2026-08-25). It re-exports
// the REAL reporter dialog, its injected stylesheet, and the branding
// resolver so the dashboard's live preview can never drift from the shipped
// widget: same component, same CSS string, same `--txx-*` resolution.
//
// NOT part of the supported public SDK API — no semver guarantees. The root
// `@traceitx/react` surface stays the integration contract; this entry
// exists so the admin app (a workspace sibling) doesn't reach into src/
// paths or duplicate the dialog as a hand-built mock that rots.
//
// Ships as its own tsup entry (dist/preview.js) — see tsup.config.ts: the
// exports map may only reference files that exist in the published tarball
// (`files: ["dist"]`), so a src/-pointing subpath is not an option.
export { ReporterDialog } from '@traceitx/web/ui';
export type { ReporterDialogProps, ReporterCompletePayload } from '@traceitx/web/ui';
export { REPORTER_CSS } from '@traceitx/web';
export { resolveThemeVars, mixHex, hexToRgba } from '@traceitx/web';
// The server-config box setter: the preview host drives this with a synthetic
// `{ watermark, theme }` block so a mounted ReporterDialog re-themes itself
// through the SAME useSyncExternalStore → resolveThemeVars path production
// uses (Modal.tsx reads the box, not props — passing vars around it would
// bypass the mechanism the preview exists to exercise).
export { __setBrandingServerConfig } from '@traceitx/web';
export type { ReporterTheme } from '@traceitx/web';
export type { BrandingServerConfig } from '@traceitx/sdk-core';
export type { WebPlatformAdapter } from '@traceitx/web';

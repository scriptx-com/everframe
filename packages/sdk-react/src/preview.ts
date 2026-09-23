// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// `@everframe/react/preview` — INTERNAL subpath entry for the Everframe admin
// dashboard's branding editor (spec follow-on to 2026-08-25). It re-exports
// the REAL reporter dialog, its injected stylesheet, and the branding
// resolver so the dashboard's live preview can never drift from the shipped
// widget: same component, same CSS string, same `--everframe-*` resolution.
//
// NOT part of the supported public SDK API — no semver guarantees. The root
// `@everframe/react` surface stays the integration contract; this entry
// exists so the admin app (a workspace sibling) doesn't reach into src/
// paths or duplicate the dialog as a hand-built mock that rots.
//
// Ships as its own tsup entry (dist/preview.js) — see tsup.config.ts: the
// exports map may only reference files that exist in the published tarball
// (`files: ["dist"]`), so a src/-pointing subpath is not an option.
export { ReporterDialog } from '@everframe/web/ui';
export type { ReporterDialogProps, ReporterCompletePayload } from '@everframe/web/ui';
export { REPORTER_CSS } from '@everframe/web';
export { resolveThemeVars, mixHex, hexToRgba } from '@everframe/web';
// The server-config box setter: the preview host drives this with a synthetic
// `{ watermark, theme }` block so a mounted ReporterDialog re-themes itself
// through the SAME useSyncExternalStore → resolveThemeVars path production
// uses (Modal.tsx reads the box, not props — passing vars around it would
// bypass the mechanism the preview exists to exercise).
export { __setBrandingServerConfig } from '@everframe/web';
export type { ReporterTheme } from '@everframe/web';
export type { BrandingServerConfig } from '@everframe/sdk-core';
export type { WebPlatformAdapter } from '@everframe/web';

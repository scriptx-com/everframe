// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// React entry. Imported by @everframe/react (which supplies its host's React)
// and by this package's own lazy island. NEVER import this from src/index.ts —
// that would drag React into the always-loaded graph.
//
// Built by its OWN tsup config (see tsup.config.ts's second array element)
// with react/react-dom marked `external`, while the vanilla `src/index.ts`
// build bundles React outright. One source of truth, two builds: a React host
// must never end up with a second React runtime, and a Vue / plain-HTML host
// must never have to install one.
'use client';

export { ReporterDialog } from './reporter-ui/ReporterDialog.js';
export type {
  ReporterCompletePayload,
  ReporterDialogProps,
} from './reporter-ui/ReporterDialog.js';
export { ReporterFab } from './reporter-ui/ReporterFab.js';
export { CompanionBadge } from './reporter-ui/CompanionBadge.js';
export { CompanionPinCard } from './reporter-ui/CompanionPinCard.js';
export { InboxDialog } from './reporter-ui/inbox/InboxDialog.js';
export { Toast } from './reporter-ui/primitives/Toast.js';
export type { ToastTone } from './reporter-ui/primitives/Toast.js';
// NOTE: the portal-target and theme-host seams are deliberately NOT re-exported
// here. `init()` and the dialog primitives reach those modules by relative path
// inside this package, and `@everframe/react` never touches them — exporting
// them only widened `dist/ui.d.ts`'s published surface with two module-level
// singletons no consumer can usefully drive.

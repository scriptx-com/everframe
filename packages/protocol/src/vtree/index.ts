// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// vtree namespace barrel — re-exports the VTreeTimeline schema plus VNode, the
// VOp discriminated union, and each VOp branch so consumers can both validate a
// full timeline and narrow against a specific op (e.g. `vtree.VOpAdd.parse(...)`).
export {
  VRole,
  VAsset,
  VNode,
  VOpSet,
  VOpAdd,
  VOpRemove,
  VOp,
  VFrame,
  VTreeTimeline,
} from './timeline.js';
